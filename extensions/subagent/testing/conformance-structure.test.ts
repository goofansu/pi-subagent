import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeConformanceStructure } from "./claude/conformance-rig.ts";
import {
  assertConformanceStructure,
  type BackendConformanceRigStructure,
} from "./conformance.ts";
import { fakeConformanceStructure } from "./fakes/conformance-rig.ts";
import { piConformanceStructure } from "./pi/conformance-rig.ts";

const structures = (): readonly BackendConformanceRigStructure[] => [
  fakeConformanceStructure("resumable"),
  fakeConformanceStructure("one-shot"),
  piConformanceStructure(),
  claudeConformanceStructure(),
];

test("the scenario table and all four conformance rigs are structurally complete", () => {
  const rigs = structures();
  assert.doesNotThrow(() => assertConformanceStructure(rigs));

  const [first, ...rest] = rigs;
  assert.throws(
    () =>
      assertConformanceStructure([
        { ...first, scriptedScenarios: first.scriptedScenarios.slice(1) },
        ...rest,
      ]),
    /scripts must equal listed scenarios minus skips/,
  );

  assert.throws(
    () =>
      assertConformanceStructure([
        {
          ...first,
          overrides: [
            ...first.overrides,
            { scenario: "not-a-conformance-scenario", reason: "test defect" },
          ],
        },
        ...rest,
      ]),
    /override names unknown scenario 'not-a-conformance-scenario'/,
  );

  assert.throws(
    () =>
      assertConformanceStructure([
        {
          ...first,
          overrides: [
            ...first.overrides,
            { scenario: first.scriptedScenarios[0], reason: "   " },
          ],
        },
        ...rest,
      ]),
    /requires a non-empty reason/,
  );
});
