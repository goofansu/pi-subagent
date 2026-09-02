import assert from "node:assert/strict";
import { test } from "node:test";
import type { Equals, Expect } from "../testing/type-level.ts";
import {
  type BackendId,
  backendId,
  type ControlId,
  controlId,
  DEFAULT_BACKEND_ID,
  IDENTIFIER_KINDS,
  IDENTIFIER_MAX_LENGTH,
  InvalidIdentifierError,
  isBackendId,
  isControlId,
  isRunId,
  isSubagentId,
  type RunId,
  runId,
  type SubagentId,
  subagentId,
} from "./ids.ts";

/**
 * Each entry is a compile-time proof that one identifier is not assignable to
 * another. The test below constructs the tuple, so the proofs are checked by
 * `typecheck` and are visible as a passing assertion.
 */
type IdentifiersAreMutuallyUnassignable = [
  Expect<Equals<RunId extends SubagentId ? true : false, false>>,
  Expect<Equals<SubagentId extends RunId ? true : false, false>>,
  Expect<Equals<BackendId extends SubagentId ? true : false, false>>,
  Expect<Equals<ControlId extends RunId ? true : false, false>>,
  Expect<Equals<RunId extends string ? true : false, true>>,
];

test("the four identifiers are distinct types that are all strings", () => {
  const proofs: IdentifiersAreMutuallyUnassignable = [
    true,
    true,
    true,
    true,
    true,
  ];

  assert.equal(proofs.length, IDENTIFIER_KINDS.length + 1);
});

test("passing one identifier where another is expected is a compile error", () => {
  const takesSubagentId = (id: SubagentId): string => id;

  // @ts-expect-error a RunId is not a SubagentId, and this is the proof
  assert.equal(takesSubagentId(runId("run-1")), "run-1");
  assert.equal(takesSubagentId(subagentId("run-1")), "run-1");
});

test("every identifier constructor accepts a printable compact string", () => {
  assert.equal(backendId("pi"), "pi");
  assert.equal(subagentId("subagent-01"), "subagent-01");
  assert.equal(runId("run:7"), "run:7");
  assert.equal(controlId("control_1.2"), "control_1.2");
});

test("an identifier constructor rejects a non-string, naming its kind", () => {
  assert.throws(
    () => runId(undefined),
    (error: unknown) => {
      assert.ok(error instanceof InvalidIdentifierError);
      assert.equal(error.kind, "RunId");
      assert.equal(error.rejected, undefined);
      assert.match(error.message, /invalid RunId: not a string/);
      return true;
    },
  );
});

test("an identifier constructor rejects an empty string", () => {
  assert.throws(() => subagentId(""), InvalidIdentifierError);
});

test("an identifier constructor rejects whitespace and unprintable characters", () => {
  for (const rejected of ["run 1", "run\n1", "run/1", "run#1", "  "]) {
    assert.throws(() => runId(rejected), InvalidIdentifierError, rejected);
  }
});

test("an identifier constructor rejects a value longer than the bound", () => {
  const longest = "a".repeat(IDENTIFIER_MAX_LENGTH);

  assert.equal(runId(longest), longest);
  assert.throws(
    () => runId(`${longest}a`),
    (error: unknown) => {
      assert.ok(error instanceof InvalidIdentifierError);
      assert.match(error.message, /longer than 128 characters/);
      return true;
    },
  );
});

test("each guard accepts the shape its constructor produces and rejects others", () => {
  assert.equal(isBackendId(backendId("claude")), true);
  assert.equal(isSubagentId(subagentId("s1")), true);
  assert.equal(isRunId(runId("r1")), true);
  assert.equal(isControlId(controlId("c1")), true);

  for (const guard of [isBackendId, isSubagentId, isRunId, isControlId]) {
    assert.equal(guard(""), false);
    assert.equal(guard("has space"), false);
    assert.equal(guard(7), false);
    assert.equal(guard(undefined), false);
  }
});

test("the default backend a Profile falls back to is pi", () => {
  assert.equal(DEFAULT_BACKEND_ID, "pi");
});
