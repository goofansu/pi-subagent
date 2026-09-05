import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { backendId } from "../domain/index.ts";
import {
  FIXTURE_NOW,
  fixtureRow,
  fixtureUsage,
} from "../testing/presentation-fixtures.ts";
import {
  formatRowSummary,
  formatRunRow,
  MAX_AGENT_COLUMN_WIDTH,
  MIN_ACTIVITY_WIDTH,
  MIN_LABEL_WIDTH,
  MIN_TAIL_WIDTH,
  measureColumns,
  orderRows,
  type RenderableTheme,
  ROW_DELIMITER,
  renderRunRows,
  rowBackground,
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
    formatRunRow(fixtureRow(overrides), theme, width, FIXTURE_NOW),
  ).trimEnd();
}

/** The same row drawn at a chosen instant, which is what a redraw is. */
function rowAt(now: number, overrides = {}): string {
  return stripVTControlCharacters(
    formatRunRow(fixtureRow(overrides), theme, 120, now),
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

test("a live row reads the same at any instant, because nothing on it is a clock", () => {
  // The widget redraws only on a change, so a row that depended on the
  // instant it was drawn at would be stale between changes.
  const later = FIXTURE_NOW + 61_000;
  assert.equal(rowAt(later), rowAt(FIXTURE_NOW));
  assert.equal(
    rowAt(later, { phase: "finalizing" }),
    rowAt(FIXTURE_NOW, { phase: "finalizing" }),
  );
});

test("a settled row says what the Run took, and drops its turn count", () => {
  assert.equal(
    row(120, { phase: "completed" }),
    "explore  pi  completed in 12.4s",
  );
  assert.equal(
    row(120, { phase: "failed" }),
    "explore  pi  failed after 12.4s",
  );
  assert.equal(
    row(120, { phase: "cancelled" }),
    "explore  pi  cancelled after 12.4s",
  );
  assert.equal(
    row(120, { phase: "finalizing" }),
    "explore  pi  finalizing  3 turns  look around",
  );
});

test("a settled row's duration is the Run's cost, so a later draw reads the same", () => {
  // A settled row stays on screen until the Run's completion notice lands, so
  // being drawn later is the ordinary case rather than a corner of one. The
  // figure is what the Run cost, and a cost does not depend on when it is
  // read: the row a minute later is the row, character for character.
  const later = FIXTURE_NOW + 60_000;
  for (const phase of ["completed", "failed", "cancelled"] as const) {
    assert.equal(rowAt(later, { phase }), rowAt(FIXTURE_NOW, { phase }));
  }
  assert.match(rowAt(later, { phase: "completed" }), /completed in 12\.4s/);
});

test("a running Run whose cancellation is recorded says it is cancelling", () => {
  // The reader who asked for the cancellation is watching for it to take, and
  // `running` would tell them nothing had happened.
  assert.equal(
    row(120, { cancellation: { reason: "requested" } }),
    "explore  pi  cancelling  3 turns  look around",
  );
  // A settled Run's phase is the fact; a cancellation recorded on the way
  // there is not what its row says.
  assert.equal(
    row(120, { phase: "completed", cancellation: { reason: "requested" } }),
    "explore  pi  completed in 12.4s",
  );
});

test("a settled row shows no tail even if an activity is still on the snapshot", () => {
  // The turn count goes with it; a settled row is status and nothing else.
  assert.equal(
    row(120, { phase: "failed", activity: "bash: npm test" }),
    "explore  pi  failed after 12.4s",
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
    FIXTURE_NOW,
  );
  assert.ok(
    line.endsWith(
      paint("dim", "look around · ") + paint("muted", italic("bash: npm test")),
    ),
  );
  // The label alone is not italic: only the part that moves looks like it.
  assert.ok(
    formatRunRow(fixtureRow(), named, 120, FIXTURE_NOW).endsWith(
      paint("dim", "look around"),
    ),
  );
});

test("the status is painted in the phase's tone, and nothing precedes the agent", () => {
  const live = formatRunRow(fixtureRow(), named, 120, FIXTURE_NOW);
  assert.match(live, painted("warning", "running"));
  assert.ok(live.startsWith(paint("toolTitle", bold("explore"))));

  const settled = formatRunRow(
    fixtureRow({ phase: "completed" }),
    named,
    120,
    FIXTURE_NOW,
  );
  assert.match(settled, painted("success", "completed in 12.4s"));
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
  const at = (width: number) => measureColumns(rows, FIXTURE_NOW, width);

  // The fixed part with the turn count is 7+2+2+2+7+2+7 = 29 cells. The
  // turn count is kept whenever that fits, whatever it leaves the tail.
  assert.ok(at(29).turns > 0);
  assert.equal(at(28).turns, 0);
  assert.ok(at(28).status > 0);

  // A settled row has no turn count at all: the count is a live row's sign
  // of life, and means nothing once nothing is moving.
  const settled = [fixtureRow({ phase: "completed" })];
  assert.equal(measureColumns(settled, FIXTURE_NOW, 120).turns, 0);

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

// ── Ordering and the whole widget ────────────────────────────────────────────

test("running Runs come before finalizing ones, each group newest last", () => {
  const running = fixtureRow({ identity: { agent: "one" } });
  const finalizing = fixtureRow({
    phase: "finalizing",
    identity: { agent: "two" },
  });
  const alsoRunning = fixtureRow({ identity: { agent: "three" } });

  assert.deepEqual(
    orderRows([finalizing, running, alsoRunning]).map(
      (entry) => entry.identity.agent,
    ),
    ["one", "three", "two"],
  );
});

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

test("the whole widget is a title line, aligned rows, and an overflow summary", () => {
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({
      identity: { agent: "reviewer", description: "read the diff" },
      usage: fixtureUsage({ turns: 1 }),
    }),
  ];

  const lines = renderRunRows(rows, theme, 80, FIXTURE_NOW).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.deepEqual(lines, [
    " subagents   2 running",
    " explore   pi  running  3 turns  look around",
    " reviewer  pi  running  1 turn   read the diff",
  ]);
});

test("a settled row's phrase does not widen the status column the live rows share", () => {
  // `completed in 12.4s` is much wider than `running`. Sized to it, every
  // live row's turn count would sit a dozen cells right of its status word.
  // The column is sized to the live rows, and the phrase overflows it: a
  // settled row has nothing after its status to keep aligned.
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({ identity: { agent: "reviewer" }, phase: "completed" }),
  ];
  const lines = renderRunRows(rows, theme, 80, FIXTURE_NOW).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );
  assert.deepEqual(lines, [
    " subagents   1 running   1 completed",
    " explore   pi  running  3 turns  look around",
    " reviewer  pi  completed in 12.4s",
  ]);
  // Two live rows with different status words still align on the wider one.
  const mixedLive = renderRunRows(
    [fixtureRow(), fixtureRow({ phase: "finalizing" })],
    theme,
    80,
    FIXTURE_NOW,
  ).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.equal(mixedLive[1], " explore  pi  running     3 turns  look around");
  assert.equal(mixedLive[2], " explore  pi  finalizing  3 turns  look around");
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
  const [header = ""] = renderRunRows(rows, named, 100, FIXTURE_NOW);
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
    renderRunRows(rows, theme, 100, FIXTURE_NOW)[0] ?? "",
  );
  assert.equal(plain, " subagents   1 running   1 failed ");
  assert.doesNotMatch(plain, /tokens|\$/);
});

test("the header shortens rather than wraps on a narrow terminal", () => {
  const rows = [fixtureRow(), fixtureRow({ phase: "failed" })];
  const at = (width: number) =>
    stripVTControlCharacters(
      renderRunRows(rows, theme, width, FIXTURE_NOW)[0] ?? "",
    );
  assert.equal(at(40), " subagents   1 running   1 failed ");
  assert.ok(visibleWidth(at(20)) <= 20);
  assert.match(at(20), /^ subagents/);
});

test("the widget caps its rows and says how many it is not showing", () => {
  const rows = Array.from({ length: 10 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );

  const lines = renderRunRows(rows, theme, 80, FIXTURE_NOW, 3).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.equal(lines.length, 5);
  assert.equal(lines.at(-1), "   … and 7 more");
});

test("an empty list renders nothing at all", () => {
  assert.deepEqual(renderRunRows([], theme, 80, FIXTURE_NOW), []);
});

// ── Bands ────────────────────────────────────────────────────────────────────

test("each row is painted as a band in the background Pi gives its own tool calls", () => {
  const rows = [
    fixtureRow({ identity: { agent: "live" } }),
    fixtureRow({ identity: { agent: "done" }, phase: "completed" }),
    fixtureRow({ identity: { agent: "broke" }, phase: "failed" }),
    fixtureRow({ identity: { agent: "stopped" }, phase: "cancelled" }),
  ];
  const [, live = "", done = "", broke = "", stopped = ""] = renderRunRows(
    rows,
    named,
    60,
    FIXTURE_NOW,
  );
  assert.ok(live.startsWith("\u001b[44m"), "a live row is pending");
  assert.ok(done.startsWith("\u001b[42m"), "a completed row is success");
  assert.ok(broke.startsWith("\u001b[41m"), "a failed row is error");
  assert.ok(stopped.startsWith("\u001b[41m"), "a cancelled row is error");
  // Edge to edge: the band is padded to the width and closed at its end.
  for (const line of [live, done, broke, stopped]) {
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
  const [, line = ""] = renderRunRows(rows, named, 60, FIXTURE_NOW);
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
  const [, line = ""] = renderRunRows(rows, named, 60, FIXTURE_NOW);
  const plain = stripVTControlCharacters(line);
  assert.equal(visibleWidth(plain), 60);
  assert.match(plain, /^ \S/);
  assert.match(plain, /\S $/);
});

test("W-2: a stuck row is painted as the failure it reports, whatever its phase", () => {
  assert.equal(
    rowBackground(fixtureRow({ phase: "completed", handoff: "exhausted" })),
    "toolErrorBg",
  );
  assert.equal(
    rowBackground(fixtureRow({ phase: "completed" })),
    "toolSuccessBg",
  );
  assert.equal(rowBackground(fixtureRow()), "toolPendingBg");
  assert.equal(
    rowBackground(fixtureRow({ phase: "finalizing" })),
    "toolPendingBg",
  );
});

test("the header and the overflow line are not bands", () => {
  const rows = Array.from({ length: 4 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );
  const lines = renderRunRows(rows, named, 60, FIXTURE_NOW, 2);
  const bands = ["\u001b[44m", "\u001b[42m", "\u001b[41m"];
  for (const band of bands) {
    assert.ok(!(lines[0] ?? "").includes(band), "the header is painted");
    assert.ok(!(lines.at(-1) ?? "").includes(band), "the overflow is painted");
  }
});

// ── W-2: the row that will never leave on its own ───────────────────────────

test("W-2: a row whose notice will never arrive says so, with the id and the result", () => {
  // A settled row's only exits are a landing and a retrieval, and an exhausted
  // hand-off will never get the first. So the row explains itself, and gives
  // the two facts a reader needs to take the second: which Run it is and that
  // the answer is there regardless.
  assert.equal(
    row(120, { phase: "completed", handoff: "exhausted" }),
    "explore  pi  completed in 12.4s  notification failed · run-1 · result available",
  );
});

test("W-2: the stuck row is painted in the error colour, and only that row", () => {
  const stuck = formatRunRow(
    fixtureRow({ phase: "completed", handoff: "exhausted" }),
    named,
    120,
    FIXTURE_NOW,
  );
  assert.match(stuck, painted("error", "completed in 12.4s"));
  assert.ok(
    stuck.endsWith(
      paint("error", "notification failed · run-1 · result available"),
    ),
  );
  // W-1 stands for every other settled row: the figure is the Run's, and the
  // row is painted as the phase says.
  assert.match(
    formatRunRow(fixtureRow({ phase: "completed" }), named, 120, FIXTURE_NOW),
    painted("success", "completed in 12.4s"),
  );
});

test("W-2: an exhausted failed Run keeps its own verb", () => {
  assert.equal(
    row(120, { phase: "failed", handoff: "exhausted" }),
    "explore  pi  failed after 12.4s  notification failed · run-1 · result available",
  );
});

test("W-2: the explanation is fitted like any tail, and goes when there is no room", () => {
  assert.equal(
    row(60, { phase: "completed", handoff: "exhausted" }),
    "explore  pi  completed in 12.4s  notification failed · run-…",
  );
  // Still a stuck row: the error colour and the band say so.
  assert.equal(
    row(43, { phase: "completed", handoff: "exhausted" }),
    "explore  pi  completed in 12.4s",
  );
});
