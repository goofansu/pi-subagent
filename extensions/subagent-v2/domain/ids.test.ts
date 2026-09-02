import assert from "node:assert/strict";
import { test } from "node:test";
import type { Equals, Expect } from "../testing/type-level.ts";
import {
  type BackendId,
  backendId,
  type ControlId,
  controlId,
  DEFAULT_BACKEND_ID,
  hasIdentifierShape,
  IDENTIFIER_KINDS,
  IDENTIFIER_MAX_LENGTH,
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

test("a bare string is not an identifier, so one cannot be smuggled in", () => {
  const takesRunId = (id: RunId): string => id;

  // @ts-expect-error the brand is what stops an unvalidated string here
  assert.equal(takesRunId("run-1"), "run-1");
  assert.equal(takesRunId(runId("run-1")), "run-1");
});

test("every identifier constructor accepts a printable compact string", () => {
  assert.equal(backendId("pi"), "pi");
  assert.equal(subagentId("subagent-01"), "subagent-01");
  assert.equal(runId("run:7"), "run:7");
  assert.equal(controlId("control_1.2"), "control_1.2");
});

test("an identifier constructor rejects a non-string, saying what it expected", () => {
  assert.throws(
    () => runId(undefined),
    (error: unknown) => {
      assert.match(String((error as Error).message), /Expected string/);
      return true;
    },
  );
});

test("an identifier constructor rejects an empty string", () => {
  assert.throws(() => subagentId(""), /length between 1 and 128/);
});

test("an identifier constructor rejects whitespace and unprintable characters", () => {
  for (const rejected of ["run 1", "run\n1", "run/1", "run#1", "  "]) {
    assert.throws(() => runId(rejected), /matching the RegExp/, rejected);
  }
});

test("an identifier constructor rejects a value longer than the bound", () => {
  const longest = "a".repeat(IDENTIFIER_MAX_LENGTH);

  assert.equal(runId(longest), longest);
  assert.throws(() => runId(`${longest}a`), /length between 1 and 128/);
});

test("a rejection names what was expected and never the value it rejected", () => {
  const secret = "sk-live-must-not-appear";

  assert.throws(
    () => runId(`${secret} has a space`),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.ok(!message.includes(secret), message);
      return true;
    },
  );
});

test("one shape predicate answers what a runtime check honestly can", () => {
  assert.equal(hasIdentifierShape(backendId("claude")), true);
  assert.equal(hasIdentifierShape(subagentId("s1")), true);
  assert.equal(hasIdentifierShape(runId("r1")), true);
  assert.equal(hasIdentifierShape(controlId("c1")), true);

  assert.equal(hasIdentifierShape(""), false);
  assert.equal(hasIdentifierShape("has space"), false);
  assert.equal(hasIdentifierShape(7), false);
  assert.equal(hasIdentifierShape(undefined), false);
});

test("the default backend a Profile falls back to is pi", () => {
  assert.equal(DEFAULT_BACKEND_ID, "pi");
});
