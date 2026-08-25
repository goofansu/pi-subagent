import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness } from "./harness.ts";
import { createHarnessRegistry } from "./harness.ts";
import { startSubagent } from "./runner.ts";
import { createSubagentRuns } from "./runs.ts";
import type { AgentConfig } from "./types.ts";

const profile: AgentConfig = {
  name: "fake",
  description: "fake",
  harness: "fake",
  fields: {},
  systemPrompt: "work",
};

function fakeHarness(
  onRun: (signal: AbortSignal | undefined) => Promise<void>,
): Harness {
  return {
    name: "fake",
    validate: () => [],
    prepare: () => ({
      execute: async (run) => {
        await onRun(run.signal);
        return run.signal?.aborted
          ? { stopReason: "aborted" }
          : { exitCode: 0 };
      },
    }),
  };
}

test("a fake harness runs the core seam without a backend dependency", async () => {
  const runs = createSubagentRuns();
  const harness = fakeHarness(async (signal) => {
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const started = startSubagent({
    config: profile,
    description: "test",
    prompt: "go",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  runs.cancel([started.id], "requested");
  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "cancelled");
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "requested");
  }
});
