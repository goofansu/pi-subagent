import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKEND_CONFORMANCE_SCENARIOS,
  runBackendConformance,
} from "./conformance.ts";
import {
  fakeConformanceRig,
  fakeConformanceSkips,
} from "./fakes/conformance-rig.ts";

/**
 * The shared conformance suite against `FakeOneShotBackend`.
 *
 * Its skips are the observable difference between a backend that declares
 * every capability and one that declares none, and they are visible in the
 * test output rather than silent.
 */

test("a one-shot backend skips exactly the scenarios its capabilities rule out", () => {
  const rig = fakeConformanceRig("one-shot");

  const skipped = BACKEND_CONFORMANCE_SCENARIOS.filter(
    (scenario) => rig.build(scenario) === undefined,
  );

  assert.deepEqual(skipped, [...fakeConformanceSkips("one-shot")]);
  // Every skip is explained by a capability it did not declare.
  assert.equal(skipped.length, 6);
});

runBackendConformance(fakeConformanceRig("one-shot"));
