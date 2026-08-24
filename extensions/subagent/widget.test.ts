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
  formatRunLine,
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

test("a run line carries agent, cost and status, and nothing else fixed", () => {
  const line = stripVTControlCharacters(formatRunLine(view(), theme, 120));

  assert.match(line, /explore/);
  assert.match(line, /\$0\.0142/);
  assert.match(line, /running/);
  // No live clock: elapsed time would need a once-a-second redraw to stay
  // honest, so a running row names no duration at all.
  assert.doesNotMatch(line, /12\.4s/);
  // The id and model are deliberately absent: ids belong to tool results and
  // reports, and the model is the profile's business.
  assert.doesNotMatch(line, /a3f81c2b/);
});

test("a settled run keeps its final duration, computed once", () => {
  const line = stripVTControlCharacters(
    formatRunLine(view({ status: "completed" }), theme, 120),
  );

  assert.match(line, /completed in 12\.4s/);
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

test("cost gives way before status, and status never does", () => {
  const at = (width: number) =>
    stripVTControlCharacters(formatRunLine(view(), theme, width));

  const wide = at(45);
  assert.match(wide, /\$0\.0142.*running/);

  const noCost = at(22);
  assert.doesNotMatch(noCost, /\$0\.0142/);
  assert.match(noCost, /running/);

  for (const width of [45, 22, 12]) {
    assert.ok(at(width).length <= width, `width ${width} overflowed`);
  }
});

test("columns are measured across rows, not per row", () => {
  const columns = measureColumns([
    view({ agent: "explore", cost: 0.0142 }),
    view({ agent: "implementer", cost: 12.4 }),
  ]);

  assert.equal(columns.agent, "implementer".length);
  assert.equal(columns.cost, "$12.4000".length);
});

test("columns line up even when agent names differ in length", () => {
  const lines = plain(
    renderRunLines(
      [view({ agent: "explore" }), view({ agent: "implementer" })],
      theme,
      120,
    ),
  ).slice(1);

  assert.equal(columnOf(lines[0], "running"), columnOf(lines[1], "running"));
});

test("a wide glyph does not shift its row against a narrow one", () => {
  const lines = plain(
    renderRunLines(
      [view({ status: "running" }), view({ status: "completed" })],
      theme,
      120,
    ),
  ).slice(1);

  // Display columns, not string indices: the glyph cell is padded to a fixed
  // width so a glyph wider than one column cannot shift what follows it.
  assert.equal(columnOf(lines[0], "explore"), columnOf(lines[1], "explore"));
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

// ── Activity tail ────────────────────────────────────────────────────────────

test("a running run shows what it is doing after the status", () => {
  const line = stripVTControlCharacters(
    formatRunLine(view({ activity: "bash: npm test" }), theme, 120),
  );

  assert.match(line, /running {2}· bash: npm test$/);
});

test("the description stands in before the first tool call", () => {
  const line = stripVTControlCharacters(formatRunLine(view(), theme, 120));

  assert.match(line, /· look around$/);
});

test("a settled run does not carry a stale activity", () => {
  const line = stripVTControlCharacters(
    formatRunLine(
      view({ status: "completed", activity: "bash: npm test" }),
      theme,
      120,
    ),
  );

  assert.doesNotMatch(line, /npm test/);
  assert.doesNotMatch(line, /look around/);
});

test("the activity is the first thing sacrificed to width", () => {
  const wide = stripVTControlCharacters(
    formatRunLine(view({ activity: "bash: npm test" }), theme, 200),
  );
  const status = wide.indexOf("running");
  const narrow = stripVTControlCharacters(
    formatRunLine(
      view({ activity: "bash: npm test" }),
      theme,
      status + "running".length + 4,
    ),
  );

  assert.match(narrow, /running$/);
  assert.doesNotMatch(narrow, /npm test/);
});

test("a long activity is cut to the width the columns left", () => {
  const width = 100;
  const line = stripVTControlCharacters(
    formatRunLine(view({ activity: `bash: ${"x".repeat(200)}` }), theme, width),
  );

  assert.ok(visibleWidth(line) <= width);
  assert.match(line, /…$/);
});
