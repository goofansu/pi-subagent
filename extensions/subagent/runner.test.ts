/**
 * Dispatcher tests: the depth guard, the concurrency cap, lifecycle settling,
 * and progress reporting — the rules that hold for every subagent run,
 * exercised against a stand-in executor so no child process is involved.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { SubagentExecutor, SubagentRun } from "./run.ts";
import { createEmptyResult } from "./run.ts";
import {
  assertSubagentDepthAvailable,
  getSubagentDepth,
  runSubagent,
} from "./runner.ts";
import { createSubagentRuns } from "./runs.ts";
import type { AgentConfig, SingleResult } from "./types.ts";

// The depth guard reads the environment, so an inherited depth — these tests run
// from inside a subagent often enough — would fail every test that is not about
// nesting. Each test starts at depth 0 and sets the variable itself if it cares.
let inheritedDepth: string | undefined;

beforeEach(() => {
  inheritedDepth = process.env.PI_SUBAGENT_DEPTH;
  delete process.env.PI_SUBAGENT_DEPTH;
});

afterEach(() => {
  if (inheritedDepth !== undefined)
    process.env.PI_SUBAGENT_DEPTH = inheritedDepth;
  else delete process.env.PI_SUBAGENT_DEPTH;
});

/** An executor that records what it was handed and reports a canned success. */
function recordingExecutor(): {
  execute: SubagentExecutor;
  calls: SubagentRun[];
} {
  const calls: SubagentRun[] = [];
  const execute: SubagentExecutor = async (run) => {
    calls.push(run);
    run.emit();
    run.result.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "ran the agent" }],
      api: "anthropic-messages",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    });
    run.result.exitCode = 0;
    run.emit();
    return run.result;
  };
  return { execute, calls };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Does work",
    systemPrompt: "Work.",
    ...overrides,
  };
}

// ── Result initialization ─────────────────────────────────────────────────────

test("createEmptyResult starts a run running from its start time", () => {
  const result = createEmptyResult("worker", "a task", 1_000);

  assert.equal(result.status, "running");
  assert.equal(result.startedAt, 1_000);
  assert.equal(result.finishedAt, undefined);
  assert.equal(result.exitCode, -1);
  assert.deepEqual(result.messages, []);
  assert.equal(result.usage.turns, 0);
  assert.equal(result.usage.cost, 0);
});

// ── Task handoff ──────────────────────────────────────────────────────────────

test("runSubagent hands the executor the task's cwd and parent model", async () => {
  const recorded = recordingExecutor();

  await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    parentModel: { provider: "anthropic", id: "claude-opus-4-5" },
    cwd: "/tmp/workspace",
    execute: recorded.execute,
  });

  const { task } = recorded.calls[0];
  assert.equal(task.cwd, "/tmp/workspace");
  assert.equal(task.prompt, "do it");
  assert.deepEqual(task.parentModel, {
    provider: "anthropic",
    id: "claude-opus-4-5",
  });
});

test("runSubagent reports the current depth so the child can advance it", async () => {
  const recorded = recordingExecutor();
  await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
  });

  assert.equal(recorded.calls[0].task.depth, 0);
});

// ── Depth guard ───────────────────────────────────────────────────────────────

test("runSubagent refuses to nest a subagent inside a subagent", async () => {
  process.env.PI_SUBAGENT_DEPTH = "1";
  const recorded = recordingExecutor();

  await assert.rejects(
    runSubagent({
      config: agent(),
      description: "task",
      prompt: "do it",
      execute: recorded.execute,
    }),
    /Subagents cannot spawn other subagents/,
  );
  assert.equal(recorded.calls.length, 0, "the child must not be started");
});

test("assertSubagentDepthAvailable allows the first level and refuses the next", () => {
  assert.doesNotThrow(() => assertSubagentDepthAvailable(0));
  assert.throws(
    () => assertSubagentDepthAvailable(1),
    /Subagents cannot spawn other subagents/,
  );
});

test("getSubagentDepth reads the environment and defaults to zero", () => {
  assert.equal(getSubagentDepth(), 0);

  process.env.PI_SUBAGENT_DEPTH = "garbage";
  assert.equal(getSubagentDepth(), 0);

  process.env.PI_SUBAGENT_DEPTH = "2";
  assert.equal(getSubagentDepth(), 2);
});

// ── Lifecycle and progress ────────────────────────────────────────────────────

test("runSubagent publishes progress to the registry, not the transcript", async () => {
  const runs = createSubagentRuns();
  const statuses: Array<SingleResult["status"]> = [];
  runs.subscribe(() => {
    const [view] = runs.list();
    if (view) statuses.push(view.status);
  });
  const recorded = recordingExecutor();
  const times = [1_000, 4_500];

  const reported = await runSubagent({
    config: agent({ effort: "high" }),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
    runs,
    now: () => times.shift() ?? assert.fail("unexpected clock read"),
  });

  // Exact notification counts are an implementation detail; what matters is
  // that the run appears as running, settles once, and settles last.
  assert.equal(statuses[0], "running");
  assert.equal(statuses.at(-1), "completed");
  assert.equal(
    statuses.filter((status) => status === "completed").length,
    1,
    "a run settles exactly once",
  );
  assert.ok(statuses.length >= 3, "progress is published as the run advances");
  assert.equal(reported.exitCode, 0);
  assert.equal(reported.status, "completed");
  assert.equal(reported.startedAt, 1_000);
  assert.equal(reported.finishedAt, 4_500);
  assert.equal(reported.effort, "high");
  assert.equal(runs.size(), 0, "the awaited form releases the run");
});

test("runSubagent centrally maps every outcome to a terminal state", async () => {
  const cases = [
    { exitCode: 0, stopReason: "stop", expected: "completed" },
    { exitCode: 1, stopReason: "error", expected: "failed" },
    { exitCode: 1, stopReason: "aborted", expected: "aborted" },
  ] as const;

  for (const outcome of cases) {
    let stateSeenByExecutor: SingleResult["status"] | undefined;
    const execute: SubagentExecutor = async (run) => {
      stateSeenByExecutor = run.result.status;
      run.result.exitCode = outcome.exitCode;
      run.result.stopReason = outcome.stopReason;
      return run.result;
    };
    const times = [100, 700];

    const result = await runSubagent({
      config: agent(),
      description: outcome.expected,
      prompt: "go",
      execute,
      now: () => times.shift() ?? assert.fail("unexpected clock read"),
    });

    assert.equal(stateSeenByExecutor, "running");
    assert.equal(result.status, outcome.expected);
    assert.equal(result.startedAt, 100);
    assert.equal(result.finishedAt, 700);
  }
});

test("runSubagent omits effort when the profile does not configure it", async () => {
  const recorded = recordingExecutor();
  const result = await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
  });

  assert.equal(result.effort, undefined);
  assert.equal("effort" in result, false);
});

// ── Cancellation ──────────────────────────────────────────────────────────────

test("a run cancelled before it starts never spawns a child", async () => {
  let executorCalls = 0;
  const execute: SubagentExecutor = async (run) => {
    executorCalls++;
    return run.result;
  };
  const controller = new AbortController();
  controller.abort();

  const result = await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    signal: controller.signal,
    execute,
    now: () => 500,
  });

  assert.equal(executorCalls, 0);
  assert.equal(result.status, "aborted");
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.finishedAt, 500);
});

// ── Registry ──────────────────────────────────────────────────────────────────

test("a run is tracked while it runs and released once it is delivered", async () => {
  const runs = createSubagentRuns();
  const seen: number[] = [];
  const execute: SubagentExecutor = async (run) => {
    seen.push(runs.size());
    run.result.exitCode = 0;
    return run.result;
  };

  await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute,
    runs,
  });

  assert.deepEqual(seen, [1], "the run is visible while its child works");
  assert.equal(runs.size(), 0, "returning the tool result delivers the run");
});

test("the registry can cancel one run without touching the turn", async () => {
  const runs = createSubagentRuns();
  let sawAbort = false;
  const execute: SubagentExecutor = async (run) => {
    const [id] = runs.list().map((view) => view.id);
    runs.cancel([id]);
    sawAbort = run.signal?.aborted ?? false;
    run.result.exitCode = 1;
    run.result.stopReason = "aborted";
    return run.result;
  };

  const result = await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute,
    runs,
  });

  assert.equal(sawAbort, true, "the executor sees its own run cancelled");
  assert.equal(result.status, "aborted");
});

// ── Trust ─────────────────────────────────────────────────────────────────────

test("runSubagent forwards Pi's project-trust decision to the child", async () => {
  const recorded = recordingExecutor();

  await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    projectTrusted: true,
    execute: recorded.execute,
  });

  assert.equal(recorded.calls[0].task.projectTrusted, true);
});

test("runSubagent denies project trust when the caller reports none", async () => {
  const recorded = recordingExecutor();

  await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
  });

  // A caller that says nothing must not be read as trusting the directory.
  assert.equal(recorded.calls[0].task.projectTrusted, false);
});
