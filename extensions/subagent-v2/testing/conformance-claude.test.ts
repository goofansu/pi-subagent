import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeConformanceRig,
  claudeConformanceSkips,
} from "./claude/conformance-rig.ts";
import {
  BACKEND_CONFORMANCE_SCENARIOS,
  runBackendConformance,
} from "./conformance.ts";

/**
 * The shared conformance suite against the real Claude backend.
 *
 * This is the milestone's program-level health signal: the same scenarios the
 * two fakes and the Pi adapter pass, run against the second real provider with
 * a scriptable stand-in Query behind it. If Claude had needed the suite
 * loosened, that would have been a finding about the seam rather than a
 * finding about Claude.
 */

test("the Claude backend skips nothing, though the spec allowed for skips", () => {
  const rig = claudeConformanceRig();

  const skipped = BACKEND_CONFORMANCE_SCENARIOS.filter(
    (scenario) => rig.build(scenario) === undefined,
  );

  assert.deepEqual(skipped, []);
  assert.deepEqual(skipped, [...claudeConformanceSkips()]);
});

runBackendConformance(claudeConformanceRig());
