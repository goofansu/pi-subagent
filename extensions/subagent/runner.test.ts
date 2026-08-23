/**
 * Dispatcher tests: the depth guard, the concurrency cap, lifecycle settling,
 * and progress reporting — the rules that hold for every subagent run,
 * exercised against a stand-in executor so no child process is involved.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createSubagentLimiter } from "./concurrency.ts";
import type { SubagentExecutor, SubagentRun } from "./run.ts";
import { createEmptyResult } from "./run.ts";
import {
  assertSubagentDepthAvailable,
  getSubagentDepth,
  runSubagent,
} from "./runner.ts";
import type { AgentConfig, SingleResult, SubagentDetails } from "./types.ts";

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

test("createEmptyResult starts a run queued with its entry time", () => {
  const result = createEmptyResult("worker", "a task", 1_000);

  assert.equal(result.status, "queued");
  assert.equal(result.queuedAt, 1_000);
  assert.equal(result.startedAt, undefined);
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

test("runSubagent reports queued, running, and centrally settled progress", async () => {
  const updates: AgentToolResult<SubagentDetails>[] = [];
  const statuses: Array<{
    status: SingleResult["status"];
    queuedAt?: number;
    startedAt?: number;
    finishedAt?: number;
  }> = [];
  const recorded = recordingExecutor();
  const times = [1_000, 1_500, 4_500];

  const reported = await runSubagent({
    config: agent({ effort: "high" }),
    description: "task",
    prompt: "do it",
    onUpdate: (partial) => {
      updates.push(partial);
      const current = partial.details.results[0];
      statuses.push({
        status: current.status,
        queuedAt: current.queuedAt,
        startedAt: current.startedAt,
        finishedAt: current.finishedAt,
      });
    },
    execute: recorded.execute,
    now: () => times.shift() ?? assert.fail("unexpected clock read"),
  });

  // The dispatcher publishes both lifecycle boundaries. The recording executor
  // also emits its own initial and final progress snapshots.
  assert.deepEqual(
    statuses.map(({ status }) => status),
    ["queued", "running", "running", "running", "completed"],
  );
  assert.equal(
    updates[0].content[0].type === "text" ? updates[0].content[0].text : "",
    "(queued...)",
  );
  const last = updates.at(-1);
  assert.ok(last);
  assert.equal(
    last.content[0].type === "text" ? last.content[0].text : "",
    "ran the agent",
  );
  const lastResult: SingleResult = last.details.results[0];
  assert.equal(lastResult.exitCode, 0);
  assert.equal(lastResult.status, "completed");
  assert.equal(lastResult.queuedAt, 1_000);
  assert.equal(lastResult.startedAt, 1_500);
  assert.equal(lastResult.finishedAt, 4_500);
  assert.equal(updates[0].details.results[0].effort, "high");
  assert.equal(reported.effort, "high");
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
    const times = [100, 200, 700];

    const result = await runSubagent({
      config: agent(),
      description: outcome.expected,
      prompt: "go",
      execute,
      now: () => times.shift() ?? assert.fail("unexpected clock read"),
    });

    assert.equal(stateSeenByExecutor, "running");
    assert.equal(result.status, outcome.expected);
    assert.equal(result.queuedAt, 100);
    assert.equal(result.startedAt, 200);
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

// ── Concurrency cap ───────────────────────────────────────────────────────────

/** An executor whose runs settle only when the test says so. */
function gatedExecutor(): {
  execute: SubagentExecutor;
  started: () => number;
  finishAll: () => void;
} {
  let started = 0;
  const finishers: Array<() => void> = [];
  const execute: SubagentExecutor = async (run) => {
    started++;
    await new Promise<void>((resolve) => finishers.push(resolve));
    run.result.exitCode = 0;
    return run.result;
  };
  return {
    execute,
    started: () => started,
    finishAll: () => {
      for (const finish of finishers.splice(0)) finish();
    },
  };
}

test("runSubagent runs no more than the limiter allows at once", {
  timeout: 5_000,
}, async () => {
  const gated = gatedExecutor();
  const limiter = createSubagentLimiter(2);

  const runs = [1, 2, 3, 4].map(() =>
    runSubagent({
      config: agent(),
      description: "queued",
      prompt: "go",
      execute: gated.execute,
      limiter,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(gated.started(), 2, "only two runs may be in flight");
  assert.equal(limiter.queued(), 2);

  gated.finishAll();
  await new Promise((resolve) => setImmediate(resolve));
  gated.finishAll();
  const results = await Promise.all(runs);

  assert.deepEqual(
    results.map((r) => r.exitCode),
    [0, 0, 0, 0],
  );
});

test("a run cancelled while queued never starts its child", {
  timeout: 5_000,
}, async () => {
  const gated = gatedExecutor();
  const limiter = createSubagentLimiter(1);

  const holding = runSubagent({
    config: agent(),
    description: "holds the slot",
    prompt: "go",
    execute: gated.execute,
    limiter,
  });
  const controller = new AbortController();
  const queuedTimes = [1_000, 4_000];
  const queued = runSubagent({
    config: agent(),
    description: "waits",
    prompt: "go",
    signal: controller.signal,
    execute: gated.execute,
    limiter,
    now: () =>
      queuedTimes.shift() ?? assert.fail("unexpected queued clock read"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gated.started(), 1);

  controller.abort();
  const result = await queued;

  assert.equal(gated.started(), 1, "the queued run must not start after all");
  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.status, "aborted");
  assert.equal(result.queuedAt, 1_000);
  assert.equal(result.startedAt, undefined);
  assert.equal(result.finishedAt, 4_000);

  gated.finishAll();
  await holding;
});

test("a run releases its slot even when the executor throws", async () => {
  const limiter = createSubagentLimiter(1);

  await assert.rejects(
    () =>
      runSubagent({
        config: agent(),
        description: "throws",
        prompt: "go",
        execute: async () => {
          throw new Error("the child exploded");
        },
        limiter,
      }),
    /the child exploded/,
  );

  assert.equal(limiter.active(), 0, "a thrown run must not leak its slot");
});

test("a queued run reports itself before it holds a slot", {
  timeout: 5_000,
}, async () => {
  const gated = gatedExecutor();
  const limiter = createSubagentLimiter(1);

  const holding = runSubagent({
    config: agent(),
    description: "holds the slot",
    prompt: "go",
    execute: gated.execute,
    limiter,
  });
  const updates: AgentToolResult<SubagentDetails>[] = [];
  const queued = runSubagent({
    config: agent(),
    description: "waits",
    prompt: "go",
    onUpdate: (partial) => updates.push(partial),
    execute: gated.execute,
    limiter,
  });
  await new Promise((resolve) => setImmediate(resolve));

  // The child has not run, so nothing but the dispatcher can have reported
  // this run — and without that report a fan-out wider than the cap would
  // show no row at all for the agents still waiting.
  assert.equal(limiter.queued(), 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].details.results[0].exitCode, -1);
  assert.equal(updates[0].details.results[0].status, "queued");
  assert.equal(
    updates[0].content[0].type === "text" ? updates[0].content[0].text : "",
    "(queued...)",
  );

  // Releasing the slot admits the waiter, which then starts a run of its own —
  // so the gate has to be opened again for it.
  gated.finishAll();
  await new Promise((resolve) => setImmediate(resolve));
  gated.finishAll();
  await Promise.all([holding, queued]);
});

// ── Project trust ─────────────────────────────────────────────────────────────

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
