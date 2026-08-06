/**
 * Shared shapes: the rules a result must satisfy no matter which backend or
 * which version of this extension produced it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmptyResult } from "./backend.ts";
import type { PersistedSingleResult } from "./types.ts";
import { resolvePersistedResult } from "./types.ts";

function legacyResult(
  exitCode: number,
  stopReason?: string,
): PersistedSingleResult {
  const {
    harness: _harness,
    status: _status,
    queuedAt: _queuedAt,
    startedAt: _startedAt,
    finishedAt: _finishedAt,
    ...legacy
  } = createEmptyResult("worker", "task", "pi", 100);
  return {
    ...legacy,
    exitCode,
    ...(stopReason ? { stopReason } : {}),
  };
}

test("resolvePersistedResult returns current results unchanged", () => {
  const stored = createEmptyResult("implementer", "task", "claude", 100);

  assert.equal(resolvePersistedResult(stored), stored);
});

test("resolvePersistedResult treats an omitted harness as pi", () => {
  // Results persisted before the harness field existed carry none, and every
  // one of those runs was pi.
  assert.equal(resolvePersistedResult(legacyResult(0, "stop")).harness, "pi");
});

test("resolvePersistedResult infers every legacy lifecycle terminal state", () => {
  const cases = [
    { exitCode: -1, stopReason: undefined, expected: "running" },
    { exitCode: 0, stopReason: "stop", expected: "completed" },
    { exitCode: 1, stopReason: "error", expected: "failed" },
    { exitCode: 1, stopReason: "aborted", expected: "aborted" },
  ] as const;

  for (const { exitCode, stopReason, expected } of cases) {
    assert.equal(
      resolvePersistedResult(legacyResult(exitCode, stopReason)).status,
      expected,
    );
  }
});

test("resolvePersistedResult does not invent timestamps or mutate legacy data", () => {
  const legacy = legacyResult(0, "stop");
  assert.equal(Object.hasOwn(legacy, "status"), false);
  assert.equal(Object.hasOwn(legacy, "queuedAt"), false);
  assert.equal(Object.hasOwn(legacy, "effort"), false);

  const restored = resolvePersistedResult(legacy);

  assert.notEqual(restored, legacy);
  assert.equal(restored.harness, "pi");
  assert.equal(restored.status, "completed");
  assert.equal(restored.queuedAt, undefined);
  assert.equal(restored.startedAt, undefined);
  assert.equal(restored.finishedAt, undefined);
  assert.equal(Object.hasOwn(legacy, "status"), false);
  assert.equal(Object.hasOwn(restored, "effort"), false);
});

test("resolvePersistedResult leaves the rest of a legacy result untouched", () => {
  const legacy = legacyResult(-1);
  const restored = resolvePersistedResult(legacy);

  assert.equal(restored.agent, "worker");
  assert.equal(restored.description, "task");
  assert.equal(restored.exitCode, -1);
  assert.equal(restored.status, "running");
  assert.deepEqual(restored.messages, []);
});
