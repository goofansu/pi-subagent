import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { runId, subagentId } from "../domain/index.ts";
import {
  type AgentToolRendererState,
  agentToolRenderers,
  formatCancellationSummary,
} from "./agent-tool-renderers.ts";
import type { RenderableTheme } from "./rows.ts";
import {
  CANCEL_BUCKET_PRESENTATION,
  cancelBuckets,
  collectionRowPresentation,
  resumeToolRowFacts,
  startToolRowFacts,
  steerToolRowFacts,
} from "./tool-row-facts.ts";

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
  details: startToolRowFacts("explore", {
    outcome: "started",
    subagentId: subagentId("subagent-demo-1"),
    runId: runId("run-demo-1"),
  }),
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

test("a narrow resumed identity drops its field label before clipping the Run id", () => {
  const details = resumeToolRowFacts({
    outcome: "started",
    subagentId: subagentId("subagent-abcd-123"),
    runId: runId("run-abcd-456"),
  });
  const line = lines(
    agentToolRenderers("resume").renderResult(
      { content: [{ type: "text", text: "complete prose" }], details },
      { expanded: false, isPartial: false },
      plainTheme,
      context({ callHidden: true }),
    ),
    38,
  )[0];

  assert.match(line, /^Resumed · run-abcd-456/);
  assert.ok(visibleWidth(line) <= 38);
  assert.doesNotMatch(line, /· Run /);
});

test("pass-through facts render with their declared tone", () => {
  const requestedRunId = runId("run-1");
  const cases = [
    [
      "steer",
      steerToolRowFacts(requestedRunId, {
        outcome: "accepted",
        runId: requestedRunId,
      }),
      "toolTitle",
    ],
    [
      "start",
      startToolRowFacts("ghost", {
        outcome: "unknown agent",
        agent: "ghost",
      }),
      "error",
    ],
    [
      "start",
      startToolRowFacts("explore", { outcome: "at capacity" }),
      "warning",
    ],
  ] as const;

  for (const [operation, details, tone] of cases) {
    const rendered = lines(
      agentToolRenderers(operation).renderResult(
        { content: [{ type: "text", text: "complete prose" }], details },
        { expanded: false, isPartial: false },
        markedTheme,
        context({}),
      ),
      100,
    )[0];
    assert.match(rendered, new RegExp(`^<${tone}>`));
  }
});

test("successful start and resume identities read phrase and tone from facts", () => {
  const run = runId("run-2");
  const subagent = subagentId("subagent-1");
  const cases = [
    [
      "start",
      {
        ...startToolRowFacts("explore", {
          outcome: "started",
          subagentId: subagent,
          runId: run,
        }),
        rowPhrase: "Launched",
        tone: "warning",
      },
      "<warning>Launched explore</warning><dim> · Subagent subagent-1 · Run run-2</dim>",
    ],
    [
      "resume",
      {
        ...resumeToolRowFacts({
          outcome: "started",
          subagentId: subagent,
          runId: run,
        }),
        rowPhrase: "Continued",
        tone: "error",
      },
      "<error>Continued</error><dim> · Run run-2</dim>",
    ],
  ] as const;

  for (const [operation, details, expected] of cases) {
    const rendered = lines(
      agentToolRenderers(operation).renderResult(
        { content: [{ type: "text", text: "complete prose" }], details },
        { expanded: false, isPartial: false },
        markedTheme,
        context({}),
      ),
      120,
    )[0];
    assert.equal(rendered, `${expected} <dim>(</dim> to expand<dim>)</dim>`);
  }
});

test("golden: every operation keeps its collapsed row text and styling", () => {
  const run = runId("run-1");
  const subagent = subagentId("subagent-1");
  const waitDetails = {
    kind: "collection",
    scope: "named",
    runs: [],
    stillRunning: 1,
    unknown: 0,
    unavailable: 0,
    noActiveRuns: false,
  } as const;
  const idleWaitAllDetails = {
    kind: "collection",
    scope: "all-active",
    runs: [],
    stillRunning: 0,
    unknown: 0,
    unavailable: 0,
    noActiveRuns: true,
  } as const;
  const cases = [
    [
      "start",
      startToolRowFacts("explore", {
        outcome: "started",
        subagentId: subagent,
        runId: run,
      }),
    ],
    [
      "resume",
      resumeToolRowFacts({
        outcome: "started",
        subagentId: subagent,
        runId: run,
      }),
    ],
    ["steer", steerToolRowFacts(run, { outcome: "unknown Run", runId: run })],
    ["wait", waitDetails],
    ["waitAll", idleWaitAllDetails],
    [
      "result",
      {
        kind: "result",
        outcome: "available",
        run: {
          runId: run,
          agent: "explore",
          status: "completed",
          output: { kind: "visible", characters: 12_345 },
        },
      },
    ],
  ] as const;
  const rendered = Object.fromEntries(
    cases.map(([operation, details]) => [
      operation,
      lines(
        agentToolRenderers(operation).renderResult(
          { content: [{ type: "text", text: "complete prose" }], details },
          { expanded: false, isPartial: false },
          markedTheme,
          context({}),
        ),
        120,
      )[0],
    ]),
  );

  const hint = " <dim>(</dim> to expand<dim>)</dim>";
  const styledCollection = (
    presentation: ReturnType<typeof collectionRowPresentation>,
  ) => {
    const text =
      presentation.answer ?? presentation.clauses.join(presentation.separator);
    return `<${presentation.tone}>${text}</${presentation.tone}>${hint}`;
  };
  assert.deepEqual(rendered, {
    start: `<toolTitle>Started explore</toolTitle><dim> · Subagent subagent-1 · Run run-1</dim>${hint}`,
    resume: `<toolTitle>Resumed</toolTitle><dim> · Run run-1</dim>${hint}`,
    steer: `<error>Control refused</error><dim> · unknown Run</dim>${hint}`,
    wait: styledCollection(collectionRowPresentation(waitDetails)),
    waitAll: styledCollection(collectionRowPresentation(idleWaitAllDetails)),
    result: `<toolOutput>explore · run-1 · completed · 12.3k characters</toolOutput>${hint}`,
  });
});

test("aggregate result facts retain exact text and tone for every outcome", () => {
  const cases = [
    [
      {
        kind: "result",
        outcome: "available",
        run: {
          runId: "run-1",
          agent: "explore",
          status: "completed",
          output: { kind: "visible", characters: 12_345 },
        },
      },
      "<toolOutput>explore · run-1 · completed · 12.3k characters</toolOutput>",
    ],
    [
      {
        kind: "result",
        outcome: "available",
        run: {
          runId: "run-none",
          agent: "explore",
          status: "completed",
          output: { kind: "none" },
        },
      },
      "<toolOutput>explore · run-none · completed · no output</toolOutput>",
    ],
    [
      {
        kind: "result",
        outcome: "available",
        run: {
          runId: "run-removed",
          agent: "explore",
          status: "completed",
          output: { kind: "removed" },
        },
      },
      "<toolOutput>explore · run-removed · completed · output removed</toolOutput>",
    ],
    [
      { kind: "result", outcome: "still-running", runId: "run-2" },
      "<warning>run-2 · still running</warning>",
    ],
    [
      { kind: "result", outcome: "unknown", runId: "run-never" },
      "<error>run-never · unknown Run</error>",
    ],
    [
      {
        kind: "result",
        outcome: "unavailable",
        runId: "run-3",
        status: "failed",
      },
      "<error>run-3 · Result unavailable · failed</error>",
    ],
  ] as const;

  for (const [details, expected] of cases) {
    const rendered = lines(
      agentToolRenderers("result").renderResult(
        { content: [{ type: "text", text: "complete prose" }], details },
        { expanded: false, isPartial: false },
        markedTheme,
        context({}),
      ),
      120,
    )[0];
    assert.equal(rendered, `${expected} <dim>(</dim> to expand<dim>)</dim>`);
  }
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

test("a narrow compact success drops Agent and field labels before either id", () => {
  const width = 60;
  const details = startToolRowFacts("standards-reviewer", {
    outcome: "started",
    subagentId: subagentId("subagent-abcd-123"),
    runId: runId("run-abcd-456"),
  });
  const line = lines(
    agentToolRenderers("start").renderResult(
      { content: [{ type: "text", text: "complete prose" }], details },
      { expanded: false, isPartial: false },
      plainTheme,
      context({ callHidden: true }),
    ),
    width,
  )[0];

  assert.equal(line, "Started · subagent-abcd-123 · run-abcd-456 ( to expand)");
  assert.ok(visibleWidth(line) <= width);
  assert.match(line, /subagent-abcd-123 · run-abcd-456/);
  assert.doesNotMatch(line, /standards-reviewer|Subagent |Run /);
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

test("cancellation summary uses the aggregate tone, fits its width, and owns one configured hint", () => {
  const details = {
    kind: "cancel" as const,
    outcomes: [{ kind: "requested" as const, runId: "run-demo-1" }],
  };
  const actions: string[] = [];
  const toned = formatCancellationSummary(
    details,
    markedTheme,
    120,
    (action, description) => {
      actions.push(action);
      return `alt+o ${description}`;
    },
  );
  assert.match(toned, /^<toolOutput>/);
  assert.deepEqual(actions, ["app.tools.expand"]);
  assert.equal(toned.match(/to expand/g)?.length, 1);

  const configured = formatCancellationSummary(
    details,
    plainTheme,
    36,
    (_action, description) => `alt+o ${description}`,
  );
  assert.ok(visibleWidth(configured) <= 36);

  const empty = formatCancellationSummary(
    { kind: "cancel", outcomes: [] },
    plainTheme,
    36,
    (_action, description) => `alt+o ${description}`,
  );
  assert.ok(visibleWidth(empty) <= 36);
  assert.equal(empty.match(/to expand/g)?.length, 1);

  const summary = cancelBuckets(details)
    .map(({ rowPhrase, count }) => `${rowPhrase}: ${count}`)
    .join(" · ");
  const pair = agentToolRenderers("cancel");
  const state: AgentToolRendererState = {};
  lines(
    pair.renderCall({ ids: ["run-demo-1"] }, plainTheme, {
      ...context(state),
      args: { ids: ["run-demo-1"] },
    }),
    80,
  );
  for (const expanded of [false, true]) {
    const result = pair.renderResult(
      { content: [{ type: "text", text: summary }], details },
      { expanded, isPartial: false },
      plainTheme,
      context(state, { expanded }),
    );
    assert.equal(lines(result, 80).join("\n"), summary);
    assert.doesNotMatch(lines(result, 80).join("\n"), /to (?:expand|collapse)/);
  }
});

test("empty settled and partial cancellation rows have no inert toggle", () => {
  const pair = agentToolRenderers("cancel");
  const cases = [
    {
      result: { content: [], details: { foreign: true } },
      options: { expanded: false, isPartial: false },
      expected: "agent_cancel returned no readable response.",
    },
    {
      result: { content: [], details: { kind: "cancel", outcomes: [] } },
      options: { expanded: false, isPartial: false },
      expected: CANCEL_BUCKET_PRESENTATION.empty.rowPhrase,
    },
    {
      result: { content: [], details: { kind: "cancel", outcomes: [] } },
      options: { expanded: false, isPartial: true },
      expected: "agent_cancel is still running.",
    },
  ] as const;

  for (const entry of cases) {
    const collapsed = lines(
      pair.renderResult(entry.result, entry.options, plainTheme, context({})),
      80,
    ).join("\n");
    const expanded = lines(
      pair.renderResult(
        entry.result,
        { ...entry.options, expanded: true },
        plainTheme,
        context({}, { expanded: true, isPartial: entry.options.isPartial }),
      ),
      80,
    ).join("\n");
    assert.equal(collapsed, entry.expected);
    assert.equal(expanded, entry.expected);
    assert.doesNotMatch(`${collapsed}\n${expanded}`, /to (?:expand|collapse)/);
  }
});

test("reused continuation and cancel renderers repaint the current theme", () => {
  const cases = [
    {
      operation: "resume" as const,
      args: { id: "subagent-1", description: "continue", prompt: "again" },
      result: {
        content: [{ type: "text", text: "resume prose" }],
        details: resumeToolRowFacts({
          outcome: "started",
          subagentId: subagentId("subagent-1"),
          runId: runId("run-2"),
        }),
      },
      resultTone: /<toolTitle>/,
    },
    {
      operation: "steer" as const,
      args: { id: "run-1", message: "continue" },
      result: {
        content: [{ type: "text", text: "steer prose" }],
        details: steerToolRowFacts(runId("run-1"), {
          outcome: "accepted",
          runId: runId("run-1"),
        }),
      },
      resultTone: /<toolTitle>/,
    },
    {
      operation: "cancel" as const,
      args: { ids: ["run-1"] },
      result: {
        content: [{ type: "text", text: "cancel prose" }],
        details: {
          kind: "cancel" as const,
          outcomes: [{ kind: "requested" as const, runId: "run-1" }],
        },
      },
      resultTone: /<toolOutput>/,
    },
  ];

  for (const entry of cases) {
    const pair = agentToolRenderers(entry.operation);
    const state: AgentToolRendererState = {};
    const firstCall = pair.renderCall(entry.args, plainTheme, {
      ...context(state),
      args: entry.args,
    });
    const reusedCall = pair.renderCall(entry.args, markedTheme, {
      ...context(state, { lastComponent: firstCall }),
      args: entry.args,
    });
    assert.equal(reusedCall, firstCall);
    reusedCall.invalidate();
    assert.match(lines(reusedCall, 80).join("\n"), /<toolTitle>/);

    const firstResult = pair.renderResult(
      entry.result,
      { expanded: false, isPartial: false },
      plainTheme,
      context(state),
    );
    const reusedResult = pair.renderResult(
      entry.result,
      { expanded: false, isPartial: false },
      markedTheme,
      context(state, { lastComponent: firstResult }),
    );
    assert.equal(reusedResult, firstResult);
    reusedResult.invalidate();
    assert.match(lines(reusedResult, 80).join("\n"), entry.resultTone);
  }
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

test("unfinished arguments are explicit, restored complete arguments render normally, and settled malformed arguments stay invalid", () => {
  const cases = [
    ["start", { agent: "explore" }, args],
    [
      "resume",
      { id: "subagent-1" },
      { id: "subagent-1", description: "continue", prompt: "look again" },
    ],
    ["wait", {}, { ids: ["run-1"] }],
    ["waitAll", null, {}],
    ["result", {}, { id: "run-1" }],
    ["cancel", {}, { ids: ["run-1"] }],
    ["steer", { id: "run-1" }, { id: "run-1", message: "go" }],
  ] as const;

  for (const [operation, partialArgs, completeArgs] of cases) {
    const pair = agentToolRenderers(operation);
    const unfinished = lines(
      pair.renderCall(partialArgs, plainTheme, {
        ...context({}),
        args: partialArgs,
        argsComplete: false,
      }),
      80,
    ).join("\n");
    assert.match(unfinished, /\[arguments incomplete\]/);
    assert.doesNotMatch(unfinished, /invalid arguments/);

    const restored = lines(
      pair.renderCall(completeArgs, plainTheme, {
        ...context({}),
        args: completeArgs,
        argsComplete: false,
      }),
      80,
    ).join("\n");
    assert.match(
      restored,
      new RegExp(`agent_${operation === "waitAll" ? "wait_all" : operation}`),
    );
    assert.doesNotMatch(restored, /arguments (?:incomplete|invalid)/);

    const malformed = lines(
      pair.renderCall(null, plainTheme, {
        ...context({}),
        args: null,
        argsComplete: true,
      }),
      80,
    ).join("\n");
    assert.match(malformed, /\[invalid arguments\]/);
  }
});

test("start, resume, and steer partial results never present settled semantics", () => {
  const cases = [
    [
      "start",
      successfulResult,
      /agent_start is still running\./,
      /Started|run-demo-1/,
    ],
    [
      "resume",
      {
        content: [{ type: "text", text: "Resumed subagent-1" }],
        details: resumeToolRowFacts({
          outcome: "started",
          subagentId: subagentId("subagent-1"),
          runId: runId("run-2"),
        }),
      },
      /agent_resume is still running\./,
      /Resumed|run-2/,
    ],
    [
      "steer",
      {
        content: [{ type: "text", text: "Steering accepted" }],
        details: steerToolRowFacts(runId("run-1"), {
          outcome: "accepted",
          runId: runId("run-1"),
        }),
      },
      /agent_steer is still running\./,
      /Accepted|Steering accepted/,
    ],
  ] as const;

  for (const [operation, result, expected, settled] of cases) {
    const rendered = lines(
      agentToolRenderers(operation).renderResult(
        result,
        { expanded: false, isPartial: true },
        plainTheme,
        context({}, { isPartial: true }),
      ),
      80,
    ).join("\n");
    assert.match(rendered, expected);
    assert.doesNotMatch(rendered, settled);
  }
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

test("collection rendering follows the declared tone and fits whole clauses by priority", () => {
  const details = {
    kind: "collection" as const,
    scope: "named" as const,
    runs: [
      {
        runId: "run-1",
        agent: "explore",
        status: "completed" as const,
        output: { kind: "visible" as const, characters: 6 },
      },
    ],
    stillRunning: 2,
    unknown: 1,
    unavailable: 1,
    noActiveRuns: false as const,
  };
  const presentation = collectionRowPresentation(details);
  const pair = agentToolRenderers("wait");
  const render = (theme: RenderableTheme, width: number) =>
    lines(
      pair.renderResult(
        {
          content: [{ type: "text", text: "complete response" }],
          details,
        },
        { expanded: false, isPartial: false },
        theme,
        context({}),
      ),
      width,
    ).join("\n");

  const toned = render(markedTheme, 160);
  assert.match(toned, /^<toolOutput>/);
  assert.match(toned, /<\/toolOutput>/);

  const summaries = [120, 60, 45].map((width) => {
    const rendered = render(plainTheme, width);
    assert.ok(visibleWidth(rendered) <= width);
    return rendered.replace(/ \(.*to expand\)$/, "");
  });
  assert.equal(summaries[0], presentation.clauses.join(presentation.separator));
  assert.ok(summaries[1].length < summaries[0].length);
  assert.equal(summaries[2], presentation.priority[0]);
  for (const summary of summaries) {
    for (const clause of summary.split(presentation.separator)) {
      assert.ok(presentation.clauses.includes(clause));
    }
  }

  const idle = {
    kind: "collection" as const,
    scope: "all-active" as const,
    runs: [],
    stillRunning: 0,
    unknown: 0,
    unavailable: 0,
    noActiveRuns: true as const,
  };
  const idleRow = lines(
    agentToolRenderers("waitAll").renderResult(
      { content: [{ type: "text", text: "idle" }], details: idle },
      { expanded: false, isPartial: false },
      markedTheme,
      context({}),
    ),
    120,
  ).join("\n");
  assert.match(idleRow, /^<toolOutput>/);
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
        output: { kind: "visible" as const, characters: 17 },
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
