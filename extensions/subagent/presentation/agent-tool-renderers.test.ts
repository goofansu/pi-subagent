import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { ResumeOutcome, SteerOutcome } from "../domain/index.ts";
import { runId, subagentId } from "../domain/index.ts";
import {
  type AgentToolRendererState,
  agentToolRenderers,
  formatCancellationSummary,
  formatResumedRunSummary,
  formatStartedRunSummary,
  resumeRenderDetails,
  steerRenderDetails,
} from "./agent-tool-renderers.ts";
import type { RenderableTheme } from "./rows.ts";

initTheme(undefined, false);

const plainTheme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};

const markedTheme: RenderableTheme = {
  ...plainTheme,
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

const args = {
  agent: "explore",
  description: "look around",
  prompt:
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
};

function context(
  state: AgentToolRendererState,
  options: {
    expanded?: boolean;
    lastComponent?: Component;
    isPartial?: boolean;
  } = {},
) {
  return {
    args,
    toolCallId: "call-1",
    invalidate: () => undefined,
    lastComponent: options.lastComponent,
    state,
    cwd: "/work",
    executionStarted: true,
    argsComplete: true,
    isPartial: options.isPartial ?? false,
    expanded: options.expanded ?? false,
    showImages: true,
    isError: false,
  };
}

function lines(component: Component, width: number): string[] {
  return component
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd());
}

const successfulResult = {
  content: [
    {
      type: "text",
      text: "Started explore:\nsubagent id subagent-demo-1\nrun id run-demo-1\n\nComplete guidance.",
    },
  ],
  details: {
    kind: "start" as const,
    agent: "explore",
    subagentId: "subagent-demo-1",
    runId: "run-demo-1",
  },
};

test("a single-line prompt is limited to five visual lines with an honest marker", () => {
  const state: AgentToolRendererState = {};
  const pair = agentToolRenderers("start");
  const rendered = lines(pair.renderCall(args, plainTheme, context(state)), 24);
  const promptStart = rendered.findIndex((line) => line.startsWith("Prompt:"));
  const marker = rendered.findIndex((line) =>
    /\.\.\. \(\d+ more lines?\)/.test(line),
  );

  assert.equal(marker - promptStart, 5);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 24));
  assert.match(rendered[marker], /^\.\.\. \([1-9]\d* more lines?\)$/);
  assert.doesNotMatch(rendered[marker], /expand|ctrl|⌃/i);

  const oneHidden = lines(
    pair.renderCall(
      { ...args, prompt: "one\ntwo\nthree\nfour\nfive\nsix" },
      plainTheme,
      context({}),
    ),
    80,
  );
  assert.ok(oneHidden.includes("... (1 more line)"));
});

test("the same call component recomputes its preview after a resize", () => {
  const state: AgentToolRendererState = {};
  const pair = agentToolRenderers("start");
  const component = pair.renderCall(args, plainTheme, context(state));

  const wide = lines(component, 80).join("\n");
  const narrow = lines(component, 24).join("\n");

  assert.doesNotMatch(wide, /more lines?/);
  assert.match(narrow, /more lines?/);
});

test("successful start renderers reuse their prior components and repaint the current theme", () => {
  const state: AgentToolRendererState = {};
  const pair = agentToolRenderers("start");
  const firstCall = pair.renderCall(args, plainTheme, context(state));
  const reusedCall = pair.renderCall(
    args,
    markedTheme,
    context(state, { lastComponent: firstCall }),
  );
  assert.equal(reusedCall, firstCall);
  reusedCall.invalidate();
  assert.match(lines(reusedCall, 80).join("\n"), /<toolTitle>/);

  const firstResult = pair.renderResult(
    successfulResult,
    { expanded: false, isPartial: false },
    plainTheme,
    context(state),
  );
  const reusedResult = pair.renderResult(
    successfulResult,
    { expanded: false, isPartial: false },
    markedTheme,
    context(state, { lastComponent: firstResult }),
  );
  assert.equal(reusedResult, firstResult);
  reusedResult.invalidate();
  assert.match(lines(reusedResult, 80).join("\n"), /<toolTitle>/);
});

test("malformed, foreign, and legacy start details fall back to readable content", () => {
  const pair = agentToolRenderers("start");
  for (const details of [
    { kind: "start", agent: "explore" },
    { kind: "resume", subagentId: "subagent-1", runId: "run-2" },
    { agent: "explore", subagentId: "subagent-1", runId: "run-1" },
  ]) {
    const component = pair.renderResult(
      {
        content: [{ type: "text", text: "Readable legacy response\nmore" }],
        details,
      },
      { expanded: false, isPartial: false },
      plainTheme,
      context({}),
    );
    assert.match(
      lines(component, 80)[0],
      /^Readable legacy response \(.*to expand\)$/,
    );
  }
});

test("resume and steer malformed, foreign, and legacy details use readable fallback", () => {
  for (const [operation, details] of [
    ["resume", { kind: "resume", outcome: "started", subagentId: "sub-1" }],
    ["resume", { subagentId: "subagent-legacy", runId: "run-legacy" }],
    ["resume", { kind: "steer", outcome: "accepted", runId: "run-foreign" }],
    ["steer", { kind: "steer", outcome: "invalid" }],
    ["steer", { outcome: "mailbox full", runId: "run-legacy" }],
    [
      "steer",
      {
        kind: "resume",
        outcome: "started",
        subagentId: "sub-foreign",
        runId: "run-foreign",
      },
    ],
  ] as const) {
    const pair = agentToolRenderers(operation);
    const collapsed = pair.renderResult(
      {
        content: [{ type: "text", text: "Readable legacy response\nmore" }],
        details,
      },
      { expanded: false, isPartial: false },
      plainTheme,
      context({}),
    );
    const collapsedText = lines(collapsed, 80).join("\n");
    assert.match(collapsedText, /^Readable legacy response \(.*to expand\)$/);
    assert.doesNotMatch(
      collapsedText,
      /run-legacy|run-foreign|subagent-legacy/,
    );

    const expanded = pair.renderResult(
      {
        content: [{ type: "text", text: "Readable legacy response\nmore" }],
        details,
      },
      { expanded: true, isPartial: false },
      plainTheme,
      context({}, { expanded: true }),
    );
    assert.match(
      lines(expanded, 80).join("\n"),
      /Readable legacy response\nmore/,
    );
  }

  const malformedSteer = agentToolRenderers("steer").renderCall(
    { id: 3, message: false },
    plainTheme,
    { ...context({}), args: { id: 3, message: false } },
  );
  assert.match(
    lines(malformedSteer, 80)[0],
    /^agent_steer \[invalid arguments\]$/,
  );
});

test("a narrow resumed summary drops its field label before clipping the Run id", () => {
  const line = formatResumedRunSummary(
    {
      kind: "resume",
      outcome: "started",
      subagentId: "subagent-abcd-123",
      runId: "run-abcd-456",
    },
    plainTheme,
    38,
    (_action, description) => `o ${description}`,
  );

  assert.equal(line, "Resumed · run-abcd-456 (o to expand)");
  assert.ok(visibleWidth(line) <= 38);
  assert.doesNotMatch(line, /· Run /);
});

test("every operation outcome converts to an explicit discriminated detail", () => {
  const sid = subagentId("subagent-test-1");
  const rid = runId("run-test-1");
  const resumeOutcomes: readonly ResumeOutcome[] = [
    { outcome: "started", subagentId: sid, runId: rid },
    { outcome: "unknown Subagent", subagentId: sid },
    { outcome: "Subagent already running", subagentId: sid },
    { outcome: "empty label" },
    { outcome: "resume unsupported" },
    { outcome: "conversation lost" },
    { outcome: "at capacity" },
    { outcome: "shutting down" },
  ];
  assert.deepEqual(
    resumeOutcomes.map((outcome) => resumeRenderDetails(outcome).outcome),
    resumeOutcomes.map(({ outcome }) => outcome),
  );
  assert.ok(
    resumeOutcomes.every(
      (outcome) => resumeRenderDetails(outcome).kind === "resume",
    ),
  );

  const steerOutcomes: readonly SteerOutcome[] = [
    { outcome: "accepted", runId: rid },
    { outcome: "mailbox full", runId: rid },
    { outcome: "invalid", reason: "empty" },
    { outcome: "unsupported", runId: rid },
    { outcome: "mailbox closed", runId: rid },
    { outcome: "already completed", runId: rid },
    { outcome: "already failed", runId: rid },
    { outcome: "already cancelled", runId: rid },
    { outcome: "unknown Run", runId: rid },
    { outcome: "shutting down" },
  ];
  assert.deepEqual(
    steerOutcomes.map((outcome) => steerRenderDetails(rid, outcome).outcome),
    steerOutcomes.map(({ outcome }) => outcome),
  );
  assert.ok(
    steerOutcomes.every(
      (outcome) => steerRenderDetails(rid, outcome).kind === "steer",
    ),
  );
  assert.deepEqual(
    steerRenderDetails(rid, { outcome: "invalid", reason: "empty" }),
    { kind: "steer", outcome: "invalid", runId: rid },
  );
});

test("every resume refusal and Control admission outcome has a distinct semantic line", () => {
  const resume = agentToolRenderers("resume");
  const resumeDetails = [
    { kind: "resume", outcome: "unknown Subagent" },
    { kind: "resume", outcome: "Subagent already running" },
    { kind: "resume", outcome: "empty label" },
    { kind: "resume", outcome: "resume unsupported" },
    { kind: "resume", outcome: "conversation lost" },
    { kind: "resume", outcome: "at capacity" },
    { kind: "resume", outcome: "shutting down" },
  ] as const;
  const resumeLines = resumeDetails.map((details) =>
    lines(
      resume.renderResult(
        { content: [{ type: "text", text: "complete prose" }], details },
        { expanded: false, isPartial: false },
        plainTheme,
        context({}),
      ),
      100,
    )[0].replace(/ \(.*to expand\)$/, ""),
  );
  assert.equal(new Set(resumeLines).size, resumeDetails.length);

  const steer = agentToolRenderers("steer");
  const steerDetails = [
    { kind: "steer", outcome: "accepted", runId: "run-1" },
    { kind: "steer", outcome: "mailbox full", runId: "run-1" },
    { kind: "steer", outcome: "mailbox closed", runId: "run-1" },
    { kind: "steer", outcome: "unsupported", runId: "run-1" },
    { kind: "steer", outcome: "invalid", runId: "run-1" },
    { kind: "steer", outcome: "already completed", runId: "run-1" },
    { kind: "steer", outcome: "already failed", runId: "run-1" },
    { kind: "steer", outcome: "already cancelled", runId: "run-1" },
    { kind: "steer", outcome: "unknown Run", runId: "run-1" },
    { kind: "steer", outcome: "shutting down", runId: "run-1" },
  ] as const;
  const steerLines = steerDetails.map((details) =>
    lines(
      steer.renderResult(
        { content: [{ type: "text", text: "complete prose" }], details },
        { expanded: false, isPartial: false },
        plainTheme,
        context({}),
      ),
      100,
    )[0].replace(/ \(.*to expand\)$/, ""),
  );
  assert.equal(new Set(steerLines).size, steerDetails.length);
  assert.equal(steerLines[0], "Accepted into local Control mailbox");
  assert.doesNotMatch(steerLines[0], /provider|model/i);
});

test("a one-line rejection with no hidden prompt content has no expansion affordance", () => {
  const shortArgs = { ...args, prompt: "short" };
  const state: AgentToolRendererState = {};
  const pair = agentToolRenderers("start");
  const callContext = { ...context(state), args: shortArgs };
  lines(pair.renderCall(shortArgs, plainTheme, callContext), 80);
  const result = pair.renderResult(
    { content: [{ type: "text", text: 'Unknown agent: "ghost".' }] },
    { expanded: false, isPartial: false },
    plainTheme,
    callContext,
  );

  assert.equal(lines(result, 80).join("\n"), 'Unknown agent: "ghost".');
});

test("a narrow compact success keeps both actionable ids ahead of a long Agent", () => {
  const width = 72;
  const line = formatStartedRunSummary(
    {
      kind: "start",
      agent: "standards-reviewer",
      subagentId: "subagent-abcd-123",
      runId: "run-abcd-456",
    },
    plainTheme,
    width,
    (_action, description) => `ctrl+shift+o ${description}`,
  );

  assert.equal(
    line,
    "Started · subagent-abcd-123 · run-abcd-456 (ctrl+shift+o to expand)",
  );
  assert.equal(visibleWidth(line), 67);
  assert.ok(visibleWidth(line) <= width);
  assert.doesNotMatch(line, /standards-reviewer/);
  assert.equal(line.match(/to expand/g)?.length, 1);
});

test("cancellation call names deduplicated Runs or a width-fitted count", () => {
  const pair = agentToolRenderers("cancel");
  const args = {
    ids: ["run-alpha-123", "run-beta-456", "run-alpha-123"],
  };
  const wide = lines(
    pair.renderCall(args, plainTheme, { ...context({}), args }),
    80,
  );
  assert.equal(wide.join("\n"), "agent_cancel run-alpha-123, run-beta-456");

  const narrow = lines(
    pair.renderCall(args, plainTheme, { ...context({}), args }),
    24,
  );
  assert.equal(narrow.join("\n"), "agent_cancel 2 Runs");
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
});

test("cancellation uses the configured hint and omits it for an identical one-line response", () => {
  const details = {
    kind: "cancel" as const,
    outcomes: [{ kind: "requested" as const, runId: "run-demo-1" }],
  };
  const actions: string[] = [];
  const configured = formatCancellationSummary(
    details,
    plainTheme,
    80,
    (action, description) => {
      actions.push(action);
      return `alt+o ${description}`;
    },
  );
  assert.equal(configured, "Cancellation requested: 1 (alt+o to expand)");
  assert.deepEqual(actions, ["app.tools.expand"]);
  assert.equal(configured.match(/to expand/g)?.length, 1);

  assert.equal(
    formatCancellationSummary(
      { kind: "cancel", outcomes: [] },
      plainTheme,
      80,
      (_action, description) => `alt+o ${description}`,
    ),
    "No run ids were given. (alt+o to expand)",
  );

  const pair = agentToolRenderers("cancel");
  const state: AgentToolRendererState = {};
  lines(
    pair.renderCall({ ids: ["run-demo-1"] }, plainTheme, {
      ...context(state),
      args: { ids: ["run-demo-1"] },
    }),
    80,
  );
  const result = pair.renderResult(
    {
      content: [{ type: "text", text: "Cancellation requested: 1" }],
      details,
    },
    { expanded: false, isPartial: false },
    plainTheme,
    context(state),
  );
  assert.equal(lines(result, 80).join("\n"), "Cancellation requested: 1");

  const expanded = pair.renderResult(
    {
      content: [{ type: "text", text: "Cancellation requested: 1" }],
      details,
    },
    { expanded: true, isPartial: false },
    plainTheme,
    context(state, { expanded: true }),
  );
  assert.equal(lines(expanded, 80).join("\n"), "Cancellation requested: 1");
  assert.doesNotMatch(lines(expanded, 80).join("\n"), /to collapse/);
});

test("malformed, foreign, and legacy cancellation details fall back readably", () => {
  const pair = agentToolRenderers("cancel");
  for (const details of [
    { kind: "cancel", outcomes: [{ kind: "requested" }] },
    {
      kind: "cancel",
      outcomes: [
        { kind: "already terminal", runId: "run-1", phase: "running" },
      ],
    },
    { kind: "start", outcomes: [] },
    { requested: ["run-1"] },
  ]) {
    const result = pair.renderResult(
      {
        content: [
          { type: "text", text: "Readable cancellation response\nmore" },
        ],
        details,
      },
      { expanded: false, isPartial: false },
      plainTheme,
      context({}),
    );
    assert.match(
      lines(result, 80).join("\n"),
      /^Readable cancellation response \(.*to expand\)$/,
    );
  }
});

test("the compact success owns one hint and expansion reveals the complete response", () => {
  const state: AgentToolRendererState = {};
  const pair = agentToolRenderers("start");
  lines(pair.renderCall(args, plainTheme, context(state)), 18);

  const collapsed = lines(
    pair.renderResult(
      successfulResult,
      { expanded: false, isPartial: false },
      plainTheme,
      context(state),
    ),
    80,
  ).join("\n");
  assert.match(collapsed, /subagent-demo-1/);
  assert.match(collapsed, /run-demo-1/);
  assert.equal(collapsed.match(/to expand/g)?.length, 1);

  const expandedCall = lines(
    pair.renderCall(args, plainTheme, context(state, { expanded: true })),
    1_000,
  ).join("\n");
  assert.match(expandedCall, /nineteen twenty/);

  const expanded = lines(
    pair.renderResult(
      successfulResult,
      { expanded: true, isPartial: false },
      plainTheme,
      context(state, { expanded: true }),
    ),
    80,
  ).join("\n");
  assert.match(expanded, /Complete guidance\./);
  assert.equal(expanded.match(/to collapse/g)?.length, 1);
});

test("result-bearing calls retain their operation and identify their scope or targets", () => {
  const cases = [
    {
      operation: "wait" as const,
      args: { ids: ["run-one", "run-two"] },
      wide: "agent_wait · run-one, run-two",
      narrow: "agent_wait · 2 Runs",
    },
    {
      operation: "waitAll" as const,
      args: {},
      wide: "agent_wait_all · all active Runs",
      narrow: "agent_wait_all · all active Runs",
    },
    {
      operation: "result" as const,
      args: { id: "run-one" },
      wide: "agent_result · run-one",
      narrow: "agent_result · run-one",
    },
  ];

  for (const entry of cases) {
    const pair = agentToolRenderers(entry.operation);
    assert.equal(
      lines(pair.renderCall(entry.args, plainTheme, context({})), 80)[0],
      entry.wide,
    );
    const narrow = lines(
      pair.renderCall(entry.args, plainTheme, context({})),
      entry.operation === "wait" ? 20 : 80,
    )[0];
    assert.equal(narrow, entry.narrow);
  }
});

test("collection summaries discriminate delivery, timeout, unknown, unavailable, and no-active outcomes", () => {
  const pair = agentToolRenderers("wait");
  const cases = [
    [
      {
        kind: "collection",
        scope: "named",
        runs: [
          {
            runId: "run-1",
            agent: "explore",
            status: "completed",
            outputCharacters: 6,
          },
        ],
        stillRunning: 0,
        unknown: 0,
        unavailable: 0,
        noActiveRuns: false,
      },
      "Delivered 1 Result",
    ],
    [
      {
        kind: "collection",
        scope: "named",
        runs: [
          {
            runId: "run-1",
            agent: "explore",
            status: "completed",
            outputCharacters: 6,
          },
        ],
        stillRunning: 2,
        unknown: 1,
        unavailable: 1,
        noActiveRuns: false,
      },
      "Delivered 1 Result · 1 Result unavailable · 2 Runs still running · 1 Run unknown",
    ],
    [
      {
        kind: "collection",
        scope: "all-active",
        runs: [],
        stillRunning: 0,
        unknown: 0,
        unavailable: 0,
        noActiveRuns: true,
      },
      "No active Runs",
    ],
  ] as const;

  for (const [details, expected] of cases) {
    const collapsed = lines(
      pair.renderResult(
        {
          content: [{ type: "text", text: "Complete model response" }],
          details,
        },
        { expanded: false, isPartial: false },
        plainTheme,
        context({}),
      ),
      120,
    ).join("\n");
    assert.match(
      collapsed,
      new RegExp(
        `^${expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")} \\(.*to expand\\)$`,
      ),
    );
    assert.equal(collapsed.match(/to expand/g)?.length, 1);
  }

  const narrowTimeout = lines(
    pair.renderResult(
      {
        content: [{ type: "text", text: "complete response" }],
        details: cases[1][0],
      },
      { expanded: false, isPartial: false },
      plainTheme,
      context({}),
    ),
    45,
  ).join("\n");
  assert.match(narrowTimeout, /^2 Runs still running/);
  assert.doesNotMatch(narrowTimeout, /^Delivered/);
  assert.ok(visibleWidth(narrowTimeout) <= 45);
});

test("agent_result summaries distinguish available, running, unknown, and unavailable outcomes", () => {
  const pair = agentToolRenderers("result");
  const cases = [
    [
      {
        kind: "result",
        outcome: "available",
        run: {
          runId: "run-1",
          agent: "explore",
          status: "completed",
          outputCharacters: 12_345,
        },
      },
      "explore · run-1 · completed · 12.3k characters",
    ],
    [
      { kind: "result", outcome: "still-running", runId: "run-2" },
      "run-2 · still running",
    ],
    [
      { kind: "result", outcome: "unknown", runId: "run-never" },
      "run-never · unknown Run",
    ],
    [
      {
        kind: "result",
        outcome: "unavailable",
        runId: "run-3",
        status: "failed",
      },
      "run-3 · Result unavailable · failed",
    ],
  ] as const;

  for (const [details, expected] of cases) {
    const collapsed = lines(
      pair.renderResult(
        {
          content: [{ type: "text", text: "Complete model response" }],
          details,
        },
        { expanded: false, isPartial: false },
        plainTheme,
        context({}),
      ),
      100,
    ).join("\n");
    assert.ok(collapsed.startsWith(expected));
    assert.equal(collapsed.match(/to expand/g)?.length, 1);
  }
});

test("result-bearing renderers reuse components and repaint the current theme", () => {
  const state: AgentToolRendererState = {};
  const pair = agentToolRenderers("result");
  const callArgs = { id: "run-1" };
  const result = {
    content: [{ type: "text", text: "complete response" }],
    details: {
      kind: "result" as const,
      outcome: "available" as const,
      run: {
        runId: "run-1",
        agent: "explore",
        status: "completed" as const,
        outputCharacters: 17,
      },
    },
  };
  const firstCall = pair.renderCall(callArgs, plainTheme, context(state));
  const reusedCall = pair.renderCall(
    callArgs,
    markedTheme,
    context(state, { lastComponent: firstCall }),
  );
  assert.equal(reusedCall, firstCall);
  reusedCall.invalidate();
  assert.match(lines(reusedCall, 80).join("\n"), /<toolTitle>/);

  const firstResult = pair.renderResult(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    context(state),
  );
  const reusedResult = pair.renderResult(
    result,
    { expanded: false, isPartial: false },
    markedTheme,
    context(state, { lastComponent: firstResult }),
  );
  assert.equal(reusedResult, firstResult);
  reusedResult.invalidate();
  assert.match(lines(reusedResult, 80).join("\n"), /<toolOutput>/);
});

test("result-bearing renderers fail open for malformed details and present partial work as unfinished", () => {
  const pair = agentToolRenderers("result");
  for (const details of [
    { kind: "result", outcome: "available", run: { runId: "run-1" } },
    { kind: "collection", scope: "named", runs: [] },
    { runs: [], stillRunning: 0 },
  ]) {
    const collapsed = lines(
      pair.renderResult(
        {
          content: [{ type: "text", text: "Readable legacy response\nmore" }],
          details,
        },
        { expanded: false, isPartial: false },
        plainTheme,
        context({}),
      ),
      80,
    ).join("\n");
    assert.match(collapsed, /^Readable legacy response \(.*to expand\)$/);
  }

  const partial = lines(
    pair.renderResult(
      {
        content: [],
        details: { kind: "result", outcome: "unknown", runId: "run-never" },
      },
      { expanded: false, isPartial: true },
      plainTheme,
      context({}, { isPartial: true }),
    ),
    80,
  ).join("\n");
  assert.equal(partial, "agent_result is still running.");
  assert.doesNotMatch(partial, /unknown Run|to expand/);
});
