import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createEmptyResult } from "./run.ts";
import type { RunView } from "./runs.ts";
import { createSubagentRuns } from "./runs.ts";
import type { RenderableTheme } from "./types.ts";
import type { WidgetComponent, WidgetHost } from "./widget.ts";
import {
  formatRunLine,
  formatTurns,
  installRunsWidget,
  MAX_AGENT_COLUMN_WIDTH,
  orderRuns,
  ROW_DELIMITER,
  renderRunLines,
  WIDGET_KEY,
} from "./widget.ts";

const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function view(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "a3f81c2b",
    agent: "explore",
    harness: "pi",
    description: "look around",
    status: "running",
    elapsedMs: 12_400,
    turns: 3,
    ...overrides,
  };
}

function plain(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

function columnOf(line: string, needle: string): number {
  const index = line.indexOf(needle);
  assert.notEqual(index, -1, `"${needle}" is not in "${line}"`);
  return visibleWidth(line.slice(0, index));
}

// ── The line ─────────────────────────────────────────────────────────────────

test("a run line carries agent, harness, turns and status, and nothing else fixed", () => {
  const line = stripVTControlCharacters(formatRunLine(view(), theme, 120));

  assert.match(line, /explore {2}pi/);
  assert.match(line, /3 turns/);
  assert.match(line, /running/);
  // No live clock: elapsed time would need a once-a-second redraw to stay
  // honest, so a running row names no duration at all.
  assert.doesNotMatch(line, /12\.4s/);
  // The id and model are deliberately absent: ids belong to tool results and
  // reports, and the model is the profile's business.
  assert.doesNotMatch(line, /a3f81c2b/);
});

test("INV-10: the widget observes runtime state without determining it", () => {
  const line = stripVTControlCharacters(
    formatRunLine(view({ status: "completed" }), theme, 120),
  );

  assert.match(line, /completed in 12\.4s/);
});

test("turns use a quiet singular/plural format", () => {
  assert.equal(formatTurns(0), "—");
  assert.equal(formatTurns(1), "1 turn");
  assert.equal(formatTurns(2), "2 turns");
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

test("turns give way before status, and status never does", () => {
  const at = (width: number) =>
    stripVTControlCharacters(formatRunLine(view(), theme, width));

  const wide = at(45);
  assert.match(wide, /3 turns.*running/);

  const noTurns = at(22);
  assert.doesNotMatch(noTurns, /3 turns/);
  assert.doesNotMatch(noTurns, /npm test/);
  assert.match(noTurns, /running/);

  for (const width of [45, 22, 12]) {
    assert.ok(at(width).length <= width, `width ${width} overflowed`);
  }
});

test("fixed row fields use the same space delimiter", () => {
  const line = stripVTControlCharacters(
    formatRunLine(view({ activity: "bash: npm test" }), theme, 120),
  );

  assert.equal(ROW_DELIMITER, "  ");
  assert.equal(line, "explore  pi  3 turns  running · bash: npm test");
});

test("long agent names are truncated without hiding later fields", () => {
  const line = stripVTControlCharacters(
    formatRunLine(view({ agent: "a-very-long-agent-profile-name" }), theme, 80),
  );

  assert.equal(MAX_AGENT_COLUMN_WIDTH, 16);
  assert.match(line, /^a-very-long-age… {2}pi/);
  assert.match(line, /running/);
});

test("each field aligns across rows", () => {
  const lines = plain(
    renderRunLines(
      [
        view({ agent: "librarian", harness: "pi", activity: "first" }),
        view({
          agent: "tools",
          harness: "claude",
          turns: 1,
          activity: "second",
        }),
      ],
      theme,
      120,
    ),
  ).slice(1);

  for (const [firstNeedle, secondNeedle] of [
    ["pi", "claude"],
    ["3 turns", "1 turn"],
    ["running", "running"],
  ]) {
    assert.equal(
      columnOf(lines[0], firstNeedle),
      columnOf(lines[1], secondNeedle),
    );
  }
});

// ── The block ────────────────────────────────────────────────────────────────

test("an empty registry renders nothing at all", () => {
  assert.deepEqual(renderRunLines([], theme, 120), []);
});

test("the block is a titled rule plus one line per run", () => {
  const lines = plain(
    renderRunLines([view(), view({ id: "b7c2", agent: "review" })], theme, 120),
  );

  assert.match(lines[0], /subagents \(2 running\)/);
  assert.match(lines[1], /explore/);
  assert.match(lines[2], /review/);
  assert.equal(lines.length, 3);
});

test("the title groups statuses in lifecycle order and omits zero-count groups", () => {
  const lines = plain(
    renderRunLines(
      [
        view({ id: "cancelled", status: "cancelled" }),
        view({ id: "failed", status: "failed" }),
        view({ id: "completed", status: "completed" }),
        view({ id: "live", status: "running" }),
        view({ id: "done", status: "completed" }),
      ],
      theme,
      120,
    ),
  );

  assert.match(
    lines[0],
    /subagents \(1 running, 2 completed, 1 failed, 1 cancelled\)/,
  );
  assert.doesNotMatch(lines[0], /0 /);
});

test("a single settled status reads naturally in the title", () => {
  const lines = plain(
    renderRunLines(
      [
        view({ id: "done-1", status: "completed" }),
        view({ id: "done-2", status: "completed" }),
        view({ id: "done-3", status: "completed" }),
      ],
      theme,
      120,
    ),
  );

  assert.match(lines[0], /subagents \(3 completed\)/);
});

test("a verbose status title stays one truncated rule line when narrow", () => {
  for (const width of [30, 12]) {
    const lines = renderRunLines(
      [
        view({ id: "live", status: "running" }),
        view({ id: "done", status: "completed" }),
        view({ id: "failed", status: "failed" }),
        view({ id: "cancelled", status: "cancelled" }),
      ],
      theme,
      width,
    );

    assert.equal(lines.length, 5);
    assert.ok(visibleWidth(lines[0]) <= width);
    assert.doesNotMatch(lines[0], /\n/);
  }
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
  assert.match(lines[0], /subagents \(20 running\)/);
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

  assert.match(host.render(120)[0], /subagents \(1 running\)/);

  runs.track(createEmptyResult("reviewer", "check", 0), () => {});

  assert.match(host.render(120)[0], /subagents \(2 running\)/);
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

test("uninstalling clears an installed widget from the host", () => {
  const host = recordingHost();
  const runs = createSubagentRuns();
  runs.track(createEmptyResult("explore", "look", 0), () => {});
  const stop = installRunsWidget(host, runs);

  stop();

  assert.deepEqual(host.calls.at(-1), { key: WIDGET_KEY, cleared: true });
});

test("uninstalling a widget that never showed touches the host not at all", () => {
  const host = recordingHost();
  const stop = installRunsWidget(host, createSubagentRuns());

  stop();

  assert.deepEqual(host.calls, []);
});

test("uninstalling survives a host that is already tearing down", () => {
  const runs = createSubagentRuns();
  runs.track(createEmptyResult("explore", "look", 0), () => {});
  // A stale session's host: every method throws once the session is replaced.
  const host: WidgetHost = {
    setWidget(_key, content) {
      if (content === undefined) throw new Error("session replaced");
    },
  };
  const stop = installRunsWidget(host, runs);

  assert.doesNotThrow(stop);
});

// ── Activity tail ────────────────────────────────────────────────────────────

test("a running run shows what it is doing after the status", () => {
  const line = stripVTControlCharacters(
    formatRunLine(view({ activity: "bash: npm test" }), theme, 120),
  );

  assert.match(line, /running · bash: npm test$/);
});

test("the description stands in before the first tool call", () => {
  const line = stripVTControlCharacters(formatRunLine(view(), theme, 120));

  assert.match(line, / · look around$/);
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

  assert.match(narrow, /3 turns/);
  assert.match(narrow, /running$/);
  assert.doesNotMatch(narrow, /npm test/);
});

test("a long activity is cut to the width the fixed components left", () => {
  const width = 100;
  const line = stripVTControlCharacters(
    formatRunLine(view({ activity: `bash: ${"x".repeat(200)}` }), theme, width),
  );

  assert.ok(visibleWidth(line) <= width);
  assert.match(line, /…$/);
});
