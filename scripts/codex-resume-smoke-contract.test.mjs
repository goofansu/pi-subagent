import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRetainedProtocolLifecycle,
  assertStoredThreadInspection,
  containsProviderIdentityFieldName,
  recallsExactMarker,
} from "./codex-resume-smoke-contract.mjs";

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

test("the no-quota contract accepts one pathless retained lifecycle alongside a child-thread completion", () => {
  const retained = assertRetainedProtocolLifecycle(retainedTrace());
  assert.equal(retained.threadId, "private-thread");
  assert.deepEqual(retained.turnIds, ["private-turn-one", "private-turn-two"]);
  assert.equal(retained.codexHome, "/codex-home");
  assert.ok(retained.providerIdentities.has("private-session"));
  assert.ok(retained.providerIdentities.has("nested-turn"));
  assert.ok(retained.providerIdentities.has("nested-item"));
  assert.ok(retained.providerIdentities.has("client-generated-correlation"));
  assert.ok(retained.providerIdentities.has("outbound-expected-turn"));
  assert.equal(retained.providerIdentities.has(""), false);
  assert.equal(retained.providerIdentities.has("   "), false);
  assert.equal(retained.providerIdentities.has("json-rpc-envelope-id"), false);
  assert.equal(retained.providerIdentities.has("non-entity-bare-id"), false);

  const disposable = retainedTrace();
  disposable.outbound.splice(4, 0, {
    jsonrpc: "2.0",
    id: 40,
    method: "initialize",
    params: {},
  });
  disposable.outbound[5] = {
    jsonrpc: "2.0",
    id: 41,
    method: "thread/resume",
    params: { threadId: "private-thread" },
  };
  assert.throws(
    () => assertRetainedProtocolLifecycle(disposable),
    /exactly one initialize request/,
  );

  const persisted = retainedTrace();
  persisted.inbound[1].result.thread.path = "/stored/rollout.jsonl";
  assert.throws(
    () => assertRetainedProtocolLifecycle(persisted),
    /path must be null/,
  );
});

test("marker recall permits prose wrapping and repeated exact marker tokens", () => {
  const marker = "codex-retained-01234567-89ab-cdef-0123-456789abcdef";

  assert.equal(recallsExactMarker(marker, marker), true);
  assert.equal(recallsExactMarker(`The marker is: ${marker}.`, marker), true);
  assert.equal(recallsExactMarker(`${marker}-replayed`, marker), false);
  assert.equal(recallsExactMarker(`${marker}\n${marker}`, marker), true);
  assert.equal(recallsExactMarker("I remember the marker.", marker), false);
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

test("stored-thread inspection rejects a listed private root", () => {
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
});

test("stored-thread inspection rejects a readable private root", () => {
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

test("public-record identity fields match the production Codex redactor vocabulary", () => {
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

  const retainedResult = {
    id: "run-1",
    subagentId: "subagent-1",
    agent: "explore",
    status: "completed",
    output: "answer",
  };
  const notification = {
    id: "run-1",
    subagentId: "subagent-1",
    agent: "explore",
    status: "completed",
    text: "explore completed run run-1",
  };
  assert.equal(
    containsProviderIdentityFieldName(
      JSON.stringify({
        subagentId: "subagent-1",
        firstRunId: "run-1",
        first: retainedResult,
        notifications: [notification],
      }),
    ),
    false,
  );
});
