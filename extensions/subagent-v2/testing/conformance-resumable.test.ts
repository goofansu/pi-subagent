import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKEND_CONFORMANCE_SCENARIOS,
  BACKEND_CONFORMANCE_SECTIONS,
  runBackendConformance,
} from "./conformance.ts";
import {
  fakeConformanceRig,
  fakeConformanceSkips,
} from "./fakes/conformance-rig.ts";

/**
 * The shared conformance suite against `FakeResumableBackend`.
 *
 * A backend that declares every capability should pass every scenario except
 * the one that only means something for a backend that declares none.
 */

test("the scenario list is exactly the four sections, with nothing forgotten", () => {
  assert.deepEqual(
    Object.values(BACKEND_CONFORMANCE_SECTIONS).flatMap((section) => [
      ...section,
    ]),
    [...BACKEND_CONFORMANCE_SCENARIOS],
  );
  assert.equal(
    new Set(BACKEND_CONFORMANCE_SCENARIOS).size,
    BACKEND_CONFORMANCE_SCENARIOS.length,
    "a scenario is listed twice",
  );
  assert.deepEqual(Object.keys(BACKEND_CONFORMANCE_SECTIONS), [
    "subagent-and-backend-agent",
    "run",
    "control",
    "usage",
  ]);
});

test("a backend that declares every capability skips nothing", () => {
  const rig = fakeConformanceRig("resumable");

  const skipped = BACKEND_CONFORMANCE_SCENARIOS.filter(
    (scenario) => rig.build(scenario) === undefined,
  );

  assert.deepEqual(skipped, []);
  assert.deepEqual(skipped, [...fakeConformanceSkips("resumable")]);
});

runBackendConformance(fakeConformanceRig("resumable"));
