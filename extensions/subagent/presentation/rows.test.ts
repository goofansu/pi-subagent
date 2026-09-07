import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { backendId } from "../domain/index.ts";
import { fixtureRow, fixtureUsage } from "../testing/presentation-fixtures.ts";
import {
  formatRowSummary,
  formatRunRow,
  MAX_AGENT_COLUMN_WIDTH,
  MIN_ACTIVITY_WIDTH,
  MIN_LABEL_WIDTH,
  MIN_TAIL_WIDTH,
  measureColumns,
  type RenderableTheme,
  ROW_DELIMITER,
  renderRunRows,
} from "./rows.ts";

/** A theme that paints nothing, so a golden test reads the text itself. */
const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};

/**
 * A theme that paints each colour as its own SGR code, for the tests about
 * paint. Real escape sequences rather than readable tags, because the
 * renderer measures what it draws and a tag would take up columns.
 */
const SGR: Record<string, number> = {
  dim: 2,
  muted: 90,
  text: 37,
  warning: 33,
  error: 31,
  success: 32,
  accent: 36,
  toolTitle: 35,
  borderMuted: 34,
};
const BG: Record<string, number> = {
  toolPendingBg: 44,
  toolSuccessBg: 42,
  toolErrorBg: 41,
};
const paint = (color: string, text: string): string =>
  `\u001b[${SGR[color] ?? 39}m${text}\u001b[0m`;
/** A background the way Pi's theme paints one: set, text, reset background only. */
const paintBg = (color: string, text: string): string =>
  `\u001b[${BG[color] ?? 49}m${text}\u001b[49m`;
const bold = (text: string): string => `\u001b[1m${text}\u001b[22m`;
const italic = (text: string): string => `\u001b[3m${text}\u001b[23m`;
const inverse = (text: string): string => `\u001b[7m${text}\u001b[27m`;
const named: RenderableTheme = {
  fg: paint,
  bg: paintBg,
  bold,
  italic,
  inverse,
};
const literal = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A regular expression matching `text` painted in `color`. */
const painted = (color: string, text: string): RegExp =>
  new RegExp(literal(paint(color, text)));

function row(width: number, overrides = {}): string {
  return stripVTControlCharacters(
    formatRunRow(fixtureRow(overrides), theme, width),
  ).trimEnd();
}

// ── One row ──────────────────────────────────────────────────────────────────

test("a live row reads agent, backend, status, turns, then the label", () => {
  const line = row(120);

  assert.equal(ROW_DELIMITER, "  ");
  assert.equal(line, "explore  pi  running  3 turns  look around");
  // No spinner and no clock: the turn count moving is the sign of life.
  assert.doesNotMatch(line, /\d\.\ds/);
  // The Run id and the model are deliberately absent: ids belong to tool
  // results and notices, where the model that acts on them reads them.
  assert.doesNotMatch(line, /run-1/);
  assert.doesNotMatch(line, /subagent-1/);
});

test("a row names each backend the same way", () => {
  // The active widget row is backend-independent apart from the backend's own
  // name, so an unfamiliar name formats exactly like a familiar one.
  assert.deepEqual(
    ["pi", "claude", "demo-one-shot"].map((backend) =>
      row(120, { identity: { backendId: backendId(backend) } }),
    ),
    [
      "explore  pi  running  3 turns  look around",
      "explore  claude  running  3 turns  look around",
      "explore  demo-one-shot  running  3 turns  look around",
    ],
  );
});

test("a finalizing row retains its label but not executing activity", () => {
  assert.equal(
    row(120, { phase: "finalizing", activity: "bash: npm test" }),
    "explore  pi  finalizing  3 turns  look around",
  );
});

test("a running Run whose cancellation is recorded says it is cancelling", () => {
  // The reader who asked for the cancellation is watching for it to take, and
  // `running` would tell them nothing had happened.
  assert.equal(
    row(120, { cancellation: { reason: "requested" } }),
    "explore  pi  cancelling  3 turns  look around",
  );
});

test("a Run with no turns yet reads as a dash rather than a zero", () => {
  assert.equal(
    row(120, { usage: fixtureUsage({ turns: 0 }) }),
    "explore  pi  running  —  look around",
  );
});

test("a row shows no tool count and no context gauge, whatever the snapshot carries", () => {
  // Both were tried and neither told an operator anything they acted on.
  const line = row(120, {
    tools: 4,
    usage: fixtureUsage({
      turns: 3,
      context: { tokens: 84_000, window: 200_000 },
    }),
  });
  assert.equal(line, "explore  pi  running  3 turns  look around");
  assert.doesNotMatch(line, /tool|%|▰/);
});

// ── The tail ─────────────────────────────────────────────────────────────────

test("reported activity joins the label in the tail", () => {
  assert.equal(
    row(120, { activity: "bash: npm test" }),
    "explore  pi  running  3 turns  look around · bash: npm test",
  );
});

test("the label outranks the activity: it is shortened for the activity, never dropped", () => {
  // Room for the label to be cut and still leave MIN_LABEL_WIDTH: the activity
  // stays and the label gives up its end.
  assert.equal(MIN_LABEL_WIDTH, 24);
  assert.equal(
    row(64, {
      identity: { description: "a long label that goes on and on and on" },
      activity: "read",
    }),
    "explore  pi  running  3 turns  a long label that goes on… · read",
  );
  // An activity too long to leave that much label is the one shortened, so
  // the row still says what kind of thing the Run is doing.
  assert.equal(MIN_ACTIVITY_WIDTH, 12);
  assert.equal(
    row(70, {
      identity: { description: "a long label that goes on and on and on" },
      activity: "a very long activity name here",
    }),
    "explore  pi  running  3 turns  a long label that goes … · a very long…",
  );
  // A short label is kept whole rather than cut below its own length.
  assert.equal(
    row(58, { activity: "bash: npm test" }),
    "explore  pi  running  3 turns  look around · bash: npm te…",
  );
  // Below MIN_ACTIVITY_WIDTH the activity goes and the label takes the room.
  // A row that said only `read` would not say which Run was reading.
  assert.equal(
    row(56, { activity: "bash: npm test" }),
    "explore  pi  running  3 turns  look around",
  );
});

test("the tail is skipped altogether when there is not room to read it", () => {
  assert.equal(MIN_TAIL_WIDTH, 12);
  // The fixed part is 29 cells; a tail needs a delimiter and 12 more.
  assert.match(row(29 + 2 + 12), /look around$/);
  assert.equal(row(29 + 2 + 11), "explore  pi  running  3 turns");
});

test("the label and the activity are painted apart: the activity brighter and in italics", () => {
  const line = formatRunRow(
    fixtureRow({ activity: "bash: npm test" }),
    named,
    120,
  );
  assert.ok(
    line.endsWith(
      paint("dim", "look around") +
        paint("dim", " · ") +
        paint("muted", italic("bash: npm test")),
    ),
  );
  // The label alone is not italic: only the part that moves looks like it.
  assert.ok(
    formatRunRow(fixtureRow(), named, 120).endsWith(
      paint("dim", "look around"),
    ),
  );
});

test("an ellipsis-shortened label keeps its separator dim", () => {
  const line = formatRunRow(
    fixtureRow({
      identity: { description: "a long label that goes on and on and on" },
      activity: "read",
    }),
    named,
    64,
  );

  assert.match(stripVTControlCharacters(line), /… · read$/);
  assert.ok(
    line.includes(paint("dim", " · ") + paint("muted", italic("read"))),
  );
});

test("the status is painted in the phase's tone, and nothing precedes the agent", () => {
  const live = formatRunRow(fixtureRow(), named, 120);
  assert.match(live, painted("warning", "running"));
  assert.ok(live.startsWith(paint("toolTitle", bold("explore"))));
});

// ── Fitting ──────────────────────────────────────────────────────────────────

test("a row never exceeds the width it is given", () => {
  for (const width of [120, 80, 46, 30, 12]) {
    const line = row(width);
    assert.ok(
      visibleWidth(line) <= width,
      `width ${width} produced ${visibleWidth(line)} columns`,
    );
  }
});

test("fields give way from the right: activity, label, then turns; agent, backend, and status never", () => {
  const rows = [fixtureRow()];
  const at = (width: number) => measureColumns(rows, width);

  // The fixed part with the turn count is 7+2+2+2+7+2+7 = 29 cells. The
  // turn count is kept whenever that fits, whatever it leaves the tail.
  assert.ok(at(29).turns > 0);
  assert.equal(at(28).turns, 0);
  assert.ok(at(28).status > 0);

  const narrow = row(22);
  assert.doesNotMatch(narrow, /3 turns/);
  assert.doesNotMatch(narrow, /look around/);
  assert.equal(narrow, "explore  pi  running");
});

test("a long agent name is truncated without hiding later fields", () => {
  const line = row(80, {
    identity: { agent: "a-very-long-agent-profile-name" },
  });

  assert.equal(MAX_AGENT_COLUMN_WIDTH, 16);
  assert.match(line, /^a-very-long-age… {2}pi/);
  assert.match(line, /running/);
});

// ── Summary and the whole widget ─────────────────────────────────────────────

test("the widget summary counts each phase in the shared order", () => {
  assert.equal(
    formatRowSummary([
      fixtureRow({}),
      fixtureRow({ phase: "finalizing" }),
      fixtureRow({}),
    ]),
    "2 running, 1 finalizing",
  );
});

test("multiple active Runs show aggregate state without individual rows", () => {
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({
      identity: { agent: "reviewer", description: "read the diff" },
      usage: fixtureUsage({ turns: 1 }),
    }),
  ];

  const lines = renderRunRows(rows, theme, 80).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.deepEqual(lines, [" subagents   2 running"]);
});

test("unresolved terminal Runs contribute only summary beside one active Run", () => {
  // Neither the terminal Run's identity nor its duration affects active detail.
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({ identity: { agent: "reviewer" }, phase: "completed" }),
  ];
  const lines = renderRunRows(rows, theme, 80).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );
  assert.deepEqual(lines, [
    " subagents   1 running   1 completed",
    " explore  pi  running  3 turns  look around",
  ]);
  // Finalizing still counts as active, so a mixed pair has no detail rows.
  const mixedLive = renderRunRows(
    [fixtureRow(), fixtureRow({ phase: "finalizing" })],
    theme,
    80,
  ).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.deepEqual(mixedLive, [" subagents   1 running   1 finalizing"]);
});

test("the header is the name and one inverted chip per phase, and says nothing about spend", () => {
  const rows = [
    fixtureRow({
      usage: fixtureUsage({
        turns: 3,
        input: 9_000,
        output: 1_200,
        cost: 0.041,
      }),
    }),
    fixtureRow({ phase: "failed" }),
  ];
  const [header = ""] = renderRunRows(rows, named, 100);
  assert.equal(
    header,
    ` ${paint("accent", bold("subagents"))}  ${inverse(paint("warning", " 1 running "))} ${inverse(paint("error", " 1 failed "))}`,
  );
  // No rule: the editor's own border sits directly beneath the widget.
  assert.doesNotMatch(header, /─/);

  // No token total and no cost: the first left out cache reads, and the
  // second summed backends that report at different moments. Each notice
  // carries its own Run's accounting instead.
  const plain = stripVTControlCharacters(
    renderRunRows(rows, theme, 100)[0] ?? "",
  );
  assert.equal(plain, " subagents   1 running   1 failed ");
  assert.doesNotMatch(plain, /tokens|\$/);
});

test("the header shortens rather than wraps on a narrow terminal", () => {
  const rows = [fixtureRow(), fixtureRow({ phase: "failed" })];
  const at = (width: number) =>
    stripVTControlCharacters(renderRunRows(rows, theme, width)[0] ?? "");
  assert.equal(at(40), " subagents   1 running   1 failed ");
  assert.ok(visibleWidth(at(20)) <= 20);
  assert.match(at(20), /^ subagents/);
});

test("a large fan-out has no overflow list", () => {
  const rows = Array.from({ length: 10 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );

  const lines = renderRunRows(rows, theme, 80).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.deepEqual(lines, [" subagents   10 running"]);
});

test("summary separates cancellation, Run outcomes, and exceptional hand-off attention", () => {
  const rows = [
    fixtureRow({ cancellation: { reason: "requested" } }),
    fixtureRow({ phase: "finalizing" }),
    fixtureRow({ phase: "completed", handoff: "exhausted" }),
    fixtureRow({ phase: "completed", handoff: "unannounceable" }),
    fixtureRow({ phase: "failed" }),
    fixtureRow({ phase: "cancelled" }),
  ];
  const lines = renderRunRows(rows, theme, 240);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 cancelling/);
  assert.match(lines[0], /1 finalizing/);
  assert.match(lines[0], /2 completed/);
  assert.match(lines[0], /1 failed/);
  assert.match(lines[0], /1 cancelled/);
  assert.match(lines[0], /1 notification failed/);
  assert.match(lines[0], /1 no notification · result unavailable/);
  assert.doesNotMatch(lines[0], /running|explore|look around|turns/);
});

test("exceptional attention survives narrow summaries within terminal display width", () => {
  for (const handoff of ["exhausted", "unannounceable"] as const) {
    const rows = [
      ...Array.from({ length: 20 }, () => fixtureRow({ phase: "completed" })),
      fixtureRow({ phase: "completed", handoff }),
    ];
    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      const lines = renderRunRows(rows, named, width);
      assert.equal(lines.length, 1);
      assert.ok(visibleWidth(lines[0]) <= width, `width ${width}`);
      if (width > 0 && width <= 40) {
        assert.match(stripVTControlCharacters(lines[0]), /^!/);
      }
    }
  }
  const wideText = fixtureRow({
    identity: {
      agent: "探索探索探索探索探索探索",
      description: "界".repeat(80),
    },
    activity: "読む".repeat(40),
  });
  for (const width of [0, 1, 2, 8, 20, 80]) {
    for (const line of renderRunRows([wideText], named, width)) {
      assert.ok(visibleWidth(line) <= width, `single width ${width}`);
    }
  }
});

test("exceptional summaries keep chips at exact fit and switch to plain attention on overflow", () => {
  const cases = [
    {
      handoff: "exhausted" as const,
      width: 49,
      full: " subagents   1 completed   1 notification failed ",
      compact: "! 1 notification failed, 1 completed",
    },
    {
      handoff: "unannounceable" as const,
      width: 66,
      full: " subagents   1 completed   1 no notification · result unavailable ",
      compact: "! 1 no notification · result unavailable, 1 completed",
    },
  ];
  for (const { handoff, width, full, compact } of cases) {
    const rows = [fixtureRow({ phase: "completed", handoff })];
    for (const paintTheme of [theme, named]) {
      for (const fittingWidth of [width, width + 1]) {
        const [line] = renderRunRows(rows, paintTheme, fittingWidth);
        assert.equal(stripVTControlCharacters(line), full);
        if (paintTheme === named)
          assert.ok(line.includes("\u001b[7m"), "full header retains chips");
      }
      const [overflow] = renderRunRows(rows, paintTheme, width - 1);
      assert.equal(stripVTControlCharacters(overflow), compact);
      assert.ok(!overflow.includes("\u001b[7m"), "overflow drops chip framing");
      assert.ok(visibleWidth(overflow) <= width - 1);
    }
  }
});

test("an empty list renders nothing at all", () => {
  assert.deepEqual(renderRunRows([], theme, 80), []);
});

// ── Bands ────────────────────────────────────────────────────────────────────

test("only the active detail is painted as a band", () => {
  const rows = [
    fixtureRow({ identity: { agent: "live" } }),
    fixtureRow({ identity: { agent: "done" }, phase: "completed" }),
    fixtureRow({ identity: { agent: "broke" }, phase: "failed" }),
    fixtureRow({ identity: { agent: "stopped" }, phase: "cancelled" }),
  ];
  const lines = renderRunRows(rows, named, 60);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("\u001b[44m"), "a live row is pending");
  // Edge to edge: the band is padded to the width and closed at its end.
  for (const line of lines.slice(1)) {
    assert.equal(visibleWidth(line), 60);
    assert.ok(line.endsWith("\u001b[49m"));
  }
});

test("a band survives a full reset inside its text", () => {
  // Truncation leaves a full SGR reset behind, which would switch the
  // background off for the rest of the line. The band is painted around it.
  const rows = [
    fixtureRow({
      identity: {
        description:
          "a label long enough to be cut off by the width it is given",
      },
    }),
  ];
  const [, line = ""] = renderRunRows(rows, named, 60);
  assert.ok(line.includes("\u001b[0m\u001b[44m"));
  assert.equal(visibleWidth(line), 60);
  assert.ok(line.endsWith("\u001b[49m"));
});

test("a row leaves one clear column at its right edge, as at its left", () => {
  const rows = [
    fixtureRow({
      identity: {
        description:
          "a label long enough to be cut off by the width it is given",
      },
    }),
  ];
  const [, line = ""] = renderRunRows(rows, named, 60);
  const plain = stripVTControlCharacters(line);
  assert.equal(visibleWidth(plain), 60);
  assert.match(plain, /^ \S/);
  assert.match(plain, /\S $/);
});

test("the aggregate summary is not a band", () => {
  const rows = Array.from({ length: 4 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );
  const lines = renderRunRows(rows, named, 60);
  assert.equal(lines.length, 1, "there is no overflow line");
  const bands = ["\u001b[44m", "\u001b[42m", "\u001b[41m"];
  for (const band of bands) {
    assert.ok(!(lines[0] ?? "").includes(band), "the header is painted");
  }
});
