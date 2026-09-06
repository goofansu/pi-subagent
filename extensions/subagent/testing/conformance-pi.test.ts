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
 * This is the seam the whole rewrite exists to prove: the same 38 scenarios
 * the two fakes pass, run against the production adapter with a scriptable
 * stand-in session behind it. A skip here would mean the suite had been
 * quietly narrowed to fit the first real provider, so the empty skip list is
 * asserted rather than assumed.
 */

test("the Pi backend skips nothing, because it declares every capability", () => {
  const rig = piConformanceRig();

  const skipped = BACKEND_CONFORMANCE_SCENARIOS.filter(
    (scenario) => rig.build(scenario) === undefined,
  );

  assert.deepEqual(skipped, []);
  assert.deepEqual(skipped, [...piConformanceSkips()]);
});

runBackendConformance(piConformanceRig());
