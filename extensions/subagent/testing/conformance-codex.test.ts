import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codexConformanceRig,
  codexConformanceSkips,
} from "./codex/conformance-rig.ts";
import {
  BACKEND_CONFORMANCE_SCENARIOS,
  runBackendConformance,
} from "./conformance.ts";

/**
 * The shared conformance suite against the real Codex backend.
 *
 * This is the milestone's program-level health signal, and it is the hardest
 * of the three: Codex has a process-wide event stream that outlives every Run,
 * a protocol that will not report its peer's death, and usage that is
 * cumulative across a whole conversation. If any of the thirty-seven scenarios
 * had needed loosening for it, that would have been a finding about the seam
 * rather than a finding about Codex.
 */

test("the Codex backend skips nothing, though the spec allowed for skips", () => {
  const rig = codexConformanceRig();

  const skipped = BACKEND_CONFORMANCE_SCENARIOS.filter(
    (scenario) => rig.build(scenario) === undefined,
  );

  assert.deepEqual(skipped, []);
  assert.deepEqual(skipped, [...codexConformanceSkips()]);
});

runBackendConformance(codexConformanceRig());
