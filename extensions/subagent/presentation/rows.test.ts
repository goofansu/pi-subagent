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
  measureColumns,
  orderRows,
  type RenderableTheme,
  ROW_DELIMITER,
  renderRunRows,
  rowBackground,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
  TAIL_BUDGET,
} from "./rows.ts";

/** A theme that paints nothing, so a golden test reads the text itself. */
const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
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
const named: RenderableTheme = {
  fg: paint,
  bg: paintBg,
  bold,
  italic,
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

/** The frame the fixture instant lands on, so goldens can name it. */
const FRAME = spinnerFrame(FIXTURE_NOW);

// ── One row ──────────────────────────────────────────────────────────────────

test("a row reads glyph, agent, backend, status, duration, turns, then the label", () => {
  const line = row(120);

  assert.equal(ROW_DELIMITER, "  ");
  assert.equal(FRAME, "⠧");
  assert.equal(line, "⠧ explore  pi  running  12.4s  3 turns  look around");
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
      "⠧ explore  pi  running  12.4s  3 turns  look around",
      "⠧ explore  claude  running  12.4s  3 turns  look around",
      "⠧ explore  demo-one-shot  running  12.4s  3 turns  look around",
    ],
  );
});

test("a live row's duration counts and its spinner turns with the instant it is drawn at", () => {
  // The host redraws once per spinner frame while a Run is live, and each
  // redraw hands the renderer a later instant. The renderer reads no clock of
  // its own, so the same instant always draws the same row.
  const later = FIXTURE_NOW + 3 * SPINNER_INTERVAL_MS;
  assert.equal(
    rowAt(later),
    "⠋ explore  pi  running  13.0s  3 turns  look around",
  );
  assert.equal(rowAt(later), rowAt(later));
  assert.notEqual(spinnerFrame(later), FRAME);

  // Every running row spins in step: the frame is the instant's, not the row's.
  assert.equal(
    rowAt(later, { identity: { agent: "other" } }).charAt(0),
    rowAt(later).charAt(0),
  );
});

test("the spinner cycles through Pi's own frames, one per interval", () => {
  assert.equal(SPINNER_FRAMES.length, 10);
  assert.equal(SPINNER_INTERVAL_MS, 200);
  const frames = SPINNER_FRAMES.map((_frame, index) =>
    spinnerFrame(index * SPINNER_INTERVAL_MS),
  );
  assert.deepEqual(frames, [...SPINNER_FRAMES]);
  assert.equal(
    spinnerFrame(SPINNER_FRAMES.length * SPINNER_INTERVAL_MS),
    SPINNER_FRAMES[0],
  );
  // A frame is always one cell wide, so the columns after it stay aligned.
  for (const frame of SPINNER_FRAMES) assert.equal(visibleWidth(frame), 1);
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
  assert.equal(
    rowAt(later, { phase: "completed" }),
    "✓ explore  pi  completed  12.4s  3 turns",
  );
});

test("each phase has its own glyph and the widget observes the phase without determining it", () => {
  assert.equal(
    row(120, { phase: "finalizing" }),
    "◌ explore  pi  finalizing  12.4s  3 turns  look around",
  );
  assert.equal(
    row(120, { phase: "completed" }),
    "✓ explore  pi  completed  12.4s  3 turns",
  );
  assert.equal(
    row(120, { phase: "failed" }),
    "✗ explore  pi  failed  12.4s  3 turns",
  );
  assert.equal(
    row(120, { phase: "cancelled" }),
    "⊘ explore  pi  cancelled  12.4s  3 turns",
  );
});

test("a running Run whose cancellation is recorded says it is cancelling", () => {
  // The reader who asked for the cancellation is watching for it to take, and
  // `running` would tell them nothing had happened.
  assert.equal(
    row(120, { cancellation: { reason: "requested" } }),
    "⠧ explore  pi  cancelling  12.4s  3 turns  look around",
  );
  // A settled Run's phase is the fact; a cancellation recorded on the way
  // there is not what its row says.
  assert.equal(
    row(120, { phase: "completed", cancellation: { reason: "requested" } }),
    "✓ explore  pi  completed  12.4s  3 turns",
  );
});

test("a settled row shows no tail even if an activity is still on the snapshot", () => {
  assert.equal(
    row(120, { phase: "failed", activity: "bash: npm test" }),
    "✗ explore  pi  failed  12.4s  3 turns",
  );
});

test("reported activity joins the label in the tail, and wins when both will not fit", () => {
  assert.equal(
    row(120, { activity: "bash: npm test" }),
    "⠧ explore  pi  running  12.4s  3 turns  look around · bash: npm test",
  );
  // The label is the part the reader already knows.
  assert.equal(
    row(56, { activity: "bash: npm test" }),
    "⠧ explore  pi  running  12.4s  bash: npm test",
  );
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
  // And a truncated activity is still italic, to its last cell.
  const narrow = formatRunRow(
    fixtureRow({ activity: "a very long activity that will not fit" }),
    named,
    50,
    FIXTURE_NOW,
  );
  assert.ok(narrow.includes("\u001b[3m") && narrow.includes("…"));
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
      activity: "an activity long enough to be cut off by the width",
    }),
  ];
  const [, line = ""] = renderRunRows(rows, named, 60, FIXTURE_NOW);
  assert.ok(line.includes("\u001b[0m\u001b[44m"));
  assert.equal(visibleWidth(line), 60);
  assert.ok(line.endsWith("\u001b[49m"));
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

test("a Run with no turns yet reads as a dash rather than a zero", () => {
  assert.equal(
    row(120, { usage: fixtureUsage({ turns: 0 }) }),
    "⠧ explore  pi  running  12.4s  —  look around",
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
  assert.equal(line, "⠧ explore  pi  running  12.4s  3 turns  look around");
  assert.doesNotMatch(line, /tool|%|▰/);
});

test("the glyph and status are painted in the phase's tone, and a live duration brighter than a settled one", () => {
  const live = formatRunRow(fixtureRow(), named, 120, FIXTURE_NOW);
  assert.ok(live.startsWith(`${paint("warning", "⠧")} `));
  assert.match(live, painted("warning", "running"));
  assert.match(live, painted("text", "12.4s"));

  const settled = formatRunRow(
    fixtureRow({ phase: "completed" }),
    named,
    120,
    FIXTURE_NOW,
  );
  assert.ok(settled.startsWith(`${paint("success", "✓")} `));
  assert.match(settled, painted("dim", "12.4s"));
});

test("a row never exceeds the width it is given", () => {
  for (const width of [120, 80, 46, 30, 12]) {
    const line = row(width);
    assert.ok(
      visibleWidth(line) <= width,
      `width ${width} produced ${visibleWidth(line)} columns`,
    );
  }
});

test("optional columns give way in order, and glyph, agent, backend, and status never do", () => {
  const rows = [fixtureRow()];
  const at = (width: number) => measureColumns(rows, FIXTURE_NOW, width);

  // Wide enough for everything and a tail budget besides.
  assert.deepEqual(
    Object.entries(at(120)).filter(([, w]) => w === 0),
    [],
  );
  // Then the turn count, then the duration. The fixed part with every column
  // is 38 cells; each step frees its column and a delimiter, and the tail
  // needs a delimiter and its budget.
  assert.ok(at(64).turns > 0);
  assert.equal(at(63).turns, 0);
  assert.ok(at(63).duration > 0);
  assert.equal(at(54).duration, 0);
  assert.ok(at(54).status > 0);

  const narrow = row(22);
  assert.doesNotMatch(narrow, /3 turns/);
  assert.doesNotMatch(narrow, /look around/);
  assert.match(narrow, /^⠧ explore {2}pi {2}running/);
});
test("an optional column is drawn only when it leaves the tail its budget", () => {
  assert.equal(TAIL_BUDGET, 24);
  // The fixed part with every column is 2+7+2+2+2+7+2+5+2+7 = 38 cells, and
  // the tail sits after a delimiter.
  const rows = [fixtureRow()];
  const exact = 38 + ROW_DELIMITER.length + TAIL_BUDGET;
  assert.ok(measureColumns(rows, FIXTURE_NOW, exact).turns > 0);
  assert.equal(measureColumns(rows, FIXTURE_NOW, exact - 1).turns, 0);
  // A row with nothing to say after its columns needs no budget for it. Its
  // fixed part is 40 cells: `completed` is two wider than `running`.
  const settled = [fixtureRow({ phase: "completed" })];
  assert.ok(measureColumns(settled, FIXTURE_NOW, 40).turns > 0);
  assert.equal(measureColumns(settled, FIXTURE_NOW, 39).turns, 0);
});

test("a long agent name is truncated without hiding later fields", () => {
  const line = row(80, {
    identity: { agent: "a-very-long-agent-profile-name" },
  });

  assert.equal(MAX_AGENT_COLUMN_WIDTH, 16);
  assert.match(line, /^⠧ a-very-long-age… {2}pi/);
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

test("the whole widget is a titled rule, aligned rows, and an overflow summary", () => {
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
    "─── subagents  2 running ───────────────────────────────────────────────────────",
    " ⠧ explore   pi  running  12.4s  3 turns  look around",
    " ⠧ reviewer  pi  running  12.4s  1 turn   read the diff",
  ]);
});

test("the header counts each phase in its own colour, and says nothing about spend", () => {
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
  assert.match(header, new RegExp(literal(paint("accent", bold("subagents")))));
  assert.match(
    header,
    new RegExp(
      literal(
        paint("warning", "1 running") +
          paint("dim", " · ") +
          paint("error", "1 failed"),
      ),
    ),
  );

  // No token total and no cost: the first left out cache reads, and the
  // second summed backends that report at different moments. Each notice
  // carries its own Run's accounting instead.
  const plain = stripVTControlCharacters(
    renderRunRows(rows, theme, 100, FIXTURE_NOW)[0] ?? "",
  );
  assert.equal(visibleWidth(plain), 100);
  assert.equal(
    plain,
    `─── subagents  1 running · 1 failed ${"─".repeat(100 - 36)}`,
  );
  assert.doesNotMatch(plain, /tokens|\$/);
});

test("the header shortens rather than wraps on a narrow terminal", () => {
  const rows = [fixtureRow(), fixtureRow({ phase: "failed" })];
  const at = (width: number) =>
    stripVTControlCharacters(
      renderRunRows(rows, theme, width, FIXTURE_NOW)[0] ?? "",
    );
  assert.equal(at(40), `─── subagents  1 running · 1 failed ${"─".repeat(4)}`);
  assert.ok(visibleWidth(at(20)) <= 20);
  assert.match(at(20), /^─── subagents/);
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

// ── W-2: the row that will never leave on its own ───────────────────────────

test("W-2: a row whose notice will never arrive says so, with the id and the result", () => {
  // A settled row's only exits are a landing and a retrieval, and an exhausted
  // hand-off will never get the first. So the row explains itself, and gives
  // the two facts a reader needs to take the second: which Run it is and that
  // the answer is there regardless.
  assert.equal(
    row(120, { phase: "completed", handoff: "exhausted" }),
    "! explore  pi  completed  12.4s  3 turns  notification failed · run-1 · result available",
  );
});

test("W-2: the stuck row leads with a mark in the error colour, and only that row", () => {
  const stuck = formatRunRow(
    fixtureRow({ phase: "completed", handoff: "exhausted" }),
    named,
    120,
    FIXTURE_NOW,
  );
  assert.ok(stuck.startsWith(`${paint("error", "!")} `));
  assert.ok(
    stuck.endsWith(
      paint("error", "notification failed · run-1 · result available"),
    ),
  );
  // W-1 stands for every other settled row: the figure is the Run's, and the
  // row is painted as the phase says.
  assert.ok(
    formatRunRow(
      fixtureRow({ phase: "completed" }),
      named,
      120,
      FIXTURE_NOW,
    ).startsWith(`${paint("success", "✓")} `),
  );
});

test("W-2: an exhausted failed Run keeps its own verb", () => {
  assert.equal(
    row(120, { phase: "failed", handoff: "exhausted" }),
    "! explore  pi  failed  12.4s  3 turns  notification failed · run-1 · result available",
  );
});

test("W-2: the explanation is fitted like any tail, and the columns give way to keep it", () => {
  assert.equal(
    row(60, { phase: "completed", handoff: "exhausted" }),
    "! explore  pi  completed  12.4s  notification failed · run-…",
  );
  assert.equal(
    row(40, { phase: "completed", handoff: "exhausted" }),
    "! explore  pi  completed  notification …",
  );
});
