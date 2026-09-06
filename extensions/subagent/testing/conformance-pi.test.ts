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
 * stand-in session behind it. Ticket 01 permits the new ignored-stop scenario
 * to remain a visible skip until ticket 02 supplies Pi's fixture.
 */

test("the Pi backend visibly skips only ticket 02's ignored-stop fixture", () => {
  const rig = piConformanceRig();

  const skipped = BACKEND_CONFORMANCE_SCENARIOS.filter(
    (scenario) => rig.build(scenario) === undefined,
  );

  assert.deepEqual(skipped, [...piConformanceSkips()]);
  assert.equal(skipped.length, 1);
});

runBackendConformance(piConformanceRig());
