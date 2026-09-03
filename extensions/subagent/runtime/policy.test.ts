import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROJECTION_BOUNDS } from "../domain/index.ts";
import {
  DEFAULT_CONTROL_BOUNDS,
  DEFAULT_RUNTIME_POLICY,
  MINIMUM_USEFUL_RESULT_BYTES,
  minimumStoreBytesFor,
  type RuntimePolicy,
} from "./policy.ts";

/**
 * The policy is a value, and these are the properties that make it useful as
 * one: every bound is present, every bound is lowerable, and the defaults are
 * consistent with each other.
 */

test("every bound the runtime enforces has a field", () => {
  // Written as an explicit key list rather than a spread, so adding a bound is
  // a deliberate edit here as well as there.
  assert.deepEqual(Object.keys(DEFAULT_RUNTIME_POLICY).sort(), [
    "cleanupBudgetMillis",
    "controls",
    "deliveryRetryBudget",
    "maxActiveRuns",
    "maxResultBytes",
    "observationQueueBound",
    "openBudgetMillis",
    "projection",
    "resultStoreBytes",
  ]);
  assert.deepEqual(Object.keys(DEFAULT_CONTROL_BOUNDS).sort(), [
    "maxMessageBytes",
    "maxPending",
    "maxPendingBytes",
  ]);
  assert.deepEqual(
    Object.keys(DEFAULT_RUNTIME_POLICY.deliveryRetryBudget).sort(),
    ["attempts", "delayMillis"],
  );
});

test("the control bounds are v1's, so a caller's steering rhythm carries over", () => {
  assert.deepEqual(DEFAULT_CONTROL_BOUNDS, {
    maxPending: 16,
    maxMessageBytes: 16 * 1024,
    maxPendingBytes: 64 * 1024,
  });
});

test("the projection bounds are the domain's, not a second set", () => {
  assert.equal(DEFAULT_RUNTIME_POLICY.projection, DEFAULT_PROJECTION_BOUNDS);
});

test("the default timeout is absent, because a Run has none unless asked for", () => {
  assert.equal(DEFAULT_RUNTIME_POLICY.defaultRunTimeoutMillis, undefined);
  assert.equal("defaultRunTimeoutMillis" in DEFAULT_RUNTIME_POLICY, false);
});

test("the default store budget admits a full house of Runs with room to spare", () => {
  assert.ok(
    DEFAULT_RUNTIME_POLICY.resultStoreBytes >
      minimumStoreBytesFor(DEFAULT_RUNTIME_POLICY),
    "the defaults could never reach maxActiveRuns",
  );
  // The room to spare is what stored results share, so eviction is reachable
  // in a long Session rather than theoretical.
  assert.ok(
    DEFAULT_RUNTIME_POLICY.resultStoreBytes <
      minimumStoreBytesFor(DEFAULT_RUNTIME_POLICY) * 4,
    "the defaults would never evict anything",
  );
});

test("a result bound below the diagnostic bound could not explain itself", () => {
  assert.ok(
    DEFAULT_RUNTIME_POLICY.maxResultBytes > MINIMUM_USEFUL_RESULT_BYTES,
  );
});

test("every bound is lowerable in a test by spreading over the defaults", () => {
  const tight: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxActiveRuns: 1,
    controls: { maxPending: 2, maxMessageBytes: 8, maxPendingBytes: 12 },
    projection: { ...DEFAULT_PROJECTION_BOUNDS, maxTranscriptItems: 2 },
    maxResultBytes: 512,
    resultStoreBytes: 1_024,
    observationQueueBound: 1,
    openBudgetMillis: 10,
    cleanupBudgetMillis: 5,
    deliveryRetryBudget: { attempts: 1, delayMillis: 1 },
    defaultRunTimeoutMillis: 100,
  };

  assert.equal(tight.maxActiveRuns, 1);
  assert.equal(tight.defaultRunTimeoutMillis, 100);
  assert.equal(minimumStoreBytesFor(tight), 512);
  // The defaults are untouched by a test lowering them.
  assert.equal(DEFAULT_RUNTIME_POLICY.maxActiveRuns, 8);
});
