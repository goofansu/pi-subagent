import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findForbiddenKeys,
  OBSERVATION_KEYS,
  sampleObservations,
} from "../testing/observation-vocabulary.ts";
import type { Equals, Expect } from "../testing/type-level.ts";
import {
  isRunObservationKind,
  type ObservationOfKind,
  RUN_OBSERVATION_KINDS,
} from "./observations.ts";

/**
 * The exact key set of every observation kind, proven at compile time.
 *
 * `keyof` is the assertion that matters: adding a field to an observation
 * changes it, so a provider identifier cannot be slipped into the vocabulary
 * without this tuple failing to compile.
 */
type ObservationKeySetsAreExact = [
  Expect<
    Equals<
      keyof ObservationOfKind<"message">,
      "kind" | "role" | "parts" | "model"
    >
  >,
  Expect<
    Equals<
      keyof ObservationOfKind<"tool_progress">,
      "kind" | "callId" | "status" | "outputSummary"
    >
  >,
  Expect<Equals<keyof ObservationOfKind<"activity">, "kind" | "activity">>,
  Expect<Equals<keyof ObservationOfKind<"usage">, "kind" | "usage">>,
  Expect<Equals<keyof ObservationOfKind<"context">, "kind" | "context">>,
  Expect<Equals<keyof ObservationOfKind<"diagnostic">, "kind" | "diagnostic">>,
  Expect<Equals<keyof ObservationOfKind<"link">, "kind" | "link">>,
  Expect<Equals<keyof ObservationOfKind<"model">, "kind" | "model">>,
  Expect<
    Equals<keyof ObservationOfKind<"reconciliation">, "kind" | "reconciliation">
  >,
  Expect<Equals<keyof ObservationOfKind<"ending">, "kind" | "ending">>,
];

test("every observation kind has exactly the keys the vocabulary lists", () => {
  const proofs: ObservationKeySetsAreExact = [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ];

  assert.equal(proofs.length, RUN_OBSERVATION_KINDS.length);
  assert.deepEqual(
    Object.keys(OBSERVATION_KEYS).sort(),
    [...RUN_OBSERVATION_KINDS].sort(),
  );
});

test("a fully populated observation of every kind carries no unlisted key", () => {
  const samples = sampleObservations();

  assert.deepEqual(
    samples.map((observation) => observation.kind),
    [...RUN_OBSERVATION_KINDS],
  );
  for (const observation of samples) {
    assert.deepEqual(
      Object.keys(observation).sort(),
      [...OBSERVATION_KEYS[observation.kind]].sort(),
      observation.kind,
    );
  }
});

test("no observation names a provider thread, turn, item, request, or session", () => {
  for (const observation of sampleObservations()) {
    assert.deepEqual(findForbiddenKeys(observation), [], observation.kind);
  }
});

test("the forbidden-key walker finds provider bookkeeping however it is nested", () => {
  assert.deepEqual(
    findForbiddenKeys({
      kind: "message",
      parts: [{ kind: "text", text: "hi", thread_id: "t-1" }],
    }),
    ["parts[0].thread_id"],
  );
  assert.deepEqual(findForbiddenKeys({ nested: { deeper: { exitCode: 1 } } }), [
    "nested.deeper.exitCode",
  ]);
  // A turn count is a usage figure the core owns; a turn id is not.
  assert.deepEqual(findForbiddenKeys({ usage: { turns: 3 } }), []);
  assert.deepEqual(findForbiddenKeys({ turnId: "3" }), ["turnId"]);
});

test("the observation kind guard accepts the ten kinds and nothing else", () => {
  for (const kind of RUN_OBSERVATION_KINDS) {
    assert.equal(isRunObservationKind(kind), true);
  }
  assert.equal(isRunObservationKind("stderr"), false);
  assert.equal(isRunObservationKind(undefined), false);
});
