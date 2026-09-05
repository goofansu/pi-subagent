import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleObservations } from "../testing/observation-vocabulary.ts";
import {
  decodeRunObservation,
  isRunObservationKind,
  RUN_OBSERVATION_KINDS,
} from "./observations.ts";

const decode = decodeRunObservation;

function reason(input: unknown): string {
  const decoded = decode(input);
  assert.equal(decoded._tag, "Failure", JSON.stringify(input));
  return decoded._tag === "Failure" ? decoded.failure.message : "";
}

test("the union declares exactly the ten kinds the vocabulary lists", () => {
  const samples = sampleObservations();

  assert.deepEqual(
    samples.map((observation) => observation.kind),
    [...RUN_OBSERVATION_KINDS],
  );
  for (const observation of samples) {
    assert.equal(decode(observation)._tag, "Success", observation.kind);
  }
});

test("a key the vocabulary does not list is rejected, however deeply nested", () => {
  // The one rule that used to need two mechanisms. A `keyof` test could see a
  // field added to the observation itself and nothing below it; a runtime key
  // walker could see a nested key but only if somebody had listed its name.
  assert.match(
    reason({ kind: "message", role: "user", parts: [], threadId: "t-1" }),
    /no excess property[\s\S]*\["threadId"\]/,
  );
  assert.match(
    reason({
      kind: "message",
      role: "user",
      parts: [{ kind: "text", text: "hi", thread_id: "t-1" }],
    }),
    /no excess property[\s\S]*\["parts"\]\[0\]\["thread_id"\]/,
  );
  assert.match(
    reason({ kind: "usage", usage: { input: 1, requestId: "r-1" } }),
    /no excess property[\s\S]*\["usage"\]\["requestId"\]/,
  );
  assert.match(
    reason({
      kind: "tool_progress",
      callId: "c-1",
      status: "running",
      exitCode: 1,
    }),
    /no excess property[\s\S]*\["exitCode"\]/,
  );
});

test("a turn count is a usage figure the core owns; a turn id is not", () => {
  assert.equal(
    decode({ kind: "usage", usage: usageDeltaFixture() })._tag,
    "Success",
  );
  assert.match(
    reason({ kind: "usage", usage: { turns: 3, turnId: "3" } }),
    /no excess property[\s\S]*\["turnId"\]/,
  );
});

function usageDeltaFixture(): { readonly turns: number } {
  return { turns: 3 };
}

test("a whole provider wire object is not an observation at all", () => {
  assert.match(
    reason({ type: "response.delta", delta: { text: "hi" } }),
    /Expected/,
  );
});

test("explicit undefined is accepted for optional observation fields", () => {
  const observations = [
    {
      kind: "message",
      role: "assistant",
      model: undefined,
      parts: [{ kind: "tool_call", name: "read", callId: undefined }],
    },
    {
      kind: "tool_progress",
      callId: "call-1",
      status: "completed",
      outputSummary: undefined,
    },
    {
      kind: "context",
      context: { tokens: 1, window: undefined },
    },
  ];

  for (const observation of observations) {
    assert.equal(decode(observation)._tag, "Success", observation.kind);
  }
});

test("the observation kind guard accepts the ten kinds and nothing else", () => {
  for (const kind of RUN_OBSERVATION_KINDS) {
    assert.equal(isRunObservationKind(kind), true);
  }
  assert.equal(isRunObservationKind("stderr"), false);
  assert.equal(isRunObservationKind(undefined), false);
});
