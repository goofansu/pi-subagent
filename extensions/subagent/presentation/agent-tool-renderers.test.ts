import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
  type AgentToolRendererState,
  agentToolRenderers,
  formatCancellationSummary,
  formatStartedRunSummary,
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
