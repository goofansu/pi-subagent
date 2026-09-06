import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKEND_CONFORMANCE_SCENARIOS,
  runBackendConformance,
} from "./conformance.ts";
import { piConformanceRig, piConformanceSkips } from "./pi/conformance-rig.ts";

/**
 * The shared conformance suite against the real Pi backend.
 *
 * This is the seam the whole rewrite exists to prove: the same scenarios the
 * two fakes pass, run against the production adapter with a scriptable
 * stand-in session behind it. Pi declares every capability, so a skip would
 * mean the shared contract had been narrowed around the adapter.
 */

test("the Pi backend skips nothing", () => {
  const rig = piConformanceRig();

  const skipped = BACKEND_CONFORMANCE_SCENARIOS.filter(
    (scenario) => rig.build(scenario) === undefined,
  );

  assert.deepEqual(skipped, [...piConformanceSkips()]);
  assert.equal(skipped.length, 0);
});

runBackendConformance(piConformanceRig());
