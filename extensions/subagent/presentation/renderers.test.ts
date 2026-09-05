import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CollectedRuns } from "./details.ts";
import {
  contentText,
  formatCollectedSummary,
  formatNotificationSummary,
  formatParentheticalKeyHint,
  formatResumeSummary,
  MAX_NOTICE_LABEL_WIDTH,
  renderCollectedResult,
  renderResumeResult,
  renderStartCall,
} from "./renderers.ts";
import type { RenderableTheme } from "./rows.ts";

// The renderers reach Pi's key-hint helper, which reads the active theme.
initTheme(undefined, false);

/** A theme that paints nothing, so a golden test reads the text itself. */
const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

/**
 * A theme that marks its dim spans visibly.
 *
 * Markers rather than real escapes: the property under test is that the
 * punctuation around a key hint is painted *separately* from the hint, which a
 * marker shows and an escape sequence only obscures.
 */
const dimAware: RenderableTheme = {
  fg: (color, text) => (color === "dim" ? `<dim>${text}</dim>` : text),
  bg: (_color, text) => text,
  bold: (text) => text,
};

/** A deterministic stand-in for the host's key hint. */
const keyHintStub = (_action: unknown, description: string): string =>
  `ctrl+o ${description}`;

/**
 * The width the collapsed-line goldens are written for.
 *
 * Wide enough that nothing gives way, so each golden reads as the sentence it
 * is about rather than as an exercise in truncation. The fitting has its own
 * tests, and each of those states its own width.
 */
const GOLDEN_WIDTH = 120;

function lines(component: { render(width: number): string[] }): string[] {
  return component
    .render(80)
    .map((line) => stripVTControlCharacters(line).trimEnd());
}

// -- agent_start's transcript row --------------------------------------------

test("a started Run's row shows who was asked and what for, and nothing else", () => {
  const component = renderStartCall(
    { agent: "explore", description: "look around", prompt: "have a look" },
    theme,
    { expanded: false },
  );

  // The trailing empty line is deliberate air: the host paints the tool
  // result directly below this row, in the same grey as the prompt.
  assert.deepEqual(lines(component), [
    "explore look around",
    "",
    "Prompt: have a look",
    "",
  ]);
});

test("a collapsed brief is cut to three lines and says that it was cut", () => {
  const component = renderStartCall(
    {
      agent: "explore",
      description: "look around",
      prompt: "one\ntwo\nthree\nfour\nfive",
    },
    theme,
    { expanded: false },
  );

  assert.deepEqual(lines(component), [
    "explore look around",
    "",
    "Prompt: one",
    "two",
    "three",
    "…",
    "",
  ]);
});

test("an expanded brief is shown whole", () => {
  const component = renderStartCall(
    {
      agent: "explore",
      description: "look around",
      prompt: "one\ntwo\nthree\nfour",
    },
    theme,
    { expanded: true },
  );

  assert.match(lines(component).join("\n"), /four/);
});

test("a re-render reuses the row's existing text component", () => {
  const existing = new Text("", 0, 0);

  const component = renderStartCall(
    { agent: "explore", description: "d", prompt: "p" },
    theme,
    { lastComponent: existing, expanded: false },
  );

  assert.equal(component, existing);
});

// -- The collapsed result line -----------------------------------------------

const oneRun: CollectedRuns = {
  runs: [{ runId: "run-1", agent: "explore", status: "completed" }],
};

test("a lone Run's collapsed line names it, states its status, and counts characters", () => {
  assert.equal(
    formatCollectedSummary(oneRun, 2_400, theme, keyHintStub),
    "explore (run-1) completed · 2.4k characters (ctrl+o to expand)",
  );
});

test("a fan-out of one agent is counted rather than named repeatedly", () => {
  const many: CollectedRuns = {
    runs: [
      { runId: "run-1", agent: "explore", status: "completed" },
      { runId: "run-2", agent: "explore", status: "completed" },
      { runId: "run-3", agent: "explore", status: "failed" },
    ],
  };

  assert.equal(
    formatCollectedSummary(many, 900, theme, keyHintStub),
    "3 explore results · 900 characters (ctrl+o to expand)",
  );
});

test("a mixed fan-out names each agent, with a count where it repeats", () => {
  const mixed: CollectedRuns = {
    runs: [
      { runId: "run-1", agent: "explore", status: "completed" },
      { runId: "run-2", agent: "explore", status: "completed" },
      { runId: "run-3", agent: "reviewer", status: "completed" },
    ],
  };

  assert.equal(
    formatCollectedSummary(mixed, 1_000, theme, keyHintStub),
    "3 results from explore ×2, reviewer · 1.0k characters (ctrl+o to expand)",
  );
});

test("a wait that timed out says how many are still running", () => {
  assert.equal(
    formatCollectedSummary(
      { ...oneRun, stillRunning: 2 },
      120,
      theme,
      keyHintStub,
    ),
    "explore (run-1) completed · 120 characters · 2 still running (ctrl+o to expand)",
  );
});

test("the parenthetical hint's punctuation is painted apart from the hint", () => {
  assert.equal(
    formatParentheticalKeyHint(
      dimAware,
      "app.tools.expand",
      "to expand",
      keyHintStub,
    ),
    "<dim>(</dim>ctrl+o to expand<dim>)</dim>",
  );
});

// -- The result component ----------------------------------------------------

test("a collapsed result is one summary line and an expanded one is the body", () => {
  const result = {
    content: [{ type: "text", text: "# Findings\n\nAll clear." }],
    details: oneRun,
  };

  const collapsed = lines(
    renderCollectedResult(result, { expanded: false }, theme),
  );
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /^explore \(run-1\) completed · 22 characters/);
  assert.match(
    lines(renderCollectedResult(result, { expanded: true }, theme)).join("\n"),
    /All clear\./,
  );
});

test("a result with no Runs to name falls back to its opening line", () => {
  const result = {
    content: "Unknown run ids: run-never.\n\nmore text",
    details: undefined,
  };

  assert.deepEqual(
    lines(renderCollectedResult(result, { expanded: false }, theme)),
    ["Unknown run ids: run-never."],
  );
});

test("a result with another extension's details is not summarised as ours", () => {
  const result = { content: "some text", details: { whatever: true } };

  assert.deepEqual(
    lines(renderCollectedResult(result, { expanded: false }, theme)),
    ["some text"],
  );
});

test("an empty result renders nothing", () => {
  assert.deepEqual(
    lines(
      renderCollectedResult({ content: "   " }, { expanded: false }, theme),
    ),
    [],
  );
});

// -- The resume handoff ------------------------------------------------------

test("a resumed Run's collapsed line is an actionable identity handoff", () => {
  assert.equal(
    formatResumeSummary(
      { subagentId: "subagent-1", runId: "run-2" },
      theme,
      keyHintStub,
    ),
    "Resumed subagent subagent-1 · run run-2 (ctrl+o to expand)",
  );
});

test("a resume result collapses to the handoff and expands to its text", () => {
  const result = {
    content: "Resumed subagent subagent-1:\nrun id run-2\n\nmore",
    details: { subagentId: "subagent-1", runId: "run-2" },
  };

  assert.match(
    lines(renderResumeResult(result, { expanded: false }, theme))[0],
    /^Resumed subagent subagent-1 · run run-2/,
  );
  assert.match(
    lines(renderResumeResult(result, { expanded: true }, theme)).join("\n"),
    /run id run-2/,
  );
});

test("a rejected resume falls back to the collected renderer", () => {
  const result = {
    content: "Cannot resume subagent subagent-9: unknown Subagent. More.",
    details: undefined,
  };

  assert.deepEqual(
    lines(renderResumeResult(result, { expanded: false }, theme)),
    ["Cannot resume subagent subagent-9: unknown Subagent. More."],
  );
});

// -- The notification summary line -------------------------------------------

test("S-1: a collapsed notice names the agent, the task, and the outcome", () => {
  assert.equal(
    formatNotificationSummary(
      {
        agent: "reviewer",
        label: "audit auth redirects",
        status: "completed",
        durationMillis: 41_200,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    "reviewer · audit auth redirects · completed in 41.2s (ctrl+o to expand)",
  );
});

test("S-1: the collapsed line reads the same whichever backend ran the Run", () => {
  // It carries no cost, and that is why. A cost total starts at zero and is
  // only added to, so a backend that reported no money is indistinguishable
  // from a Run that cost nothing — a figure here would read as a fact when it
  // is sometimes an absence. What a Run spent is on the notice's accounting
  // line.
  assert.doesNotMatch(
    formatNotificationSummary(
      {
        agent: "reviewer",
        label: "audit auth redirects",
        status: "completed",
        durationMillis: 41_200,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    /\$/,
  );
});

test("S-2: a failed and a cancelled summary read the same way, with the verb changed", () => {
  assert.equal(
    formatNotificationSummary(
      {
        agent: "implementer",
        label: "fix flaky cache test",
        status: "failed",
        durationMillis: 19_400,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    "implementer · fix flaky cache test · failed in 19.4s (ctrl+o to expand)",
  );
  assert.equal(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "inspect the build graph",
        status: "cancelled",
        durationMillis: 60_000,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    "explore · inspect the build graph · cancelled in 1m 0s (ctrl+o to expand)",
  );
});

test("a collapsed notice carries no id and no character count", () => {
  const line = formatNotificationSummary(
    {
      agent: "explore",
      label: "look around",
      status: "completed",
      durationMillis: 1_000,
    },
    theme,
    GOLDEN_WIDTH,
    false,
    keyHintStub,
  );

  assert.doesNotMatch(line, /run-|subagent-/);
  assert.doesNotMatch(line, /character/);
});

test("the whole collapsed line is fitted to its width, and the label is what gives", () => {
  // The agent, the outcome and the hint are what the reader came for, so the
  // label takes whatever is left and never pushes the line wider.
  for (const width of [120, 100, 80, 70, 60]) {
    const line = stripVTControlCharacters(
      formatNotificationSummary(
        {
          agent: "explore",
          label: "a".repeat(200),
          status: "completed",
          durationMillis: 1_000,
        },
        theme,
        width,
        false,
        keyHintStub,
      ),
    );

    assert.ok(
      line.length <= width,
      `${line.length} columns against a width of ${width}: ${line}`,
    );
    assert.equal(line.includes("\n"), false);
    // Everything but the label survives at every width.
    assert.match(line, /^explore · /);
    assert.match(line, /completed in 1\.0s \(ctrl\+o to expand\)$/);
  }
});

test("a line too narrow for any label drops the label whole, not into a gap", () => {
  // The label gives way the way a widget row's turn count does. The outcome
  // never gives: a reader who cannot see how a Run ended has no line worth
  // having, so a terminal narrower than the fixed parts overflows instead.
  const line = stripVTControlCharacters(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "audit auth redirects",
        status: "failed",
        durationMillis: 1_000,
      },
      theme,
      10,
      false,
      keyHintStub,
    ),
  );

  assert.equal(line, "explore · failed in 1.0s (ctrl+o to expand)");
  assert.doesNotMatch(line, /· +·/);
});

test("a label is capped even when the line has room to spare", () => {
  // On a wide terminal a 200-byte label would push the outcome and the cost so
  // far right that a reader scanning a column of notices could not find them.
  const line = stripVTControlCharacters(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "a".repeat(200),
        status: "completed",
        durationMillis: 1_000,
      },
      theme,
      400,
      false,
      keyHintStub,
    ),
  );

  assert.equal(
    line,
    `explore · ${"a".repeat(MAX_NOTICE_LABEL_WIDTH - 1)}… · completed in 1.0s (ctrl+o to expand)`,
  );
});

test("an expanded notice's hint offers to collapse, because one key does both", () => {
  assert.match(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "look around",
        status: "completed",
        durationMillis: 1_000,
      },
      theme,
      GOLDEN_WIDTH,
      true,
      keyHintStub,
    ),
    /\(ctrl\+o to collapse\)$/,
  );
});

// -- Content shapes ----------------------------------------------------------

test("result content is read whatever shape it arrived in", () => {
  assert.equal(contentText("plain"), "plain");
  assert.equal(
    contentText([
      { type: "text", text: "one " },
      { type: "image" },
      { type: "text", text: "two" },
    ]),
    "one two",
  );
});
