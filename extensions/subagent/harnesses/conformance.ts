/**
 * The shared conformance battery for one-shot harness executors.
 *
 * This module knows only the core harness and run contracts. A rig supplies a
 * harness backed by a fake implementation for each scenario; backend wire
 * messages and transport types stay in the rig's adapter-owned test file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentDelivery, type SteerOutcome } from "../delivery.ts";
import { getFinalOutput } from "../messages.ts";
import { createSubagentRuns } from "../runs.ts";
import { startSubagent } from "../standalone-run-helper.ts";
import type {
  AgentConfig,
  CancellationReason,
  SingleResult,
  TerminalLifecycleStatus,
  UsageStats,
} from "../types.ts";
import { createHarnessRegistry, type Harness } from "./contract.ts";

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
  "steering-single-consumed",
  "steering-fifo-consumed",
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
  userFactTexts?: readonly string[];
}

export interface HarnessConformanceSteering {
  /** Resolves once the executor is active and the scenario may offer Controls. */
  readonly ready: Promise<void>;
  /** Guidance the shared public seam offers, in admission order. */
  readonly offeredTexts: readonly string[];
  /** Capability-derived public outcome for every offered Control. */
  readonly expectedOutcome: Extract<SteerOutcome, "accepted" | "unsupported">;
  /** Releases the fixture after the suite observes provider delivery in flight. */
  readonly release: () => void;
  /** Adapter-boundary observations, with provider identity already removed. */
  readonly receivedTexts: () => readonly string[];
  readonly providerControlStarts: () => number;
  readonly maxConcurrentProviderControls: () => number;
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
  readonly steering?: HarnessConformanceSteering;
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
  if (expected.userFactTexts !== undefined) {
    assert.deepEqual(
      result.messages
        .filter((fact) => fact.role === "user")
        .map((fact) =>
          fact.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ),
      expected.userFactTexts,
    );
  }
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

      if (scenario.startsWith("steering-")) {
        assert.ok(
          fixture.steering,
          `${scenario} must provide steering observations`,
        );
        const delivery = createSubagentDelivery({ runs, push: () => {} });
        delivery.register(
          started.id,
          config.name,
          started.settled,
          "subagent-unmanaged",
        );
        await fixture.steering.ready;
        assert.deepEqual(
          fixture.steering.offeredTexts.map((text) =>
            delivery.steer(started.id, text),
          ),
          fixture.steering.offeredTexts.map(
            () => fixture.steering?.expectedOutcome,
          ),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        const expectedInFlight =
          fixture.steering.expectedOutcome === "accepted" ? 1 : 0;
        assert.equal(
          fixture.steering.providerControlStarts(),
          expectedInFlight,
          "only the first provider Control may start before its response",
        );
        assert.equal(
          fixture.steering.maxConcurrentProviderControls(),
          expectedInFlight,
          "provider Control delivery must remain serial while the first response is held",
        );
        fixture.steering.release();
      }

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
      if (scenario.startsWith("steering-")) {
        assert.ok(fixture.steering);
        const expectedStarts =
          fixture.steering.expectedOutcome === "accepted"
            ? fixture.steering.offeredTexts.length
            : 0;
        assert.deepEqual(
          fixture.steering.receivedTexts(),
          fixture.steering.expectedOutcome === "accepted"
            ? fixture.steering.offeredTexts
            : [],
        );
        assert.equal(fixture.steering.providerControlStarts(), expectedStarts);
        assert.equal(
          fixture.steering.maxConcurrentProviderControls(),
          expectedStarts > 0 ? 1 : 0,
        );
      }
    });
  }
}
