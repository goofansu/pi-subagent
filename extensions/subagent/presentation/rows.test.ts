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
  orderRows,
  type RenderableTheme,
  ROW_DELIMITER,
  renderRunRows,
} from "./rows.ts";

/** A theme that paints nothing, so a golden test reads the text itself. */
const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

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

test("a row carries agent, backend, turn count, status, and activity, and nothing else fixed", () => {
  const line = row(120);

  assert.equal(ROW_DELIMITER, "  ");
  assert.equal(line, "explore  pi  3 turns  running · look around");
  // The Run id and the model are deliberately absent: ids belong to tool
  // results and notices, where the model that acts on them reads them.
  assert.doesNotMatch(line, /run-1/);
  assert.doesNotMatch(line, /subagent-1/);
  // No live clock on a running row.
  assert.doesNotMatch(line, /12\.4s/);
});

test("a row names each backend the same way", () => {
  // Compatibility-matrix proof: the active widget row is backend-independent
  // apart from the backend's own name. See docs/v2/compatibility-matrix.md.
  assert.deepEqual(
    ["pi", "claude", "codex"].map((backend) =>
      row(120, { identity: { backendId: backendId(backend) } }),
    ),
    [
      "explore  pi  3 turns  running · look around",
      "explore  claude  3 turns  running · look around",
      "explore  codex  3 turns  running · look around",
    ],
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

  // A live row is measured against the moment and names no duration, so a
  // later draw reads the same for the opposite reason.
  assert.equal(rowAt(later), "explore  pi  3 turns  running · look around");
  assert.equal(
    rowAt(later, { phase: "finalizing" }),
    rowAt(FIXTURE_NOW, { phase: "finalizing" }),
  );
});

test("the widget observes phase without determining it", () => {
  assert.equal(
    row(120, { phase: "completed" }),
    "explore  pi  3 turns  completed in 12.4s",
  );
  assert.equal(
    row(120, { phase: "finalizing" }),
    "explore  pi  3 turns  finalizing",
  );
});

test("a settled row shows no activity tail even if one is still on the snapshot", () => {
  assert.equal(
    row(120, { phase: "failed", activity: "bash: npm test" }),
    "explore  pi  3 turns  failed after 12.4s",
  );
});

test("reported activity replaces the description as the tail", () => {
  assert.equal(
    row(120, { activity: "bash: npm test" }),
    "explore  pi  3 turns  running · bash: npm test",
  );
});

test("a Run with no turns yet reads as a dash rather than a zero", () => {
  assert.equal(
    row(120, { usage: fixtureUsage({ turns: 0 }) }),
    "explore  pi  —  running · look around",
  );
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

test("turns give way before status, and status never does", () => {
  assert.match(row(45), /3 turns.*running/);

  const narrow = row(22);
  assert.doesNotMatch(narrow, /3 turns/);
  assert.doesNotMatch(narrow, /look around/);
  assert.match(narrow, /running/);
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

test("the whole widget is a titled rule, aligned rows, and an overflow summary", () => {
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({
      identity: { agent: "reviewer", description: "read the diff" },
      usage: fixtureUsage({ turns: 1 }),
    }),
  ];

  const lines = renderRunRows(rows, theme, 60, FIXTURE_NOW).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.deepEqual(lines, [
    "─── subagents (2 running) ──────────────────────────────────",
    " explore   pi  3 turns  running · look around",
    " reviewer  pi  1 turn   running · read the diff",
  ]);
});

test("the widget caps its rows and says how many it is not showing", () => {
  const rows = Array.from({ length: 10 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );

  const lines = renderRunRows(rows, theme, 80, FIXTURE_NOW, 3).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.equal(lines.length, 5);
  assert.equal(lines.at(-1), " … and 7 more");
});

test("an empty list renders nothing at all", () => {
  assert.deepEqual(renderRunRows([], theme, 80, FIXTURE_NOW), []);
});

test("W-2: a row whose notice will never arrive says so, with the id and the result", () => {
  // A settled row's only exits are a landing and a retrieval, and an exhausted
  // hand-off will never get the first. So the row explains itself, and gives
  // the two facts a reader needs to take the second: which Run it is and that
  // the answer is there regardless.
  assert.equal(
    row(120, { phase: "completed", handoff: "exhausted" }),
    "explore  pi  3 turns  completed · notification failed · run-1 · result available",
  );
});

test("W-2: the duration gives way to the explanation, and only on that row", () => {
  // W-1 stands for every other settled row: the figure is the Run's, and it
  // reads the same however late the row is drawn.
  assert.equal(
    row(120, { phase: "completed" }),
    "explore  pi  3 turns  completed in 12.4s",
  );
  assert.doesNotMatch(
    row(120, { phase: "completed", handoff: "exhausted" }),
    /12\.4s/,
  );
});

test("W-2: an exhausted failed Run keeps its own verb", () => {
  assert.equal(
    row(120, { phase: "failed", handoff: "exhausted" }),
    "explore  pi  3 turns  failed · notification failed · run-1 · result available",
  );
});

test("W-2: the explanation's tail gives way first, and the turn count next", () => {
  // The tail is fitted like the activity tail and skipped when there is not
  // room to read it; then turn accounting goes; the status never gives.
  assert.equal(
    row(60, { phase: "completed", handoff: "exhausted" }),
    "explore  pi  3 turns  completed · notification failed",
  );
  assert.equal(
    row(46, { phase: "completed", handoff: "exhausted" }),
    "explore  pi  completed · notification failed",
  );
});
