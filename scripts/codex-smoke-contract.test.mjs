import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertStoredThreadInspection,
  containsProviderIdentityFieldName,
  readRetainedRootLifecycle,
  readRetainedRoots,
} from "./codex-smoke-contract.mjs";

/**
 * One App Server's transcript: one initialize, one ephemeral pathless root,
 * two Turns on it, one steer, and a `turn/completed` for a Codex-native child
 * thread the adapter never asked for.
 *
 * The child-thread completion is in the fixture deliberately. Codex spawns its
 * own threads for tool work, and a contract that required every completion to
 * name the root would reject a healthy live run.
 */
function retainedTrace() {
  return {
    outbound: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { method: "initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "thread/start",
        params: { ephemeral: true },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "turn/start",
        params: { threadId: "private-thread" },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "turn/start",
        params: { threadId: "private-thread" },
      },
      {
        jsonrpc: "2.0",
        id: "json-rpc-envelope-id",
        method: "turn/steer",
        params: {
          threadId: "private-thread",
          expectedTurnId: "outbound-expected-turn",
          clientUserMessageId: "client-generated-correlation",
        },
      },
    ],
    inbound: [
      { id: 1, result: { codexHome: "/codex-home" } },
      {
        id: 2,
        result: {
          thread: {
            id: "private-thread",
            sessionId: "private-session",
            ephemeral: true,
            path: null,
            turns: [
              {
                id: "nested-turn",
                items: [{ id: "nested-item", type: "agentMessage" }],
              },
            ],
            emptyCorrelationId: "",
            whitespaceRequestId: "   ",
            metadata: { id: "non-entity-bare-id" },
          },
        },
      },
      { id: 3, result: { turn: { id: "private-turn-one" } } },
      {
        method: "turn/completed",
        params: {
          threadId: "private-thread",
          turn: { id: "private-turn-one" },
        },
      },
      { id: 4, result: { turn: { id: "private-turn-two" } } },
      {
        method: "turn/completed",
        params: {
          threadId: "private-thread",
          turn: { id: "private-turn-two" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "codex-native-child-thread",
          turn: { id: "codex-native-child-turn" },
        },
      },
    ],
  };
}

/** A transcript for a Subagent that only ever ran once. */
function singleTurnTrace() {
  const trace = retainedTrace();
  trace.outbound = trace.outbound.filter(
    (message) => message.id !== 4 && message.method !== "turn/steer",
  );
  trace.inbound = trace.inbound.filter(
    (message) =>
      message.id !== 4 && message.params?.turn?.id !== "private-turn-two",
  );
  return trace;
}

test("one retained root reads as one ephemeral pathless thread carrying two Turns", () => {
  const root = readRetainedRootLifecycle(retainedTrace());

  assert.equal(root.threadId, "private-thread");
  assert.deepEqual(root.turnIds, ["private-turn-one", "private-turn-two"]);
  assert.equal(root.codexHome, "/codex-home");

  // Every provider identity that crossed the wire, so the gate can prove none
  // of them reached a public record — including the ones nested in a thread's
  // own turn and item lists.
  assert.ok(root.providerIdentities.has("private-session"));
  assert.ok(root.providerIdentities.has("nested-turn"));
  assert.ok(root.providerIdentities.has("nested-item"));
  assert.ok(root.providerIdentities.has("client-generated-correlation"));
  assert.ok(root.providerIdentities.has("outbound-expected-turn"));
  // A JSON-RPC envelope id is not a provider identity, an `id` that is not
  // under a provider entity is not one either, and neither is an empty string.
  assert.equal(root.providerIdentities.has(""), false);
  assert.equal(root.providerIdentities.has("   "), false);
  assert.equal(root.providerIdentities.has("json-rpc-envelope-id"), false);
  assert.equal(root.providerIdentities.has("non-entity-bare-id"), false);
});

test("a second initialize, a resume request, or a stored path is rejected", () => {
  const reinitialized = retainedTrace();
  reinitialized.outbound.push({
    jsonrpc: "2.0",
    id: 40,
    method: "initialize",
    params: {},
  });
  assert.throws(
    () => readRetainedRootLifecycle(reinitialized),
    /exactly one initialize request/,
  );

  const resumed = retainedTrace();
  resumed.outbound.push({
    jsonrpc: "2.0",
    id: 41,
    method: "thread/resume",
    params: { threadId: "private-thread" },
  });
  assert.throws(
    () => readRetainedRootLifecycle(resumed),
    /thread\/resume must never be requested/,
  );

  const persisted = retainedTrace();
  persisted.inbound[1].result.thread.path = "/stored/rollout.jsonl";
  assert.throws(
    () => readRetainedRootLifecycle(persisted),
    /path must be null/,
  );

  const strayTurn = retainedTrace();
  strayTurn.outbound.push({
    jsonrpc: "2.0",
    id: 42,
    method: "turn/start",
    params: { threadId: "some-other-thread" },
  });
  assert.throws(
    () => readRetainedRootLifecycle(strayTurn),
    /every turn\/start must use the root thread/,
  );
});

test("a gate whose every root ran once has not exercised resume", () => {
  // One Subagent that resumed, alongside one that did not, is enough.
  assert.equal(
    readRetainedRoots([singleTurnTrace(), retainedTrace()]).length,
    2,
  );

  assert.throws(
    () => readRetainedRoots([singleTurnTrace(), singleTurnTrace()]),
    /no retained root carried a second Turn/,
  );
  assert.throws(() => readRetainedRoots([]), /no App Server transcript/);
});

test("stored-thread inspection requires a readable listed control before proving privacy", () => {
  assert.doesNotThrow(() =>
    assertStoredThreadInspection({
      privateThreadId: "private-thread",
      listedThreadIds: ["known-stored-thread"],
      controlThreadId: "known-stored-thread",
      controlReadThreadId: "known-stored-thread",
      privateReadRejected: true,
    }),
  );

  assert.throws(
    () =>
      assertStoredThreadInspection({
        privateThreadId: "private-thread",
        listedThreadIds: [],
        privateReadRejected: true,
      }),
    /no stored thread was available for the positive control/,
  );
  assert.throws(
    () =>
      assertStoredThreadInspection({
        privateThreadId: "private-thread",
        listedThreadIds: ["known-stored-thread"],
        controlThreadId: "known-stored-thread",
        controlReadThreadId: undefined,
        privateReadRejected: true,
      }),
    /positive-control thread\/read did not return the listed thread/,
  );
});

test("stored-thread inspection rejects a listed or readable private root", () => {
  assert.throws(
    () =>
      assertStoredThreadInspection({
        privateThreadId: "private-thread",
        listedThreadIds: ["known-stored-thread", "private-thread"],
        controlThreadId: "known-stored-thread",
        controlReadThreadId: "known-stored-thread",
        privateReadRejected: true,
      }),
    /private root appeared in the stored-thread listing/,
  );
  assert.throws(
    () =>
      assertStoredThreadInspection({
        privateThreadId: "private-thread",
        listedThreadIds: ["known-stored-thread"],
        controlThreadId: "known-stored-thread",
        controlReadThreadId: "known-stored-thread",
        privateReadRejected: false,
      }),
    /thread\/read did not reject the private root/,
  );
});

test("public-record identity fields match the Codex adapter's redactor vocabulary", () => {
  for (const field of [
    "clientUserMessageId",
    "expectedTurnId",
    "correlationId",
    "conversationId",
    "requestId",
    "threadId",
    "turnId",
    "itemId",
    "sessionId",
    "clientId",
  ])
    assert.equal(
      containsProviderIdentityFieldName(JSON.stringify({ [field]: "secret" })),
      true,
      field,
    );

  // A v2 public record: Run and Subagent ids are the product's own, and no
  // neutral `*Id` key is mistaken for a provider one.
  assert.equal(
    containsProviderIdentityFieldName(
      JSON.stringify({
        runId: "run-a1b2-1",
        subagentId: "subagent-a1b2-1",
        backendId: "codex",
        agent: "live-smoke",
        status: "completed",
        finalOutput: "answer",
      }),
    ),
    false,
  );
});
