import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKModelRefusalFallbackMessage,
  SDKResultError,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { createClaudeTurnCounter } from "./turns.ts";

function assistantMessage(
  id: string,
  overrides: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id,
      container: null,
      content: [{ type: "text", text: "response", citations: null }],
      context_management: null,
      diagnostics: null,
      model: "claude-sonnet-4-6",
      role: "assistant",
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        fallback_credit: null,
        inference_geo: null,
        input_tokens: 1,
        iterations: null,
        output_tokens: 1,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: "standard",
        speed: "standard",
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "session-id",
    ...overrides,
  };
}

const resultUsage: SDKResultSuccess["usage"] = {
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: { status: { type: "redeemed" } },
  inference_geo: "unknown",
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
};

function resultMessage(numTurns: number): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: numTurns,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: resultUsage,
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: "session-id",
  };
}

function errorResultMessage(numTurns: number): SDKResultError {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: numTurns,
    stop_reason: "error",
    total_cost_usd: 0,
    usage: resultUsage,
    modelUsage: {},
    permission_denials: [],
    errors: ["backend failed"],
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: "session-id",
  };
}

function refusalFallback(): SDKModelRefusalFallbackMessage {
  return {
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    scope: "session",
    original_model: "claude-sonnet-4-6",
    fallback_model: "claude-opus-4-6",
    request_id: "request-1",
    retracted_message_uuids: ["00000000-0000-4000-8000-000000000001"],
    refused_user_message_uuid: "00000000-0000-4000-8000-000000000004",
    content: "Retrying with the fallback model",
    uuid: "00000000-0000-4000-8000-000000000005",
    session_id: "session-id",
  };
}

test("a root Claude assistant response contributes one turn", () => {
  const counter = createClaudeTurnCounter();

  assert.equal(counter.countFor(assistantMessage("msg-1")), 1);
});

test("repeated blocks from one root response contribute only once", () => {
  const counter = createClaudeTurnCounter();
  const messageId = "msg_01K3CLAUDETURN000000000000";

  assert.deepEqual(
    [
      counter.countFor(
        assistantMessage(messageId, {
          uuid: "00000000-0000-4000-8000-000000000011",
        }),
      ),
      counter.countFor(
        assistantMessage(messageId, {
          uuid: "00000000-0000-4000-8000-000000000012",
        }),
      ),
    ],
    [1, 0],
  );
});

test("sidechain assistant responses do not contribute turns", () => {
  const counter = createClaudeTurnCounter();

  assert.equal(
    counter.countFor(
      assistantMessage("sidechain-msg", { parent_tool_use_id: "tool-1" }),
    ),
    0,
  );
});

test("an absent parent id remains compatible as a root response", () => {
  const counter = createClaudeTurnCounter();
  const { parent_tool_use_id: _missing, ...olderAssistant } =
    assistantMessage("msg-1");

  assert.equal(counter.countFor(olderAssistant as SDKMessage), 1);
});

test("an assistant response without a message id contributes no turn", () => {
  const counter = createClaudeTurnCounter();
  const assistant = assistantMessage("msg-1");
  const { id: _missing, ...messageWithoutId } = assistant.message;
  const malformed = {
    ...assistant,
    message: messageWithoutId,
  } as unknown as SDKMessage;

  assert.deepEqual(
    [counter.countFor(malformed), counter.countFor(resultMessage(1))],
    [0, 1],
    "a usable terminal total may catch up the unidentifiable response",
  );
});

test("an aborted root assistant response still contributes a turn", () => {
  const counter = createClaudeTurnCounter();

  assert.equal(
    counter.countFor(assistantMessage("msg-aborted", { aborted: true })),
    1,
  );
});

test("supersedes and refusal retractions never retract emitted turns", () => {
  const counter = createClaudeTurnCounter();

  const deltas = [
    counter.countFor(assistantMessage("refused-msg")),
    counter.countFor(
      assistantMessage("fallback-msg", {
        supersedes: ["00000000-0000-4000-8000-000000000001"],
      }),
    ),
    counter.countFor(refusalFallback()),
    counter.countFor(resultMessage(1)),
  ];

  assert.deepEqual(deltas, [1, 1, 0, 0]);
  assert.equal(
    deltas.reduce((sum, delta) => sum + delta, 0),
    2,
    "the accepted additive accounting may overcount a retracted refusal leg",
  );
});

test("a higher terminal total catches up after observed responses", () => {
  const counter = createClaudeTurnCounter();

  assert.deepEqual(
    [
      counter.countFor(assistantMessage("msg-1")),
      counter.countFor(assistantMessage("msg-2")),
      counter.countFor(resultMessage(5)),
    ],
    [1, 1, 3],
  );
});

test("lower, equal, and zero terminal totals never decrement", () => {
  for (const total of [0, 1, 2]) {
    const counter = createClaudeTurnCounter();
    assert.equal(counter.countFor(assistantMessage("msg-1")), 1);
    assert.equal(counter.countFor(assistantMessage("msg-2")), 1);
    assert.equal(counter.countFor(resultMessage(total)), 0, String(total));
  }
});

test("missing and invalid terminal totals are ignored", () => {
  const invalidTotals: unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
  ];

  for (const total of invalidTotals) {
    const counter = createClaudeTurnCounter();
    assert.equal(counter.countFor(assistantMessage("msg-1")), 1);
    const result = resultMessage(3) as unknown as Record<string, unknown>;
    if (total === undefined) delete result.num_turns;
    else result.num_turns = total;
    assert.equal(counter.countFor(result as unknown as SDKMessage), 0);
  }
});

test("an error result with zero turns preserves observed responses", () => {
  const counter = createClaudeTurnCounter();

  assert.deepEqual(
    [
      counter.countFor(assistantMessage("msg-1")),
      counter.countFor(assistantMessage("msg-2")),
      counter.countFor(errorResultMessage(0)),
    ],
    [1, 1, 0],
  );
});

test("cumulative terminal results add only successive maxima", () => {
  const counter = createClaudeTurnCounter();

  assert.deepEqual(
    [
      counter.countFor(resultMessage(2)),
      counter.countFor(resultMessage(2)),
      counter.countFor(resultMessage(5)),
      counter.countFor(resultMessage(3)),
      counter.countFor(resultMessage(8)),
    ],
    [2, 0, 3, 0, 3],
  );
});

test("all deltas are nonnegative finite integers and their sum is monotonic", () => {
  const counter = createClaudeTurnCounter();
  const malformedResult = resultMessage(1) as unknown as Record<
    string,
    unknown
  >;
  malformedResult.num_turns = Number.NaN;
  const events: SDKMessage[] = [
    assistantMessage("msg-1"),
    assistantMessage("msg-1"),
    assistantMessage("sidechain", { parent_tool_use_id: "tool-1" }),
    resultMessage(4),
    malformedResult as unknown as SDKMessage,
    resultMessage(2),
    assistantMessage("msg-2", { aborted: true }),
    resultMessage(6),
  ];
  let sum = 0;
  let previous = 0;

  for (const event of events) {
    const delta = counter.countFor(event);
    assert.equal(Number.isFinite(delta), true);
    assert.equal(Number.isInteger(delta), true);
    assert.ok(delta >= 0);
    sum += delta;
    assert.ok(sum >= previous);
    previous = sum;
  }
});
