import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunObservation } from "../../domain/index.ts";
import type {
  CodexItem,
  CodexNotification,
  CodexTokenBreakdown,
} from "./protocol.ts";
import {
  ACTIVITY_LIMIT,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_PROVIDER_ERROR_CATEGORY,
  CODEX_WEB_SEARCH_TOOL_NAME,
  codexCommandOf,
  codexContextGauge,
  codexItemActivity,
  codexMessagePreview,
  codexToolName,
  codexUsageDelta,
  codexUsageReset,
  createCodexTranslator,
  latestToolCall,
  ZERO_CODEX_USAGE,
} from "./translate.ts";

/**
 * Translation, from the notification shapes the spike and v1's fixtures
 * recorded.
 *
 * Pure and Run-local: a translator is built per execution, so the numbers here
 * are the numbers a Run would be charged. The two things worth reading the
 * assertions for are the commentary-versus-final rule, which is what makes an
 * answer survive a cancel, and the usage differencing across two Runs, which
 * is what stops a resumed Run being charged for the conversation before it.
 */

const CWD = "/work";

function translator(baseline?: CodexTokenBreakdown) {
  const seen: CodexTokenBreakdown[] = [];
  const built = createCodexTranslator({
    cwd: CWD,
    ...(baseline === undefined ? {} : { baseline }),
    onCumulative: (total) => seen.push(total),
  });
  return { built, cumulative: () => seen };
}

function usage(
  total: Partial<CodexTokenBreakdown>,
  last?: Partial<CodexTokenBreakdown>,
  window?: number,
): CodexNotification {
  const fill = (
    partial: Partial<CodexTokenBreakdown>,
  ): CodexTokenBreakdown => ({
    ...ZERO_CODEX_USAGE,
    ...partial,
  });
  return {
    method: "thread/tokenUsage/updated",
    turnId: "turn-1",
    total: fill(total),
    last: fill(last ?? total),
    ...(window === undefined ? {} : { contextWindow: window }),
  };
}

function started(item: CodexItem): CodexNotification {
  return { method: "item/started", turnId: "turn-1", item };
}

function completed(item: CodexItem): CodexNotification {
  return { method: "item/completed", turnId: "turn-1", item };
}

type CodexCommandItem = Extract<
  CodexItem,
  { readonly type: "commandExecution" }
>;

function command(
  id: string,
  overrides: Partial<Omit<CodexCommandItem, "type" | "id">> = {},
): CodexCommandItem {
  return {
    type: "commandExecution",
    id,
    command: "ls -la",
    cwd: CWD,
    status: "inProgress",
    ...overrides,
  };
}

function observations(
  notifications: readonly CodexNotification[],
  baseline?: CodexTokenBreakdown,
): readonly RunObservation[] {
  const built = createCodexTranslator({
    cwd: CWD,
    ...(baseline === undefined ? {} : { baseline }),
  });
  return notifications.flatMap(
    (notification) => built.notification(notification).observations,
  );
}

/* ---- items as tools ---- */

test("the four tool-shaped items each produce a tool call and its progress", () => {
  const cases: readonly [CodexItem, string][] = [
    [command("c1"), CODEX_COMMAND_TOOL_NAME],
    [
      {
        type: "fileChange",
        id: "f1",
        changes: [{ path: "/work/a.ts", diff: "@@" }],
      },
      CODEX_FILE_CHANGE_TOOL_NAME,
    ],
    [
      { type: "mcpToolCall", id: "x1", server: "docs", tool: "search" },
      "search",
    ],
    [
      { type: "webSearch", id: "w1", query: "effect schema" },
      CODEX_WEB_SEARCH_TOOL_NAME,
    ],
  ];

  for (const [item, name] of cases) {
    const emitted = observations([started(item)]);
    assert.deepEqual(
      emitted.filter((observation) => observation.kind !== "activity"),
      [
        {
          kind: "message",
          role: "assistant",
          parts: [{ kind: "tool_call", name, callId: item.id }],
        },
        { kind: "tool_progress", callId: item.id, status: "running" },
      ],
      `${item.type} did not read as a tool call`,
    );
    assert.equal(codexToolName(item), name);
  }
});

test("an item that is not a tool call reports no progress, only activity", () => {
  // A plan or a reasoning summary is not a tool. Reporting progress for one
  // would put a nameless entry in the Run's tool list, because a progress
  // update creates an entry when it can join nothing.
  for (const item of [
    { type: "reasoning", id: "r1" } as CodexItem,
    { type: "plan", id: "p1", text: "do a, then b" } as CodexItem,
  ]) {
    const emitted = observations([started(item), completed(item)]);
    assert.deepEqual(
      emitted.map((observation) => observation.kind),
      ["activity"],
      `${item.type} reported tool progress`,
    );
    assert.equal(codexToolName(item), undefined);
  }
});

test("a completed command reports its status and a bounded output summary", () => {
  const emitted = observations([
    completed(
      command("c1", {
        status: "completed",
        aggregatedOutput: "  total 4\n  a.ts  ",
      }),
    ),
  ]);

  assert.deepEqual(emitted, [
    {
      kind: "tool_progress",
      callId: "c1",
      status: "completed",
      outputSummary: "total 4 a.ts",
    },
  ]);
});

test("a command that failed or was declined reports as failed", () => {
  for (const status of ["failed", "declined"] as const) {
    assert.deepEqual(observations([completed(command("c1", { status }))]), [
      { kind: "tool_progress", callId: "c1", status: "failed" },
    ]);
  }
});

test("the command a command-execution item is really running wins", () => {
  // v1's rule: the resolved action's command is the one a reader recognizes,
  // and the item's own `command` is often the shell wrapper around it.
  assert.equal(
    codexCommandOf({
      type: "commandExecution",
      id: "c1",
      command: "bash -lc 'npm test'",
      cwd: CWD,
      status: "inProgress",
      commandActions: [{ type: "run", command: "npm test" }],
    }),
    "npm test",
  );
  assert.equal(codexCommandOf(command("c1")), "ls -la");
});

/* ---- agent messages, and the rule that makes an answer stick ---- */

test("a completed agent message whose phase is not commentary is the answer", () => {
  for (const phase of ["final_answer", undefined]) {
    const built = createCodexTranslator({ cwd: CWD });
    const translation = built.notification(
      completed({
        type: "agentMessage",
        id: "m1",
        text: "the answer",
        ...(phase === undefined ? {} : { phase }),
      }),
    );

    assert.equal(translation.finalAnswer, true, `phase ${phase} was not final`);
    assert.equal(built.sawFinalAnswer(), true);
    assert.deepEqual(translation.observations, [
      {
        kind: "message",
        role: "assistant",
        parts: [{ kind: "text", text: "the answer" }],
      },
    ]);
  }
});

test("a commentary message is a message and not the answer", () => {
  const built = createCodexTranslator({ cwd: CWD });

  const translation = built.notification(
    completed({
      type: "agentMessage",
      id: "m1",
      text: "thinking out loud",
      phase: "commentary",
    }),
  );

  assert.equal(translation.finalAnswer, false);
  assert.equal(built.sawFinalAnswer(), false);
  assert.equal(translation.observations.length, 1);
});

test("commentary followed by a final answer leaves the Run answered", () => {
  const built = createCodexTranslator({ cwd: CWD });

  built.notification(
    completed({
      type: "agentMessage",
      id: "m1",
      text: "aside",
      phase: "commentary",
    }),
  );
  built.notification(
    completed({
      type: "agentMessage",
      id: "m2",
      text: "answer",
      phase: "final_answer",
    }),
  );

  assert.equal(built.sawFinalAnswer(), true);
});

test("an agent message with no text is a message with no parts", () => {
  assert.deepEqual(
    observations([completed({ type: "agentMessage", id: "m1", text: "" })]),
    [{ kind: "message", role: "assistant", parts: [] }],
  );
});

/* ---- deltas become bounded activity ---- */

test("a message delta previews the tail's last sentence", () => {
  const emitted = observations([
    {
      method: "item/agentMessage/delta",
      turnId: "turn-1",
      itemId: "m1",
      delta: "First thought. Then the second one.",
    },
  ]);

  assert.deepEqual(emitted, [
    { kind: "activity", activity: "Then the second one." },
  ]);
});

test("a message delta with nothing previewable still says something", () => {
  assert.deepEqual(
    observations([
      {
        method: "item/agentMessage/delta",
        turnId: "turn-1",
        itemId: "m1",
        delta: "```",
      },
    ]),
    [{ kind: "activity", activity: "Writing response…" }],
  );
});

test("activity is bounded however much the provider streams", () => {
  const built = createCodexTranslator({ cwd: CWD });

  const translation = built.notification({
    method: "item/agentMessage/delta",
    turnId: "turn-1",
    itemId: "m1",
    delta: "word ".repeat(4_000),
  });

  const [observation] = translation.observations;
  assert.equal(observation?.kind, "activity");
  if (observation?.kind !== "activity") return;
  assert.ok((observation.activity ?? "").length <= ACTIVITY_LIMIT);
});

test("a command's output delta shows the command and its latest line", () => {
  const built = createCodexTranslator({ cwd: CWD });
  built.notification(started(command("c1", { command: "npm test" })));

  const translation = built.notification({
    method: "item/commandExecution/outputDelta",
    turnId: "turn-1",
    itemId: "c1",
    delta: "compiling\r\nrunning 12 tests\n",
  });

  assert.deepEqual(translation.observations, [
    { kind: "activity", activity: "$ npm test · running 12 tests" },
  ]);
});

test("an output delta with no line yet produces nothing", () => {
  assert.deepEqual(
    observations([
      {
        method: "item/commandExecution/outputDelta",
        turnId: "turn-1",
        itemId: "c1",
        delta: "   \n",
      },
    ]),
    [],
  );
});

test("a reasoning summary shows its headline", () => {
  assert.deepEqual(
    observations([
      {
        method: "item/reasoning/summaryTextDelta",
        turnId: "turn-1",
        itemId: "r1",
        delta: "**Reading the test file**\nthen the rest",
      },
    ]),
    [{ kind: "activity", activity: "Reading the test file" }],
  );
});

test("item activity names what each item kind is doing", () => {
  assert.equal(codexItemActivity(command("c1"), CWD), "$ ls -la");
  assert.equal(
    codexItemActivity(
      {
        type: "fileChange",
        id: "f1",
        changes: [{ path: "/work/src/a.ts", diff: "@@" }],
      },
      CWD,
    ),
    "Editing src/a.ts",
  );
  assert.equal(
    codexItemActivity({ type: "reasoning", id: "r1" }, CWD),
    "Thinking…",
  );
  assert.equal(
    codexItemActivity({ type: "plan", id: "p1", text: "x" }, CWD),
    "Planning…",
  );
  assert.equal(
    codexItemActivity({ type: "webSearch", id: "w1", query: "effect" }, CWD),
    "Searching: effect",
  );
  assert.equal(
    codexItemActivity(
      { type: "mcpToolCall", id: "x", server: "s", tool: "find" },
      CWD,
    ),
    "Calling find…",
  );
  assert.equal(
    codexItemActivity({ type: "agentMessage", id: "m", text: "t" }, CWD),
    undefined,
  );
});

test("a message preview drops markdown decoration and fence lines", () => {
  assert.equal(codexMessagePreview("## A heading"), "A heading");
  assert.equal(codexMessagePreview("- a bullet"), "a bullet");
  assert.equal(codexMessagePreview("`code` in prose."), "code in prose.");
  assert.equal(codexMessagePreview("```ts"), undefined);
  assert.equal(codexMessagePreview("   "), undefined);
});

/* ---- usage ---- */

test("a usage frame emits the increment since the Turn's baseline", () => {
  const { built, cumulative } = translator({
    ...ZERO_CODEX_USAGE,
    totalTokens: 1_000,
    inputTokens: 900,
    outputTokens: 100,
  });

  const translation = built.notification(
    usage(
      {
        totalTokens: 1_150,
        inputTokens: 1_000,
        outputTokens: 140,
        reasoningOutputTokens: 10,
      },
      { totalTokens: 150 },
      50_000,
    ),
  );

  assert.deepEqual(translation.observations, [
    // Reasoning output is output the provider itemized, so it is folded in.
    {
      kind: "usage",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    },
    { kind: "context", context: { tokens: 150, window: 50_000 } },
  ]);
  assert.deepEqual(cumulative(), [
    {
      ...ZERO_CODEX_USAGE,
      totalTokens: 1_150,
      inputTokens: 1_000,
      outputTokens: 140,
      reasoningOutputTokens: 10,
    },
  ]);
});

test("two usage frames in one Turn are differenced, not summed twice", () => {
  const built = createCodexTranslator({ cwd: CWD });

  const first = built.notification(
    usage({ inputTokens: 100, outputTokens: 10 }),
  );
  const second = built.notification(
    usage({ inputTokens: 180, outputTokens: 25 }),
  );

  assert.deepEqual(first.observations[0], {
    kind: "usage",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
  });
  // The core sums these, so the Turn's charge is 180 in and 25 out — the
  // provider's own latest cumulative reading, and not 280.
  assert.deepEqual(second.observations[0], {
    kind: "usage",
    usage: { input: 80, output: 15, cacheRead: 0, cacheWrite: 0 },
  });
});

test("a resumed Run's baseline excludes the Run before it", () => {
  const first = translator();
  first.built.notification(usage({ inputTokens: 1_000, outputTokens: 100 }));
  const carried = first.cumulative().at(-1);
  assert.ok(carried);
  if (!carried) return;

  const second = createCodexTranslator({ cwd: CWD, baseline: carried });
  const translation = second.notification(
    usage({ inputTokens: 1_400, outputTokens: 160 }),
  );

  // The second Run is charged 400 and 60, not 1,400 and 160. `total` is
  // conversation-cumulative, so without the baseline a resumed Run would be
  // billed for the whole thread.
  assert.deepEqual(translation.observations[0], {
    kind: "usage",
    usage: { input: 400, output: 60, cacheRead: 0, cacheWrite: 0 },
  });
});

test("a provider reset on the Turn's first frame charges the new reading", () => {
  const built = createCodexTranslator({
    cwd: CWD,
    baseline: { ...ZERO_CODEX_USAGE, inputTokens: 5_000, totalTokens: 5_000 },
  });

  const translation = built.notification(
    usage({ inputTokens: 40, totalTokens: 40 }),
  );

  // A negative delta is not available and dropping the frame would lose real
  // spend, so a smaller reading than the baseline is charged in full.
  assert.deepEqual(translation.observations[0], {
    kind: "usage",
    usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
});

test("a smaller reading later in the same Turn is a floor, not a reset", () => {
  const built = createCodexTranslator({ cwd: CWD });
  built.notification(usage({ inputTokens: 500 }));

  const translation = built.notification(usage({ inputTokens: 200 }));

  // Within a Turn the cumulative figures only grow, so this cannot be a
  // reset; the honest answer is to charge nothing rather than a negative.
  assert.deepEqual(translation.observations[0], {
    kind: "usage",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
});

test("the delta and the reset test are readable on their own", () => {
  assert.deepEqual(
    codexUsageDelta(
      {
        ...ZERO_CODEX_USAGE,
        inputTokens: 10,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 2,
      },
      ZERO_CODEX_USAGE,
    ),
    { input: 10, output: 0, cacheRead: 4, cacheWrite: 2 },
  );
  assert.equal(
    codexUsageReset(
      { ...ZERO_CODEX_USAGE, inputTokens: 1 },
      { ...ZERO_CODEX_USAGE, inputTokens: 2 },
    ),
    true,
  );
  assert.equal(
    codexUsageReset(
      { ...ZERO_CODEX_USAGE, inputTokens: 3 },
      { ...ZERO_CODEX_USAGE, inputTokens: 2 },
    ),
    false,
  );
});

test("the context gauge is the last request's total, and its window when there is one", () => {
  // Deliberately `last` rather than the cumulative `total`: occupancy is what
  // the model is carrying right now and is bounded by the window, while
  // `total` is what the whole conversation has been billed and grows without
  // bound. A gauge built from the cumulative figure would exceed its own
  // denominator after two Turns.
  assert.deepEqual(
    codexContextGauge({ ...ZERO_CODEX_USAGE, totalTokens: 16_858 }, 272_000),
    { tokens: 16_858, window: 272_000 },
  );
  assert.deepEqual(codexContextGauge(ZERO_CODEX_USAGE, undefined), {
    tokens: 0,
  });
});

/* ---- errors and the completion frame ---- */

test("a retrying provider error is activity, and a final one is a diagnostic", () => {
  assert.deepEqual(
    observations([
      {
        method: "error",
        turnId: "turn-1",
        willRetry: true,
        errorMessage: "429",
      },
    ]),
    [{ kind: "activity", activity: "Retrying after a provider error…" }],
  );

  const built = createCodexTranslator({ cwd: CWD });
  const translation = built.notification({
    method: "error",
    turnId: "turn-1",
    willRetry: false,
    errorMessage: "the model is unavailable for thread root-1",
  });

  assert.deepEqual(translation.observations, [
    {
      kind: "diagnostic",
      diagnostic: {
        category: "backend-failure",
        message: `${CODEX_PROVIDER_ERROR_CATEGORY}: [redacted]`,
      },
    },
  ]);
  // The provider's own words never crossed, and the ending's fallback message
  // is the confined one rather than the provider's.
  assert.equal(
    translation.errorMessage,
    `${CODEX_PROVIDER_ERROR_CATEGORY}: [redacted]`,
  );
});

test("a completed Turn counts one turn and clears the activity", () => {
  const built = createCodexTranslator({ cwd: CWD });

  const translation = built.notification({
    method: "turn/completed",
    turnId: "turn-1",
    status: "completed",
    items: [],
  });

  assert.deepEqual(translation.observations, [
    { kind: "usage", usage: { turns: 1 } },
    { kind: "activity", activity: undefined },
  ]);
  assert.equal(built.turns(), 1);
  assert.equal(translation.errorMessage, undefined);
});

test("a completion frame carrying an error reports it confined, before the count", () => {
  const built = createCodexTranslator({ cwd: CWD });

  const translation = built.notification({
    method: "turn/completed",
    turnId: "turn-1",
    status: "failed",
    items: [],
    errorMessage: "stream disconnected before completion",
  });

  assert.deepEqual(
    translation.observations.map((observation) => observation.kind),
    ["diagnostic", "usage", "activity"],
  );
  assert.ok(translation.errorMessage?.endsWith("[redacted]"));
});

test("the widget's tool name is the last tool call in a list of parts", () => {
  assert.equal(
    latestToolCall([
      { kind: "tool_call", name: "first" },
      { kind: "text", text: "x" },
      { kind: "tool_call", name: "second" },
    ]),
    "second",
  );
  assert.equal(latestToolCall([{ kind: "text", text: "x" }]), undefined);
});
