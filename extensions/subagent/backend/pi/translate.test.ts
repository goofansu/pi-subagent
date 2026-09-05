import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confined,
  confinedControl,
  createPiEventTranslator,
  currentRunMessages,
  isPiUserText,
  messageIdentity,
  piActivity,
  piMessageFacts,
  piMessageObservations,
  piMessagePart,
  piRole,
  piTerminalSnapshot,
  piToolProgress,
  piTranscriptItem,
  readPiEvent,
  toolOutputSummary,
  withoutInitialGoal,
} from "./translate.ts";

/**
 * Recorded Pi shapes, translated.
 *
 * The messages below are the shapes the M0 spike observed against the real
 * SDK: content as an array of typed blocks, usage per message with a nested
 * cost, a provider and a model that together name what ran, and a `toolResult`
 * role for what a tool said back. Everything here is a pure function of one of
 * those, so a test is a value in and a value out.
 */

function assistant(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "the answer" }],
    provider: "openai-codex",
    model: "gpt-5.4-mini",
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

/** Usage exactly as the spike recorded it. */
const RECORDED_USAGE = {
  input: 209,
  output: 44,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 37,
  totalTokens: 253,
  cost: {
    input: 0.000157,
    output: 0.000198,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.000355,
  },
};

test("an assistant message becomes a message, a usage delta, and a gauge", () => {
  assert.deepEqual(
    piMessageObservations(assistant({ usage: RECORDED_USAGE })),
    [
      {
        kind: "message",
        role: "assistant",
        parts: [{ kind: "text", text: "the answer" }],
        model: "openai-codex/gpt-5.4-mini",
      },
      {
        kind: "usage",
        usage: {
          input: 209,
          output: 44,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.000355,
          turns: 1,
        },
      },
      // The per-message total is Pi's context occupancy: a gauge, never summed.
      { kind: "context", context: { tokens: 253 } },
    ],
  );
});

test("an assistant message with no usage still counts one turn", () => {
  assert.deepEqual(piMessageObservations(assistant()), [
    {
      kind: "message",
      role: "assistant",
      parts: [{ kind: "text", text: "the answer" }],
      model: "openai-codex/gpt-5.4-mini",
    },
    { kind: "usage", usage: { turns: 1 } },
  ]);
});

test("a user message counts no turn", () => {
  assert.deepEqual(
    piMessageObservations({
      role: "user",
      content: [{ type: "text", text: "keep going" }],
    }),
    [
      {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: "keep going" }],
      },
    ],
  );
});

test("a tool result is a message of its own, with the tool role", () => {
  assert.equal(piRole("toolResult"), "tool");
  assert.deepEqual(
    piTranscriptItem({
      role: "toolResult",
      content: [{ type: "text", text: "40 lines" }],
    }),
    { role: "tool", parts: [{ kind: "text", text: "40 lines" }] },
  );
});

test("a role Pi has that the domain does not is dropped rather than guessed", () => {
  assert.equal(piRole("system"), undefined);
  assert.equal(
    piMessageFacts({ role: "system", content: "hidden" }),
    undefined,
  );
});

test("a tool call part carries the native call id, which is the join key", () => {
  assert.deepEqual(
    piMessagePart({ type: "toolCall", name: "read_file", id: "call-1" }),
    { kind: "tool_call", name: "read_file", callId: "call-1" },
  );
  // Never invented: a made-up id could collide with a real one and merge two
  // unrelated tools into one.
  assert.deepEqual(piMessagePart({ type: "toolCall", name: "read_file" }), {
    kind: "tool_call",
    name: "read_file",
  });
});

test("a content block the domain has no vocabulary for is dropped", () => {
  assert.equal(piMessagePart({ type: "thinking", text: "hmm" }), undefined);
  assert.equal(piMessagePart({ type: "image", data: "..." }), undefined);
  // A plain string is text, which is the other shape Pi uses.
  assert.deepEqual(piMessagePart("just text"), {
    kind: "text",
    text: "just text",
  });
});

test("a message whose blocks all dropped is still a message", () => {
  // Thinking does not cross the boundary, but the usage and the model on the
  // same message do — and dropping the message would drop those with it.
  const observations = piMessageObservations(
    assistant({
      content: [{ type: "thinking", text: "hmm" }],
      usage: { input: 5 },
    }),
  );

  assert.equal(observations.length, 2);
  assert.deepEqual(observations[0], {
    kind: "message",
    role: "assistant",
    parts: [],
    model: "openai-codex/gpt-5.4-mini",
  });
});

test("a message carrying a provider error becomes a confined diagnostic", () => {
  const observations = piMessageObservations(
    assistant({ errorMessage: "rate limited for account acct_1234" }),
  );

  const diagnostic = observations.find((one) => one.kind === "diagnostic");
  assert.ok(diagnostic && diagnostic.kind === "diagnostic");
  assert.equal(diagnostic.diagnostic.category, "backend-failure");
  assert.equal(
    diagnostic.diagnostic.message,
    "Pi reported a failed message: [redacted]",
  );
  // The provider's own text stays adapter-local.
  assert.doesNotMatch(diagnostic.diagnostic.message, /acct_1234/);
});

test("a confined diagnostic never carries provider text", () => {
  assert.equal(
    confined("Pi prompt failed").message,
    "Pi prompt failed: [redacted]",
  );
  assert.equal(
    confinedControl("Pi steering was not delivered").category,
    "control",
  );
});

test("usage fields that are not whole nonnegative counts are dropped", () => {
  const observations = piMessageObservations(
    assistant({
      usage: { input: -5, output: 1.5, cacheRead: 7, totalTokens: "many" },
    }),
  );

  assert.deepEqual(observations[1], {
    kind: "usage",
    usage: { cacheRead: 7, turns: 1 },
  });
  // A gauge the domain cannot read is no gauge, not a zero.
  assert.equal(
    observations.some((one) => one.kind === "context"),
    false,
  );
});

// ── Tool execution ───────────────────────────────────────────────────────────

test("a shell tool execution start names its collapsed first command line", () => {
  const event = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "  git   diff --stat upstream/main  \nrm -rf ignored" },
  };

  assert.deepEqual(readPiEvent(event), {
    kind: "tool",
    observations: [
      { kind: "activity", activity: "bash: git diff --stat upstream/main" },
      { kind: "tool_progress", callId: "call-1", status: "running" },
    ],
  });
});

test("path tool activities name their path and shorten absolute paths", () => {
  const cases = [
    ["read", "/work/presentation/rows.ts", "read: presentation/rows.ts"],
    ["ls", "extensions/subagent", "ls: extensions/subagent"],
    ["write", "/work/backend/activity.ts", "write: backend/activity.ts"],
    ["edit", "CONTEXT.md", "edit: CONTEXT.md"],
  ] as const;

  for (const [toolName, path, activity] of cases) {
    assert.deepEqual(
      piActivity({ type: "tool_execution_start", toolName, args: { path } }),
      { kind: "activity", activity },
    );
  }
});

test("pattern tool activities name the pattern", () => {
  for (const toolName of ["grep", "find"]) {
    assert.deepEqual(
      piActivity({
        type: "tool_execution_start",
        toolName,
        args: { pattern: "  getFinalOutput\\s+  " },
      }),
      { kind: "activity", activity: `${toolName}: getFinalOutput\\s+` },
    );
  }
});

test("an unrecognised tool uses its first string argument or its bare name", () => {
  assert.deepEqual(
    piActivity({
      type: "tool_execution_start",
      toolName: "mcp__tracker__search",
      args: { limit: 10, query: "  open   incidents  ", after: "cursor" },
    }),
    { kind: "activity", activity: "mcp__tracker__search: open incidents" },
  );
  assert.deepEqual(
    piActivity({
      type: "tool_execution_start",
      toolName: "mcp__tracker__refresh",
      args: { limit: 10 },
    }),
    { kind: "activity", activity: "mcp__tracker__refresh" },
  );
  // An ordinary-object prototype name is still an unknown tool name, not a
  // phantom entry in the tool-kind table.
  assert.deepEqual(
    piActivity({
      type: "tool_execution_start",
      toolName: "constructor",
      args: { query: "open incidents" },
    }),
    { kind: "activity", activity: "constructor: open incidents" },
  );
});

test("a recognised tool with no string key argument uses its bare name", () => {
  const cases = [
    { toolName: "bash", args: {} },
    { toolName: "bash", args: { command: 42, fallback: "not the key" } },
    { toolName: "read", args: { path: null } },
    { toolName: "grep", args: "not an argument record" },
  ];

  for (const { toolName, args } of cases) {
    assert.deepEqual(
      piActivity({ type: "tool_execution_start", toolName, args }),
      { kind: "activity", activity: toolName },
    );
  }
});

test("a tool activity is capped at one widget line before observation", () => {
  assert.deepEqual(
    piActivity({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "x".repeat(200) },
    }),
    { kind: "activity", activity: `bash: ${"x".repeat(114)}` },
  );
});

test("a finished shell command shows its last non-blank output line", () => {
  const translator = createPiEventTranslator();
  translator.event({
    type: "tool_execution_start",
    toolCallId: "call-shell",
    toolName: "bash",
    args: { command: "npm test" },
  });

  assert.deepEqual(
    translator.event({
      type: "tool_execution_end",
      toolCallId: "call-shell",
      toolName: "bash",
      result: "running tests\n\n✓ 42 passing (3.1s)\n",
      isError: false,
    }),
    {
      kind: "tool",
      observations: [
        {
          kind: "activity",
          activity: "bash: npm test · ✓ 42 passing (3.1s)",
        },
        {
          kind: "tool_progress",
          callId: "call-shell",
          status: "completed",
          outputSummary: "running tests\n\n✓ 42 passing (3.1s)\n",
        },
      ],
    },
  );
});

test("carriage-return progress ends on its final redraw", () => {
  const translator = createPiEventTranslator();
  translator.event({
    type: "tool_execution_start",
    toolCallId: "call-progress",
    toolName: "bash",
    args: { command: "download" },
  });

  const reading = translator.event({
    type: "tool_execution_end",
    toolCallId: "call-progress",
    toolName: "bash",
    result: "10%\r50%\r100%\r",
    isError: false,
  });
  assert.deepEqual(
    reading.kind === "tool" ? reading.observations[0] : undefined,
    { kind: "activity", activity: "bash: download · 100%" },
  );
});

test("terminal escapes are stripped from a finished shell output line", () => {
  const translator = createPiEventTranslator();
  translator.event({
    type: "tool_execution_start",
    toolCallId: "call-colour",
    toolName: "bash",
    args: { command: "npm test" },
  });

  const reading = translator.event({
    type: "tool_execution_end",
    toolCallId: "call-colour",
    toolName: "bash",
    result: "\u001b[32m✓ 42 passing\u001b[0m",
    isError: false,
  });
  assert.deepEqual(
    reading.kind === "tool" ? reading.observations[0] : undefined,
    { kind: "activity", activity: "bash: npm test · ✓ 42 passing" },
  );
});

test("the command prefix is capped before output, then the whole activity is capped", () => {
  const translator = createPiEventTranslator();
  translator.event({
    type: "tool_execution_start",
    toolCallId: "call-long",
    toolName: "bash",
    args: { command: "c".repeat(200) },
  });

  const reading = translator.event({
    type: "tool_execution_end",
    toolCallId: "call-long",
    toolName: "bash",
    result: "o".repeat(200),
    isError: false,
  });
  assert.deepEqual(
    reading.kind === "tool" ? reading.observations[0] : undefined,
    {
      kind: "activity",
      activity: `bash: ${"c".repeat(54)} · ${"o".repeat(57)}`,
    },
  );
});

test("a shell result with no text leaves the command alone", () => {
  const translator = createPiEventTranslator();
  translator.event({
    type: "tool_execution_start",
    toolCallId: "call-empty",
    toolName: "bash",
    args: { command: "npm test" },
  });

  const reading = translator.event({
    type: "tool_execution_end",
    toolCallId: "call-empty",
    toolName: "bash",
    result: undefined,
    isError: false,
  });
  assert.deepEqual(
    reading.kind === "tool" ? reading.observations[0] : undefined,
    { kind: "activity", activity: "bash: npm test" },
  );
});

test("a non-shell end event produces progress and no activity", () => {
  const translator = createPiEventTranslator();
  translator.event({
    type: "tool_execution_start",
    toolCallId: "call-read",
    toolName: "read",
    args: { path: "README.md" },
  });

  assert.deepEqual(
    translator.event({
      type: "tool_execution_end",
      toolCallId: "call-read",
      toolName: "read",
      result: "40 lines",
      isError: false,
    }),
    {
      kind: "tool",
      observations: [
        {
          kind: "tool_progress",
          callId: "call-read",
          status: "completed",
          outputSummary: "40 lines",
        },
      ],
    },
  );
});

test("mid-command updates are ignored and each end can update activity only once", () => {
  const translator = createPiEventTranslator();
  translator.event({
    type: "tool_execution_start",
    toolCallId: "call-once",
    toolName: "bash",
    args: { command: "npm test" },
  });

  assert.deepEqual(
    translator.event({
      type: "tool_execution_update",
      toolCallId: "call-once",
      toolName: "bash",
      args: { command: "npm test" },
      partialResult: "still running",
    }),
    { kind: "other" },
  );
  const end = {
    type: "tool_execution_end",
    toolCallId: "call-once",
    toolName: "bash",
    result: "done",
    isError: false,
  };
  const firstEnd = translator.event(end);
  assert.deepEqual(
    firstEnd.kind === "tool"
      ? firstEnd.observations.filter((one) => one.kind === "activity")
      : [],
    [{ kind: "activity", activity: "bash: npm test · done" }],
  );
  const repeatedEnd = translator.event(end);
  assert.deepEqual(
    repeatedEnd.kind === "tool"
      ? repeatedEnd.observations.filter((one) => one.kind === "activity")
      : [],
    [],
  );
});

test("a tool execution end carries the outcome and a one-line summary", () => {
  assert.deepEqual(
    piToolProgress({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read_file",
      result: "40 lines",
      isError: false,
    }),
    {
      kind: "tool_progress",
      callId: "call-1",
      status: "completed",
      outputSummary: "40 lines",
    },
  );
  assert.deepEqual(
    piToolProgress({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: undefined,
      isError: true,
    }),
    { kind: "tool_progress", callId: "call-1", status: "failed" },
  );
});

test("a tool result that is not a line is described rather than serialized", () => {
  assert.equal(toolOutputSummary("plain"), "plain");
  assert.equal(toolOutputSummary({ output: "from a field" }), "from a field");
  assert.equal(toolOutputSummary([1, 2, 3]), "3 results");
  assert.equal(toolOutputSummary({ shape: "nobody asked for" }), undefined);
});

test("an event with no call id is not progress about anything", () => {
  assert.equal(
    piToolProgress({ type: "tool_execution_start", toolName: "bash" }),
    undefined,
  );
  assert.equal(piActivity({ type: "message_end" }), undefined);
});

// ── The Run's own messages ───────────────────────────────────────────────────

test("the initial goal is recognized however Pi spells the content", () => {
  assert.equal(
    isPiUserText({ role: "user", content: "have a look" }, "have a look"),
    true,
  );
  assert.equal(
    isPiUserText(
      { role: "user", content: [{ type: "text", text: "have a look" }] },
      "have a look",
    ),
    true,
  );
  assert.equal(
    isPiUserText({ role: "assistant", content: "have a look" }, "have a look"),
    false,
  );
});

test("only the first echo of the brief is omitted", () => {
  const goal = { role: "user", content: "have a look" };
  const steer = { role: "user", content: "have a look" };

  // Two consumed Controls can carry identical text, so only the first match
  // is the goal and the second is something the user actually said.
  assert.deepEqual(withoutInitialGoal([goal, steer], "have a look"), [steer]);
});

test("the Run's own messages are what the baseline does not already hold", () => {
  const first = { role: "assistant", content: "first", timestamp: 1 };
  const second = { role: "assistant", content: "second", timestamp: 2 };

  assert.deepEqual(currentRunMessages([first, second], [first]), [second]);
});

test("a genuinely repeated message is kept, because counts are compared", () => {
  const same = { role: "user", content: "again", timestamp: 1 };

  // Comparing a counted snapshot rather than a set: the retained session may
  // rebuild message objects while compacting, so positions move — but a
  // second identical message the current Run added is still new.
  assert.deepEqual(currentRunMessages([same, { ...same }], [same]), [
    { ...same },
  ]);
});

test("identity is content plus the metadata two different messages would differ in", () => {
  const one = {
    role: "assistant",
    content: "x",
    timestamp: 1,
    usage: { input: 1 },
  };
  const two = {
    role: "assistant",
    content: "x",
    timestamp: 1,
    usage: { input: 9 },
  };

  // Usage is deliberately not part of identity: a message the session restated
  // with an authoritative figure is the same message.
  assert.equal(messageIdentity(one), messageIdentity(two));
});

// ── The terminal snapshot ────────────────────────────────────────────────────

test("the terminal snapshot recomputes the transcript, usage, turns, and gauge", () => {
  const snapshot = piTerminalSnapshot([
    { role: "user", content: [{ type: "text", text: "keep going" }] },
    assistant({
      content: [{ type: "toolCall", name: "read_file", id: "call-1" }],
      usage: { input: 100, output: 10, totalTokens: 400 },
    }),
    { role: "toolResult", content: [{ type: "text", text: "40 lines" }] },
    assistant({
      usage: { input: 50, output: 8, totalTokens: 500, cost: { total: 0.5 } },
    }),
  ]);

  assert.deepEqual(snapshot.usage, {
    input: 150,
    output: 18,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.5,
  });
  // One turn per assistant message, which is what the widget's count means.
  assert.equal(snapshot.turns, 2);
  // The latest gauge, not the sum of the gauges.
  assert.deepEqual(snapshot.context, { tokens: 500 });
  assert.equal(snapshot.model, "openai-codex/gpt-5.4-mini");
  assert.deepEqual(
    snapshot.transcript?.map((item) => item.role),
    ["user", "assistant", "tool", "assistant"],
  );
});

test("a snapshot of nothing is an empty snapshot, not a fabricated one", () => {
  const snapshot = piTerminalSnapshot([]);

  assert.deepEqual(snapshot.transcript, []);
  assert.equal(snapshot.turns, 0);
  assert.equal(snapshot.context, undefined);
  assert.equal(snapshot.model, undefined);
});
