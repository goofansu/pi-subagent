/**
 * Shared shapes: the rules a result must satisfy no matter which backend or
 * which version of this extension produced it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmptyResult } from "./backend.ts";
import type { PersistedSingleResult } from "./types.ts";
import { resolveResultHarness } from "./types.ts";

test("resolveResultHarness reads back a result that records its harness", () => {
  const stored = createEmptyResult("implementer", "task", "claude");

  assert.equal(resolveResultHarness(stored).harness, "claude");
});

test("resolveResultHarness treats an omitted harness as pi", () => {
  // Results persisted before the harness field existed carry none, and every
  // one of those runs was pi.
  const { harness: _dropped, ...legacy } = createEmptyResult(
    "worker",
    "task",
    "pi",
  );

  assert.equal(
    resolveResultHarness(legacy as PersistedSingleResult).harness,
    "pi",
  );
});

test("resolveResultHarness leaves the rest of the result untouched", () => {
  const { harness: _dropped, ...legacy } = createEmptyResult(
    "worker",
    "a task",
    "pi",
  );
  const restored = resolveResultHarness(legacy as PersistedSingleResult);

  assert.equal(restored.agent, "worker");
  assert.equal(restored.description, "a task");
  assert.equal(restored.exitCode, -1);
  assert.deepEqual(restored.messages, []);
});
