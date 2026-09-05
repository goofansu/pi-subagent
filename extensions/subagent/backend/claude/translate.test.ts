import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunObservation } from "../../domain/index.ts";
import {
  claudeContextGauge,
  claudeCumulativeUsage,
  claudeUsageDelta,
  createClaudeTranslator,
  isClaudeIdentity,
  readClaudeFrame,
  ZERO_CUMULATIVE_USAGE,
} from "./translate.ts";

/**
 * Translation, from recorded frame shapes.
 *
 * The frames below are the shapes the M0 spike actually saw, trimmed to the
 * fields the adapter reads. They are recorded rather than generated from the
 * SDK's types on purpose: what this module has to survive is the wire, and a
 * fixture built from the declared type would agree with the declared type by
 * construction.
 */

const IDENTITY = "ba5a6f16-1b4e-4c8a-9f3d-2b7c1e5a9d40";

function translate(frames: readonly unknown[]): {
  readonly observations: readonly RunObservation[];
  readonly turns: number;
  readonly primaryModel: string | undefined;
} {
  const translator = createClaudeTranslator();
  const observations: RunObservation[] = [];
  for (const frame of frames) {
    observations.push(...translator.frame(readClaudeFrame(frame)).observations);
  }
  return {
    observations,
    turns: translator.turns(),
    primaryModel: translator.primaryModel(),
  };
}

function initFrame(model = "claude-sonnet-4-6"): unknown {
  return {
    type: "system",
    subtype: "init",
    model,
    cwd: "/work",
    session_id: IDENTITY,
    uuid: "11111111-1111-4111-8111-111111111111",
  };
}

function assistantFrame(
  overrides: {
    readonly id?: string;
    readonly content?: unknown;
    readonly model?: string;
    readonly parentToolUseId?: string | null;
    readonly subagentType?: string;
  } = {},
): unknown {
  return {
    type: "assistant",
    message: {
      id: overrides.id ?? "msg_1",
      model: overrides.model ?? "claude-sonnet-4-6",
      role: "assistant",
      content: overrides.content ?? [{ type: "text", text: "the answer" }],
    },
    parent_tool_use_id: overrides.parentToolUseId ?? null,
    ...(overrides.subagentType === undefined
      ? {}
      : { subagent_type: overrides.subagentType }),
    session_id: IDENTITY,
    uuid: "22222222-2222-4222-8222-222222222222",
  };
}

function modelUsage(
  entries: Readonly<
    Record<
      string,
      {
        readonly input?: number;
        readonly output?: number;
        readonly cacheRead?: number;
        readonly cacheWrite?: number;
        readonly cost?: number;
        readonly window?: number;
      }
    >
  >,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).map(([model, value]) => [
      model,
      {
        inputTokens: value.input ?? 0,
        outputTokens: value.output ?? 0,
        cacheReadInputTokens: value.cacheRead ?? 0,
        cacheCreationInputTokens: value.cacheWrite ?? 0,
        webSearchRequests: 0,
        costUSD: value.cost ?? 0,
        contextWindow: value.window ?? 200_000,
        maxOutputTokens: 64_000,
      },
    ]),
  );
}

function resultFrame(
  overrides: {
    readonly text?: string;
    readonly isError?: boolean;
    readonly numTurns?: number;
    readonly usage?: Record<string, unknown>;
    readonly cost?: number;
    readonly correlation?: string;
  } = {},
): unknown {
  return {
    type: "result",
    subtype: overrides.isError ? "error_during_execution" : "success",
    duration_ms: 7_643,
    duration_api_ms: 7_000,
    is_error: overrides.isError === true,
    num_turns: overrides.numTurns ?? 1,
    result: overrides.text ?? "the answer",
    stop_reason: "end_turn",
    total_cost_usd: overrides.cost ?? 0,
    usage: {},
    modelUsage: overrides.usage ?? modelUsage({ "claude-sonnet-4-6": {} }),
    permission_denials: [],
    errors: [],
    session_id: IDENTITY,
    uuid: "33333333-3333-4333-8333-333333333333",
    ...(overrides.correlation === undefined
      ? {}
      : { user_message_uuid: overrides.correlation }),
  };
}

/* ---- reading a frame ---- */

test("each frame kind is read as itself, and everything else is ignored", () => {
  assert.equal(readClaudeFrame(initFrame()).kind, "init");
  assert.equal(readClaudeFrame(assistantFrame()).kind, "assistant");
  assert.equal(readClaudeFrame(resultFrame()).kind, "result");
  assert.equal(
    readClaudeFrame({ type: "rate_limit_event", session_id: IDENTITY }).kind,
    "other",
  );
  assert.equal(readClaudeFrame(undefined).kind, "other");
});

test("the init frame and every result frame are identity boundaries", () => {
  assert.equal(readClaudeFrame(initFrame()).isIdentityBoundary, true);
  assert.equal(readClaudeFrame(resultFrame()).isIdentityBoundary, true);
  assert.equal(readClaudeFrame(assistantFrame()).isIdentityBoundary, false);
});

test("a replay-flagged frame says so", () => {
  const replayed = { ...(assistantFrame() as object), isReplay: true };

  assert.equal(readClaudeFrame(replayed).isReplay, true);
  assert.equal(readClaudeFrame(assistantFrame()).isReplay, false);
});

test("a tool-result user frame is told apart from a steering echo", () => {
  const echo = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "also do X" }] },
    parent_tool_use_id: null,
    uuid: "44444444-4444-4444-8444-444444444444",
    session_id: IDENTITY,
  };
  const toolResult = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "40 lines" },
      ],
    },
    parent_tool_use_id: null,
    uuid: "55555555-5555-4555-8555-555555555555",
    session_id: IDENTITY,
  };

  assert.equal(readClaudeFrame(echo).isToolResult, false);
  assert.equal(
    readClaudeFrame(echo).uuid,
    "44444444-4444-4444-8444-444444444444",
  );
  assert.equal(readClaudeFrame(toolResult).isToolResult, true);
});

test("a result frame's correlation and error flag are read", () => {
  const reading = readClaudeFrame(
    resultFrame({ isError: true, correlation: "an-input-uuid" }),
  );

  assert.equal(reading.isError, true);
  assert.equal(reading.correlation, "an-input-uuid");
});

test("a conversation identity is checked, not trusted", () => {
  assert.equal(isClaudeIdentity(IDENTITY), true);
  assert.equal(isClaudeIdentity(IDENTITY.toUpperCase()), true);
  assert.equal(isClaudeIdentity("not-a-uuid"), false);
  assert.equal(isClaudeIdentity(""), false);
  assert.equal(isClaudeIdentity(undefined), false);
  assert.equal(isClaudeIdentity(7), false);
});

/* ---- messages and tools ---- */

test("the init frame names the model, so a Run that fails before answering still says what it ran", () => {
  const { observations, primaryModel } = translate([
    initFrame("claude-opus-4-7"),
  ]);

  assert.deepEqual(observations, [{ kind: "model", model: "claude-opus-4-7" }]);
  assert.equal(primaryModel, "claude-opus-4-7");
});

test("an init frame with no model produces nothing", () => {
  assert.deepEqual(
    translate([{ type: "system", subtype: "init", session_id: IDENTITY }])
      .observations,
    [],
  );
});

test("an assistant frame becomes a message carrying its model", () => {
  const { observations } = translate([assistantFrame()]);

  assert.deepEqual(observations, [
    {
      kind: "message",
      role: "assistant",
      parts: [{ kind: "text", text: "the answer" }],
      model: "claude-sonnet-4-6",
    },
    { kind: "usage", usage: { turns: 1 } },
  ]);
});

test("a tool-use block carries the native id, so the entry merges by call id", () => {
  const { observations } = translate([
    assistantFrame({
      content: [
        { type: "text", text: "reading it" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "/work/presentation/rows.ts" },
        },
      ],
    }),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "40 lines" },
        ],
      },
      parent_tool_use_id: null,
      session_id: IDENTITY,
      uuid: "66666666-6666-4666-8666-666666666666",
    },
  ]);

  assert.deepEqual(observations, [
    {
      kind: "message",
      role: "assistant",
      parts: [
        { kind: "text", text: "reading it" },
        { kind: "tool_call", name: "Read", callId: "toolu_1" },
      ],
      model: "claude-sonnet-4-6",
    },
    { kind: "usage", usage: { turns: 1 } },
    { kind: "activity", activity: "Read: presentation/rows.ts" },
    {
      kind: "message",
      role: "tool",
      parts: [{ kind: "text", text: "40 lines" }],
    },
    {
      kind: "tool_progress",
      callId: "toolu_1",
      status: "completed",
      outputSummary: "40 lines",
    },
  ]);
});

test("Claude shell, path, and pattern tools carry their key argument", () => {
  const cases = [
    [
      "Bash",
      { command: "  npm   test  \nignored second line" },
      "Bash: npm test",
    ],
    [
      "Edit",
      { file_path: "/work/presentation/rows.ts" },
      "Edit: presentation/rows.ts",
    ],
    [
      "Write",
      { file_path: "backend/activity.ts" },
      "Write: backend/activity.ts",
    ],
    ["Grep", { pattern: "  getFinalOutput\\s+  " }, "Grep: getFinalOutput\\s+"],
    ["Glob", { pattern: "**/*.test.ts" }, "Glob: **/*.test.ts"],
  ] as const;

  for (const [name, input, activity] of cases) {
    const translated = translate([
      assistantFrame({
        content: [{ type: "tool_use", id: "toolu_kind", name, input }],
      }),
    ]).observations;
    assert.deepEqual(
      translated.filter((one) => one.kind === "activity"),
      [{ kind: "activity", activity }],
    );
  }
});

test("an unknown Claude tool uses its first string input or its bare name", () => {
  const detailed = translate([
    assistantFrame({
      content: [
        {
          type: "tool_use",
          id: "toolu_mcp",
          name: "mcp__tracker__search",
          input: { limit: 10, query: "  open   incidents  ", after: "cursor" },
        },
      ],
    }),
  ]).observations;
  assert.deepEqual(detailed.at(-1), {
    kind: "activity",
    activity: "mcp__tracker__search: open incidents",
  });

  for (const block of [
    { type: "tool_use", id: "toolu_empty", name: "mcp__tracker__refresh" },
    {
      type: "tool_use",
      id: "toolu_invalid",
      name: "Bash",
      input: { command: 42, fallback: "not the key argument" },
    },
  ]) {
    const observations = translate([
      assistantFrame({ content: [block] }),
    ]).observations;
    assert.deepEqual(observations.at(-1), {
      kind: "activity",
      activity: block.name,
    });
  }
});

test("Claude tool activity is capped before it becomes an observation", () => {
  const observations = translate([
    assistantFrame({
      content: [
        {
          type: "tool_use",
          id: "toolu_long",
          name: "Bash",
          input: { command: "x".repeat(200) },
        },
      ],
    }),
  ]).observations;

  assert.deepEqual(observations.at(-1), {
    kind: "activity",
    activity: `Bash: ${"x".repeat(114)}`,
  });
});

test("a nested sidechain tool-use block does not report root activity", () => {
  for (const sidechain of [
    { parentToolUseId: "toolu_parent" },
    { subagentType: "explore" },
  ]) {
    const observations = translate([
      assistantFrame({
        ...sidechain,
        content: [
          {
            type: "tool_use",
            id: "toolu_nested",
            name: "Read",
            input: { file_path: "/work/private/notes.md" },
          },
        ],
      }),
    ]).observations;
    assert.deepEqual(
      observations.filter((one) => one.kind === "activity"),
      [],
    );
  }
});

test("a failed tool result is a failed completion", () => {
  const { observations } = translate([
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "no such file",
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: IDENTITY,
      uuid: "77777777-7777-4777-8777-777777777777",
    },
  ]);

  assert.deepEqual(
    observations.filter((one) => one.kind === "tool_progress"),
    [
      {
        kind: "tool_progress",
        callId: "toolu_2",
        status: "failed",
        outputSummary: "no such file",
      },
    ],
  );
});

test("a tool result with no tool-use id produces no progress, because none could be joined", () => {
  const { observations } = translate([
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "orphaned" }],
      },
      parent_tool_use_id: null,
      session_id: IDENTITY,
      uuid: "88888888-8888-4888-8888-888888888888",
    },
  ]);

  assert.deepEqual(
    observations.map((one) => one.kind),
    ["message"],
  );
});

test("a thinking-only assistant frame still carries its model", () => {
  const { observations } = translate([
    assistantFrame({
      content: [{ type: "thinking", thinking: "private reasoning" }],
    }),
  ]);

  assert.deepEqual(observations, [
    {
      kind: "message",
      role: "assistant",
      parts: [],
      model: "claude-sonnet-4-6",
    },
    { kind: "usage", usage: { turns: 1 } },
  ]);
});

test("the result's text answers only when the last assistant frame did not", () => {
  const answered = translate([
    assistantFrame({ content: [{ type: "text", text: "the answer" }] }),
    resultFrame({ text: "the answer" }),
  ]);
  assert.deepEqual(
    answered.observations.filter((one) => one.kind === "message").length,
    1,
  );

  const toolOnly = translate([
    assistantFrame({
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
    }),
    resultFrame({ text: "the command printed 3" }),
  ]);
  assert.deepEqual(
    toolOnly.observations.filter((one) => one.kind === "message").at(-1),
    {
      kind: "message",
      role: "assistant",
      parts: [{ kind: "text", text: "the command printed 3" }],
      model: "claude-sonnet-4-6",
    },
  );
});

test("an error result contributes no answer text", () => {
  const { observations } = translate([
    resultFrame({ isError: true, text: "the provider said something" }),
  ]);

  assert.deepEqual(
    observations.filter((one) => one.kind === "message"),
    [],
  );
});

/* ---- usage ---- */

test("every model the Query pipeline ran is charged", () => {
  const summed = claudeCumulativeUsage(
    resultFrame({
      usage: modelUsage({
        "claude-sonnet-4-6": { input: 100, output: 40, cost: 0.01 },
        "claude-haiku-4-5": { input: 20, output: 5, cost: 0.001 },
      }),
      cost: 0,
    }) as Record<string, unknown>,
  );

  assert.equal(summed.input, 120);
  assert.equal(summed.output, 45);
});

test("the frame's own total cost wins over the per-model sum", () => {
  const summed = claudeCumulativeUsage(
    resultFrame({
      usage: modelUsage({ "claude-sonnet-4-6": { cost: 0.01 } }),
      cost: 0.5,
    }) as Record<string, unknown>,
  );

  assert.equal(summed.cost, 0.5);
});

test("a frame with no per-model usage sums to nothing rather than failing", () => {
  assert.deepEqual(
    claudeCumulativeUsage({ type: "result" }),
    ZERO_CUMULATIVE_USAGE,
  );
});

test("two result frames in one Run are differenced, not summed", () => {
  const { observations } = translate([
    initFrame(),
    resultFrame({
      usage: modelUsage({ "claude-sonnet-4-6": { input: 100, output: 40 } }),
      cost: 0.01,
      numTurns: 1,
    }),
    resultFrame({
      usage: modelUsage({ "claude-sonnet-4-6": { input: 180, output: 65 } }),
      cost: 0.03,
      numTurns: 2,
    }),
  ]);
  const deltas = observations
    .filter((one) => one.kind === "usage")
    .map((one) => (one.kind === "usage" ? one.usage : {}));

  assert.equal(deltas[0].input, 100);
  assert.equal(deltas[0].output, 40);
  assert.equal(deltas[1].input, 80);
  assert.equal(deltas[1].output, 25);
  assert.ok(Math.abs((deltas[1].cost ?? 0) - 0.02) < 1e-9);
});

test("a provider reset charges the new reading rather than a negative delta", () => {
  const delta = claudeUsageDelta(
    { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    { input: 100, output: 40, cacheRead: 5, cacheWrite: 5, cost: 0.01 },
  );

  assert.deepEqual(delta, {
    input: 10,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.001,
  });
});

test("every delta field is nonnegative", () => {
  const delta = claudeUsageDelta(
    { input: 100, output: 40, cacheRead: 5, cacheWrite: 5, cost: 0.01 },
    { input: 100, output: 40, cacheRead: 5, cacheWrite: 5, cost: 0.01 },
  );

  assert.deepEqual(delta, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
});

/* ---- the context gauge ---- */

test("the gauge is the primary model's own tokens over its own window", () => {
  const gauge = claudeContextGauge(
    resultFrame({
      usage: modelUsage({
        "claude-sonnet-4-6": {
          input: 900,
          cacheRead: 935,
          cacheWrite: 65,
          window: 200_000,
        },
        "claude-haiku-4-5": { input: 5_000, window: 100 },
      }),
    }) as Record<string, unknown>,
    "claude-sonnet-4-6",
  );

  assert.deepEqual(gauge, { tokens: 1_900, window: 200_000 });
});

test("the gauge is omitted when the primary model has no entry", () => {
  assert.equal(
    claudeContextGauge(
      resultFrame({
        usage: modelUsage({ "claude-haiku-4-5": { input: 20 } }),
      }) as Record<string, unknown>,
      "claude-sonnet-4-6",
    ),
    undefined,
  );
});

test("the gauge is omitted when the entry carries no context window", () => {
  // A denominator-less figure would be exactly the sum a gauge exists not to
  // be: these tokens are cumulative across the turns of the Query, so without
  // a window to read them against they say nothing about occupancy.
  assert.equal(
    claudeContextGauge(
      {
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      },
      "claude-sonnet-4-6",
    ),
    undefined,
  );
  assert.equal(
    claudeContextGauge(
      {
        modelUsage: {
          "claude-sonnet-4-6": { inputTokens: 500, contextWindow: 0 },
        },
      },
      "claude-sonnet-4-6",
    ),
    undefined,
  );
});

test("an assistant frame with nothing readable counts its turn and reports no message", () => {
  // Near-unreachable in practice, because the SDK always names the model on
  // the message. What matters is that neither half is lost: no blank
  // transcript item, and the turn still counted.
  const { observations, turns } = translate([
    {
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [] },
      parent_tool_use_id: null,
      session_id: IDENTITY,
    },
  ]);

  assert.deepEqual(observations, [{ kind: "usage", usage: { turns: 1 } }]);
  assert.equal(turns, 1);
});

test("the gauge is omitted when no model has been named yet", () => {
  assert.equal(
    claudeContextGauge(resultFrame() as Record<string, unknown>, undefined),
    undefined,
  );
});

test("an entry keyed by a provider-specific id is found by its canonical model", () => {
  const gauge = claudeContextGauge(
    {
      modelUsage: {
        "bedrock/anthropic.claude-sonnet-4-6-v1": {
          inputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200_000,
          canonicalModel: "claude-sonnet-4-6",
        },
      },
    },
    "claude-sonnet-4-6",
  );

  assert.deepEqual(gauge, { tokens: 500, window: 200_000 });
});

/* ---- turns ---- */

test("several assistant frames sharing one message id are one turn", () => {
  const { turns } = translate([
    assistantFrame({ id: "msg_1", content: [{ type: "text", text: "one " }] }),
    assistantFrame({ id: "msg_1", content: [{ type: "text", text: "two" }] }),
  ]);

  assert.equal(turns, 1);
});

test("a tool-parented assistant frame is a sidechain, not a turn", () => {
  const { turns } = translate([
    assistantFrame({ id: "msg_side", parentToolUseId: "toolu_1" }),
  ]);

  assert.equal(turns, 0);
});

test("an assistant frame carrying a subagent type is a sidechain, not a turn", () => {
  const { turns } = translate([
    assistantFrame({ id: "msg_side", subagentType: "explore" }),
  ]);

  assert.equal(turns, 0);
});

test("an assistant frame with no message id is not counted", () => {
  const { turns } = translate([
    {
      type: "assistant",
      message: { role: "assistant", content: [], model: "claude-sonnet-4-6" },
      parent_tool_use_id: null,
      session_id: IDENTITY,
    },
  ]);

  assert.equal(turns, 0);
});

test("the result's reported total may raise the count", () => {
  const { turns, observations } = translate([
    assistantFrame({ id: "msg_1" }),
    resultFrame({ numTurns: 3 }),
  ]);
  const deltas = observations
    .filter((one) => one.kind === "usage")
    .map((one) => (one.kind === "usage" ? one.usage.turns : undefined));

  assert.equal(turns, 3);
  assert.deepEqual(deltas, [1, 2]);
});

test("the result's reported total never lowers the count", () => {
  const { turns, observations } = translate([
    assistantFrame({ id: "msg_1" }),
    assistantFrame({ id: "msg_2" }),
    resultFrame({ numTurns: 1 }),
  ]);
  const raised = observations
    .filter((one) => one.kind === "usage")
    .map((one) => (one.kind === "usage" ? one.usage.turns : undefined));

  assert.equal(turns, 2);
  assert.deepEqual(raised, [1, 1, undefined]);
});

test("a nonsense reported total is ignored", () => {
  const { turns } = translate([
    assistantFrame({ id: "msg_1" }),
    { ...(resultFrame() as object), num_turns: -4 },
  ]);

  assert.equal(turns, 1);
});
