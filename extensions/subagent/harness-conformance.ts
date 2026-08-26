/**
 * The shared conformance battery for one-shot harness executors.
 *
 * This module knows only the core harness and run contracts. A rig supplies a
 * harness backed by a fake implementation for each scenario; backend wire
 * messages and transport types stay in the rig's adapter-owned test file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarnessRegistry, type Harness } from "./harness.ts";
import { getFinalOutput } from "./messages.ts";
import { startSubagent } from "./runner.ts";
import { createSubagentRuns } from "./runs.ts";
import type {
  AgentConfig,
  CancellationReason,
  SingleResult,
  TerminalLifecycleStatus,
  UsageStats,
} from "./types.ts";

/**
 * The neutral scenarios every harness must either implement or skip. A
 * snapshot-capable harness heals streamed drift in the final scenario; a
 * snapshotless harness proves its terminal wire item remains authoritative
 * without inventing a transcript replacement.
 */
export const HARNESS_CONFORMANCE_SCENARIOS = [
  "backend-crash",
  "abort-mid-run",
  "terminal-answer-then-abort",
  "usage-totals",
  "child-depth",
  "config-immutable",
  "no-terminal-answer",
  "post-answer-failure",
  "terminal-transcript-healing",
] as const;

export type HarnessConformanceScenario =
  (typeof HARNESS_CONFORMANCE_SCENARIOS)[number];

export interface HarnessConformanceExpectation {
  phase: TerminalLifecycleStatus;
  cancellationReason?: CancellationReason;
  usage?: UsageStats;
  childDepth?: number;
  finalOutput?: string;
  stopReason?: string;
  errorMessage?: string;
  stderrIncludes?: string;
  stderrExcludes?: string;
  messageCount?: number;
}

/**
 * One scenario fixture. `readyForCancellation` is a neutral lifecycle gate:
 * it resolves when the fixture has reached the point at which the suite should
 * request cancellation. `depthProbe` reports what the fake child observed,
 * without exposing how the harness transported that value.
 */
export interface HarnessConformanceFixture {
  readonly harness: Harness;
  readonly expected: HarnessConformanceExpectation;
  readonly readyForCancellation?: Promise<void>;
  readonly depthProbe: () => number | undefined;
}

/**
 * Adapter-local test code implements this contract. Returning undefined is an
 * intentional, visible skip rather than an unimplemented test that passes.
 */
export interface HarnessConformanceRig {
  readonly name: string;
  build(
    scenario: HarnessConformanceScenario,
  ): HarnessConformanceFixture | undefined;
}

const profile = (harness: string): AgentConfig => ({
  name: "conformance-worker",
  description: "Harness conformance worker",
  harness,
  fields: {},
  systemPrompt: "Do the conformance fixture.",
});

function assertSettled(
  result: SingleResult,
  expected: HarnessConformanceExpectation,
): void {
  assert.equal(result.lifecycle.phase, expected.phase);
  if (expected.cancellationReason !== undefined) {
    if (result.lifecycle.phase !== "cancelled") {
      assert.fail("expected a cancelled lifecycle");
    }
    assert.equal(result.lifecycle.reason, expected.cancellationReason);
  }
  if (expected.usage !== undefined)
    assert.deepEqual(result.usage, expected.usage);
  if (expected.finalOutput !== undefined)
    assert.equal(getFinalOutput(result.messages), expected.finalOutput);
  if (expected.stopReason !== undefined || "stopReason" in expected)
    assert.equal(result.stopReason, expected.stopReason);
  if (expected.errorMessage !== undefined || "errorMessage" in expected)
    assert.equal(result.errorMessage, expected.errorMessage);
  if (expected.stderrIncludes !== undefined)
    assert.match(result.stderr, new RegExp(expected.stderrIncludes));
  if (expected.stderrExcludes !== undefined)
    assert.doesNotMatch(result.stderr, new RegExp(expected.stderrExcludes));
  if (expected.messageCount !== undefined)
    assert.equal(result.messages.length, expected.messageCount);
}

function assertNoBackendAbortVocabulary(result: SingleResult): void {
  assert.doesNotMatch(result.stopReason ?? "", /aborted/);
  assert.doesNotMatch(result.errorMessage ?? "", /aborted/);
}

/** Register the v1 executor obligations for one harness rig. */
export function runHarnessConformance(rig: HarnessConformanceRig): void {
  for (const scenario of HARNESS_CONFORMANCE_SCENARIOS) {
    const fixture = rig.build(scenario);
    const testName = `${rig.name} conformance: ${scenario}`;

    if (!fixture) {
      test(testName, {
        skip: `scenario '${scenario}' is not implemented`,
      }, () => {});
      continue;
    }

    test(testName, async () => {
      const runs = createSubagentRuns();
      const config = profile(fixture.harness.name);
      const beforeConfig = structuredClone(config);
      const started = startSubagent({
        config,
        description: "conformance",
        prompt: "exercise the harness",
        harnesses: createHarnessRegistry([fixture.harness]),
        runs,
      });

      if (
        scenario === "abort-mid-run" ||
        scenario === "terminal-answer-then-abort"
      ) {
        assert.ok(
          fixture.readyForCancellation,
          `${scenario} must provide a cancellation readiness gate`,
        );
        await fixture.readyForCancellation;
        assert.deepEqual(
          runs.cancel([started.id], "requested"),
          [started.id],
          "the run must still be active when cancellation is requested",
        );
      }

      await assert.doesNotReject(started.settled);
      const result = await started.settled;
      assertSettled(result, fixture.expected);
      if (scenario === "backend-crash") {
        assert.doesNotMatch(
          result.errorMessage ?? "",
          /^Executor failed unexpectedly:/,
          "backend-crash must resolve from the executor, not the runner catch",
        );
      }
      assert.deepEqual(
        config,
        beforeConfig,
        "the executor must not mutate task.config",
      );

      if (scenario === "abort-mid-run") assertNoBackendAbortVocabulary(result);
      if (scenario === "child-depth") {
        assert.equal(fixture.depthProbe(), fixture.expected.childDepth);
      }
    });
  }
}
