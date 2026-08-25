import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeHarness } from "./claude-harness.ts";
import type { Harness } from "./harness.ts";
import { createPiHarness } from "./pi-harness.ts";
import type { SubagentTask } from "./run.ts";
import type { AgentConfig } from "./types.ts";

const config: AgentConfig = {
  name: "worker",
  description: "worker",
  fields: {},
  systemPrompt: "Work.",
};

const task: SubagentTask = {
  config,
  description: "one shot",
  prompt: "do one thing",
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

function assertOneShotContract(harness: Harness): void {
  assert.deepEqual(Object.keys(harness).sort(), [
    "name",
    "prepare",
    "validate",
  ]);
  const prepared = harness.prepare(task);
  assert.equal(typeof prepared.execute, "function");
  assert.equal("send" in harness, false);
  assert.equal("steer" in harness, false);
  assert.equal("session" in harness, false);
}

test("one-shot is an invariant of the public harness/task contract for both adapters", () => {
  assert.deepEqual(Object.keys(task).sort(), [
    "childDepth",
    "config",
    "cwd",
    "description",
    "projectTrusted",
    "prompt",
  ]);
  assert.equal("send" in task, false);
  assert.equal("steer" in task, false);
  assert.equal("session" in task, false);

  assertOneShotContract(createPiHarness());
  assertOneShotContract(
    createClaudeHarness(async () => {
      throw new Error("execution is not part of this contract fixture");
    }),
  );
});
