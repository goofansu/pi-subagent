import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confined,
  confinedControl,
  createPiTranslator,
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

// ── Streaming turn activity ──────────────────────────────────────────────────

function messageUpdate(type: string): Record<string, unknown> {
  return {
    type: "message_update",
    message: assistant(),
    assistantMessageEvent: { type, delta: "some tokens" },
  };
}

test("thinking and text deltas name their model-turn activity", () => {
  const translator = createPiTranslator();

  assert.deepEqual(translator.event(messageUpdate("thinking_delta")), {
    kind: "activity",
    observation: { kind: "activity", activity: "thinking…" },
  });
  assert.deepEqual(translator.event(messageUpdate("text_delta")), {
    kind: "activity",
    observation: { kind: "activity", activity: "writing…" },
  });
});

test("model-turn activity is emitted only when the output kind changes", () => {
  const translator = createPiTranslator();

  assert.equal(
    translator.event(messageUpdate("thinking_delta")).kind,
    "activity",
  );
  assert.deepEqual(translator.event(messageUpdate("thinking_delta")), {
    kind: "other",
  });
  assert.equal(translator.event(messageUpdate("text_delta")).kind, "activity");
  assert.deepEqual(translator.event(messageUpdate("text_delta")), {
    kind: "other",
  });
  assert.deepEqual(translator.event(messageUpdate("thinking_delta")), {
    kind: "activity",
    observation: { kind: "activity", activity: "thinking…" },
  });
});

test("a tool activity is newer, and the next turn delta is newer again", () => {
  const translator = createPiTranslator();

  assert.equal(
    translator.event(messageUpdate("thinking_delta")).kind,
    "activity",
  );
  const tool = translator.event({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read_file",
    args: {},
  });
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") {
    assert.deepEqual(tool.observations[0], {
      kind: "activity",
      activity: "read_file",
    });
  }
  assert.deepEqual(translator.event(messageUpdate("thinking_delta")), {
    kind: "activity",
    observation: { kind: "activity", activity: "thinking…" },
  });
});

test("model-turn output kind is reset across executions", () => {
  const firstExecution = createPiTranslator();
  const resumedExecution = createPiTranslator();

  assert.equal(
    firstExecution.event(messageUpdate("text_delta")).kind,
    "activity",
  );
  assert.equal(firstExecution.event(messageUpdate("text_delta")).kind, "other");
  assert.deepEqual(resumedExecution.event(messageUpdate("text_delta")), {
    kind: "activity",
    observation: { kind: "activity", activity: "writing…" },
  });
});

test("message updates emit no message; the message still comes from message end", () => {
  const translator = createPiTranslator();
  const message = assistant();

  assert.deepEqual(translator.event(messageUpdate("text_delta")), {
    kind: "activity",
    observation: { kind: "activity", activity: "writing…" },
  });
  assert.deepEqual(translator.event({ type: "message_end", message }), {
    kind: "message",
    message,
  });
  assert.deepEqual(translator.event(messageUpdate("text_end")), {
    kind: "other",
  });
});

// ── Tool execution ───────────────────────────────────────────────────────────

test("a tool execution start is running progress, and names the activity", () => {
  const event = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read_file",
    args: {},
  };

  assert.deepEqual(piToolProgress(event), {
    kind: "tool_progress",
    callId: "call-1",
    status: "running",
  });
  assert.deepEqual(piActivity(event), {
    kind: "activity",
    activity: "read_file",
  });
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
