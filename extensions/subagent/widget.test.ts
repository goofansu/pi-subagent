import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createEmptyResult } from "./run.ts";
import type { RunView } from "./runs.ts";
import { createSubagentRuns } from "./runs.ts";
import type { WidgetComponent, WidgetHost, WidgetTheme } from "./widget.ts";
import {
  formatCost,
  formatModel,
  formatRunLine,
  formatTurns,
  installRunsWidget,
  measureColumns,
  orderRuns,
  renderRunLines,
  WIDGET_KEY,
} from "./widget.ts";

const theme: WidgetTheme = {
  fg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
};

function view(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "a3f81c2b",
    agent: "explore",
    description: "look around",
    status: "running",
    elapsedMs: 12_400,
    model: "openai-codex/gpt-5.6-sol",
    turns: 3,
    cost: 0.0142,
    ...overrides,
  };
}

function plain(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

/** The display column a substring starts at, counting wide characters. */
function columnOf(line: string, needle: string): number {
  const index = line.indexOf(needle);
  assert.notEqual(index, -1, `"${needle}" is not in "${line}"`);
  return visibleWidth(line.slice(0, index));
}

// ── The line ─────────────────────────────────────────────────────────────────

test("a run line carries id, agent, model, cost and status", () => {
  const line = stripVTControlCharacters(formatRunLine(view(), theme, 120));

  assert.match(line, /a3f81c2b/);
  assert.match(line, /explore/);
  assert.match(line, /gpt-5\.6-sol/);
  assert.match(line, /\$0\.0142/);
  assert.match(line, /running for 12\.4s/);
});

test("the model drops its provider prefix", () => {
  assert.equal(formatModel("openai-codex/gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(formatModel("gpt-5.6-sol"), "gpt-5.6-sol");
});

test("a run with no reported model yet still renders", () => {
  const line = stripVTControlCharacters(
    formatRunLine(view({ model: undefined }), theme, 120),
  );

  assert.match(line, /—/);
  assert.match(line, /a3f81c2b/);
});

test("cost always reads as money, including zero", () => {
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(1.5), "$1.5000");
});

test("a line never exceeds the width it is given", () => {
  for (const width of [80, 46, 30, 12]) {
    const line = stripVTControlCharacters(formatRunLine(view(), theme, width));
    assert.ok(
      line.length <= width,
      `width ${width} produced ${line.length} columns`,
    );
  }
});

test("fields give way in order, and status never does", () => {
  const at = (width: number) =>
    stripVTControlCharacters(formatRunLine(view(), theme, width));

  const wide = at(80);
  assert.match(wide, /gpt-5\.6-sol.*3 turns.*\$0\.0142.*running for 12\.4s/);

  // Model goes first: the least useful field once a run is under way.
  const noModel = at(60);
  assert.doesNotMatch(noModel, /gpt-5\.6-sol/);
  assert.match(noModel, /3 turns.*\$0\.0142.*running for 12\.4s/);

  // Then cost. Turns outlive it because a rising count is what shows the run
  // is still moving, now that the line does not say what it is doing.
  const noCost = at(50);
  assert.doesNotMatch(noCost, /\$0\.0142/);
  assert.match(noCost, /3 turns.*running for 12\.4s/);

  // Status is last to go, and it never does.
  assert.match(at(40), /running for 12\.4s/);
  for (const width of [80, 60, 50, 40, 30, 12]) {
    assert.ok(at(width).length <= width, `width ${width} overflowed`);
  }
});

test("turns are omitted until the child has spoken", () => {
  assert.equal(formatTurns(0), "");
  assert.equal(formatTurns(1), "1 turn");
  assert.equal(formatTurns(12), "12 turns");
});

test("columns are measured across rows, not per row", () => {
  const columns = measureColumns([
    view({ agent: "explore", turns: 3 }),
    view({ agent: "implementer", turns: 12, model: "x/claude-opus-5" }),
  ]);

  assert.equal(columns.agent, "implementer".length);
  assert.equal(columns.model, "claude-opus-5".length);
  assert.equal(columns.turns, "12 turns".length);
});

test("columns line up even when agent names differ in length", () => {
  const lines = plain(
    renderRunLines(
      [view({ agent: "explore" }), view({ agent: "implementer" })],
      theme,
      120,
    ),
  ).slice(1);

  assert.equal(
    columnOf(lines[0], "running for"),
    columnOf(lines[1], "running for"),
  );
});

test("a wide glyph does not shift its row against a narrow one", () => {
  const lines = plain(
    renderRunLines(
      [view({ status: "running" }), view({ status: "completed" })],
      theme,
      120,
    ),
  ).slice(1);

  // Display columns, not string indices: "⏳" is one character but two columns
  // wide, so the two are not the same measurement.
  assert.equal(columnOf(lines[0], "a3f81c2b"), columnOf(lines[1], "a3f81c2b"));
});

// ── The block ────────────────────────────────────────────────────────────────

test("an empty registry renders nothing at all", () => {
  assert.deepEqual(renderRunLines([], theme, 120), []);
});

test("the block is a titled rule plus one line per run", () => {
  const lines = plain(
    renderRunLines([view(), view({ id: "b7c2", agent: "review" })], theme, 120),
  );

  assert.match(lines[0], /subagents \(2\)/);
  assert.match(lines[1], /explore/);
  assert.match(lines[2], /review/);
  assert.equal(lines.length, 3);
});

test("running runs sort above settled ones", () => {
  const ordered = orderRuns([
    view({ id: "done", status: "completed" }),
    view({ id: "live", status: "running" }),
  ]);

  assert.deepEqual(
    ordered.map((run) => run.id),
    ["live", "done"],
  );
});

test("a wide fan-out is summarised rather than filling the terminal", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    view({ id: `run-${index}` }),
  );

  const lines = plain(renderRunLines(many, theme, 120, 8));

  assert.equal(lines.length, 10, "rule + 8 rows + overflow");
  assert.match(lines[0], /subagents \(20\)/);
  assert.match(lines.at(-1) ?? "", /and 12 more/);
});

// ── Installation ─────────────────────────────────────────────────────────────

function recordingHost(): WidgetHost & {
  calls: Array<{ key: string; cleared: boolean }>;
  redraws(): number;
  render(width: number): string[];
} {
  const calls: Array<{ key: string; cleared: boolean }> = [];
  let redraws = 0;
  let component: WidgetComponent | undefined;
  return {
    calls,
    setWidget(key, content) {
      calls.push({ key, cleared: content === undefined });
      component = content?.({ requestRender: () => redraws++ }, theme);
    },
    redraws: () => redraws,
    render(width) {
      assert.ok(component, "no widget is installed");
      return plain(component.render(width));
    },
  };
}

test("the widget appears with a run and is removed when none are left", () => {
  const host = recordingHost();
  const runs = createSubagentRuns();
  installRunsWidget(host, runs);

  assert.equal(host.calls.length, 0, "nothing is installed while idle");

  const handle = runs.track(createEmptyResult("explore", "look", 0), () => {});

  assert.deepEqual(host.calls, [{ key: WIDGET_KEY, cleared: false }]);
  assert.match(host.render(120)[1], /explore/);

  runs.release(handle.id);

  assert.equal(host.calls.at(-1)?.cleared, true);
});

test("a change redraws the widget instead of reinstalling it", () => {
  const host = recordingHost();
  const runs = createSubagentRuns();
  installRunsWidget(host, runs);
  const handle = runs.track(createEmptyResult("explore", "look", 0), () => {});

  const installsAfterFirstRun = host.calls.length;
  handle.changed();
  handle.changed();

  assert.equal(host.calls.length, installsAfterFirstRun, "no reinstall");
  assert.equal(host.redraws(), 2);
});

test("the widget renders the registry as it is at render time", () => {
  const host = recordingHost();
  const runs = createSubagentRuns();
  installRunsWidget(host, runs);
  runs.track(createEmptyResult("explore", "look", 0), () => {});

  assert.match(host.render(120)[0], /subagents \(1\)/);

  runs.track(createEmptyResult("reviewer", "check", 0), () => {});

  assert.match(host.render(120)[0], /subagents \(2\)/);
});

test("unsubscribing stops the widget following the registry", () => {
  const host = recordingHost();
  const runs = createSubagentRuns();
  const stop = installRunsWidget(host, runs);

  stop();
  const before = host.calls.length;
  runs.track(createEmptyResult("explore", "look", 0), () => {});

  assert.equal(host.calls.length, before);
});
