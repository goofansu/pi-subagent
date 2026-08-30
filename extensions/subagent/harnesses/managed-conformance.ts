/**
 * Shared conformance for Session-managed stable Subagents.
 *
 * Fixtures expose only Harness-neutral lifecycle observations. Provider
 * continuation identities and wire vocabulary cannot cross this interface.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentDelivery } from "../delivery.ts";
import { createSubagentRuns } from "../runs.ts";
import { createSubagentManager } from "../subagents.ts";
import type { AgentConfig } from "../types.ts";
import { createHarnessRegistry, type Harness } from "./contract.ts";

export interface ManagedConformanceObservation {
  readonly executionsStarted: () => number;
  readonly executionsSettled: () => number;
  readonly activeExecutions: () => number;
  readonly maximumActiveExecutions: () => number;
  readonly adapterCloses: () => number;
}

export interface ManagedConformanceExpectation {
  readonly resume: "supported" | "unsupported";
  readonly firstOutput: string;
  readonly secondOutput?: string;
}

export interface ManagedConformanceFixture {
  readonly harness: Harness;
  readonly observation: ManagedConformanceObservation;
  readonly expectation: ManagedConformanceExpectation;
}

export interface ManagedConformanceRig {
  /** Test label only; the conformance logic never branches on it. */
  readonly name: string;
  readonly build: () => ManagedConformanceFixture;
}

/** Register the stable-identity and managed-resume obligations for one rig. */
export function runManagedSubagentConformance(
  rig: ManagedConformanceRig,
): void {
  test(`${rig.name} managed conformance: stable identity and managed resume`, async () => {
    for (let iteration = 0; iteration < 32; iteration++) {
      const fixture = rig.build();
      const runIds = ["run-first", "run-second"];
      const runs = createSubagentRuns({ now: () => 0 }, () => {
        const id = runIds.shift();
        assert.ok(id, "managed conformance started an unexpected Run");
        return id;
      });
      const notifications: Array<{
        id: string;
        subagentId: string;
        status: string;
      }> = [];
      const delivery = createSubagentDelivery({
        runs,
        push: ({ id, subagentId, status }) =>
          notifications.push({ id, subagentId, status }),
      });
      const registry = createHarnessRegistry([fixture.harness]);
      const manager = createSubagentManager({
        harnesses: registry,
        runs,
        generateSubagentId: () => "subagent-stable",
        now: () => 0,
      });
      const config: AgentConfig = {
        name: "managed-worker",
        description: "Managed conformance worker",
        harness: fixture.harness.name,
        fields: {},
        systemPrompt: "Keep the fixed Profile role.",
      };

      const first = manager.start({
        config,
        description: "establish context",
        prompt: "remember amber",
        cwd: "/managed-conformance",
        projectTrusted: false,
      });
      delivery.register(
        first.runId,
        config.name,
        first.settled,
        first.subagentId,
      );
      assert.deepEqual(
        { subagentId: first.subagentId, runId: first.runId },
        { subagentId: "subagent-stable", runId: "run-first" },
      );
      assert.notEqual(first.subagentId, first.runId);
      assert.deepEqual(
        manager.resume({
          subagentId: first.subagentId,
          description: "must not queue",
          prompt: "must not start",
        }),
        { outcome: "already running" },
      );

      const firstResult = await first.settled;
      assert.equal(firstResult.lifecycle.phase, "completed");
      assert.equal(
        delivery.result(first.runId)?.output,
        fixture.expectation.firstOutput,
      );
      const immutableFirst = structuredClone(delivery.result(first.runId));
      assert.equal(fixture.observation.executionsStarted(), 1);
      assert.equal(fixture.observation.executionsSettled(), 1);
      assert.equal(fixture.observation.activeExecutions(), 0);
      const landBeforeResume = iteration % 2 === 0;
      if (landBeforeResume) delivery.notificationLanded(first.runId);

      const resumed = manager.resume({
        subagentId: first.subagentId,
        description: "recall context",
        prompt: "recall the retained marker",
      });
      if (!landBeforeResume) delivery.notificationLanded(first.runId);
      assert.deepEqual(delivery.result(first.runId), immutableFirst);

      if (fixture.expectation.resume === "unsupported") {
        assert.deepEqual(resumed, { outcome: "unsupported" });
        assert.equal(
          fixture.observation.executionsStarted(),
          1,
          "unsupported resume must start zero continuation work",
        );
        assert.deepEqual(notifications, [
          {
            id: "run-first",
            subagentId: "subagent-stable",
            status: "completed",
          },
        ]);
      } else {
        assert.equal(resumed.outcome, "started");
        if (resumed.outcome !== "started")
          assert.fail("resume was not started");
        assert.equal(resumed.runId, "run-second");
        assert.notEqual(resumed.runId, first.runId);
        assert.deepEqual(
          manager.resume({
            subagentId: first.subagentId,
            description: "simultaneous loser",
            prompt: "must not queue",
          }),
          { outcome: "already running" },
        );
        delivery.register(
          resumed.runId,
          resumed.agent,
          resumed.settled,
          first.subagentId,
        );
        const secondResult = await resumed.settled;
        assert.equal(secondResult.lifecycle.phase, "completed");
        assert.equal(
          delivery.result(resumed.runId)?.output,
          fixture.expectation.secondOutput,
        );
        assert.deepEqual(delivery.result(first.runId), immutableFirst);
        assert.deepEqual(notifications, [
          {
            id: "run-first",
            subagentId: "subagent-stable",
            status: "completed",
          },
          {
            id: "run-second",
            subagentId: "subagent-stable",
            status: "completed",
          },
        ]);
        assert.equal(fixture.observation.executionsStarted(), 2);
        assert.equal(fixture.observation.executionsSettled(), 2);
      }

      assert.equal(fixture.observation.maximumActiveExecutions(), 1);
      assert.equal(fixture.observation.activeExecutions(), 0);
      await manager.shutdown();
      await manager.shutdown();
      assert.equal(
        fixture.observation.adapterCloses(),
        1,
        "repeated managed shutdown closes the retained adapter once",
      );
      delivery.shutdown();
    }
  });
}
