/**
 * Dispatcher tests: the depth guard, lifecycle settling, and progress
 * reporting — the rules that hold for every subagent run, exercised against a
 * stand-in executor so no child process is involved.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { SubagentExecutor, SubagentRun } from "./run.ts";
import { createEmptyResult } from "./run.ts";
import type { RunSubagentOptions } from "./runner.ts";
import {
  assertSubagentDepthAvailable,
  getSubagentDepth,
  startSubagent,
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

function assistantMessage(): Message {
  return {
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
  } as Message;
}

/** An executor that records what it was handed and reports a canned success. */
function recordingExecutor(): {
  execute: SubagentExecutor;
  calls: SubagentRun[];
} {
  const calls: SubagentRun[] = [];
  const execute: SubagentExecutor = async (run) => {
    calls.push(run);
    run.report.message(assistantMessage());
    return { exitCode: 0 };
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

/**
 * Start a run against a throwaway registry and settle it. Nothing releases a
 * started run except delivery, so tests must not lean on the process-wide
 * registry or entries would accumulate across them.
 */
async function startAndSettle(
  options: Omit<RunSubagentOptions, "runs">,
): Promise<SingleResult> {
  const started = startSubagent({ ...options, runs: createSubagentRuns() });
  return await started.settled;
}

// ── Result initialization ─────────────────────────────────────────────────────

test("createEmptyResult starts a run running from its start time", () => {
  const result = createEmptyResult("worker", "a task", 1_000);

  assert.equal(result.lifecycle.phase, "running");
  assert.equal(result.startedAt, 1_000);
  assert.equal(
    "finishedAt" in result.lifecycle ? result.lifecycle.finishedAt : undefined,
    undefined,
  );
  assert.equal(
    "exitCode" in result.lifecycle ? result.lifecycle.exitCode : undefined,
    undefined,
  );
  assert.deepEqual(result.messages, []);
  assert.equal(result.usage.turns, 0);
  assert.equal(result.usage.cost, 0);
});

// ── Task handoff ──────────────────────────────────────────────────────────────

test("startSubagent hands the executor the task's cwd and parent model", async () => {
  const recorded = recordingExecutor();

  await startAndSettle({
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

test("startSubagent reports the current depth so the child can advance it", async () => {
  const recorded = recordingExecutor();
  await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
  });

  assert.equal(recorded.calls[0].task.depth, 0);
});

// ── Depth guard ───────────────────────────────────────────────────────────────

test("startSubagent refuses to nest a subagent inside a subagent", () => {
  process.env.PI_SUBAGENT_DEPTH = "1";
  const recorded = recordingExecutor();

  // The guard runs in the synchronous part, before a run id exists at all.
  assert.throws(
    () =>
      startSubagent({
        config: agent(),
        description: "task",
        prompt: "do it",
        execute: recorded.execute,
        runs: createSubagentRuns(),
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

test("startSubagent publishes progress to the registry, not the transcript", async () => {
  const runs = createSubagentRuns();
  const statuses: Array<SingleResult["lifecycle"]["phase"]> = [];
  runs.subscribe(() => {
    const [view] = runs.list();
    if (view) statuses.push(view.status);
  });
  const recorded = recordingExecutor();
  const times = [1_000, 4_500];

  const started = startSubagent({
    config: agent({ effort: "high" }),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
    runs,
    now: () => times.shift() ?? assert.fail("unexpected clock read"),
  });
  const reported = await started.settled;

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
  assert.equal(
    "exitCode" in reported.lifecycle ? reported.lifecycle.exitCode : undefined,
    0,
  );
  assert.equal(reported.lifecycle.phase, "completed");
  assert.equal(reported.startedAt, 1_000);
  assert.equal(
    "finishedAt" in reported.lifecycle
      ? reported.lifecycle.finishedAt
      : undefined,
    4_500,
  );
  assert.equal(reported.effort, "high");
});

test("a rejected executor settles the authoritative run as failed", async () => {
  const runs = createSubagentRuns();
  const started = startSubagent({
    config: agent(),
    description: "task",
    prompt: "go",
    execute: async () => {
      throw new Error("executor bug");
    },
    runs,
  });

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "failed");
  assert.equal(runs.list()[0].status, "failed");
  assert.match(result.errorMessage ?? "", /executor bug/);
});

test("INV-3: terminal lifecycle states are final", async () => {
  const cases = [
    { exitCode: 0, stopReason: "stop", expected: "completed" },
    { exitCode: 1, stopReason: "error", expected: "failed" },
    { exitCode: 1, stopReason: "aborted", expected: "cancelled" },
  ] as const;

  for (const { expected, ...outcome } of cases) {
    const execute: SubagentExecutor = async () => outcome;
    const times = [100, 700];

    const result = await startAndSettle({
      config: agent(),
      description: expected,
      prompt: "go",
      execute,
      now: () => times.shift() ?? assert.fail("unexpected clock read"),
    });

    assert.equal(result.lifecycle.phase, expected);
    assert.equal(result.startedAt, 100);
    assert.equal(
      "finishedAt" in result.lifecycle
        ? result.lifecycle.finishedAt
        : undefined,
      700,
    );
  }
});

test("the fold derives usage and activity from reported messages", async () => {
  const execute: SubagentExecutor = async (run) => {
    run.report.message({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "grep",
          arguments: { pattern: "TODO" },
        },
      ],
      usage: { input: 7, cost: { total: 0.5 } },
      // biome-ignore lint/suspicious/noExplicitAny: a partial message is enough
    } as any);
    return { exitCode: 0 };
  };

  const result = await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "go",
    execute,
  });

  // Derived, not reported: the executor named a message, and the dispatcher's
  // fold worked out what it means for usage and activity.
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 7);
  assert.equal(result.usage.cost, 0.5);
  assert.equal(result.activity, "grep: TODO");
});

test("a transcript snapshot replaces the streamed fold, healing usage", async () => {
  const execute: SubagentExecutor = async (run) => {
    run.report.message(assistantMessage());
    run.report.message(assistantMessage());
    run.report.transcript([assistantMessage()]);
    return { exitCode: 0 };
  };

  const result = await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "go",
    execute,
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1, "the snapshot is authoritative");
});

test("startSubagent omits effort when the profile does not configure it", async () => {
  const recorded = recordingExecutor();
  const result = await startAndSettle({
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
  const execute: SubagentExecutor = async () => {
    executorCalls++;
    return { exitCode: 0 };
  };
  const controller = new AbortController();
  controller.abort();

  const result = await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "do it",
    signal: controller.signal,
    execute,
    now: () => 500,
  });

  assert.equal(executorCalls, 0);
  assert.equal(result.lifecycle.phase, "cancelled");
  assert.equal(result.stopReason, "aborted");
  assert.equal(
    "finishedAt" in result.lifecycle ? result.lifecycle.finishedAt : undefined,
    500,
  );
});

// ── Registry ──────────────────────────────────────────────────────────────────

test("a started run stays tracked after it settles, until its delivery", async () => {
  const runs = createSubagentRuns();
  const seen: number[] = [];
  const execute: SubagentExecutor = async () => {
    seen.push(runs.size());
    return { exitCode: 0 };
  };

  const started = startSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute,
    runs,
  });
  await started.settled;

  assert.deepEqual(seen, [1], "the run is visible while its child works");
  // Releasing is the delivery module's job: a settled run is still undelivered
  // work the widget must keep showing.
  assert.equal(runs.size(), 1, "settling does not release the run");
});

test("the registry can cancel one run without touching the turn", async () => {
  const runs = createSubagentRuns();
  let sawAbort = false;
  const execute: SubagentExecutor = async (run) => {
    const [id] = runs.list().map((view) => view.id);
    runs.cancel([id]);
    sawAbort = run.signal?.aborted ?? false;
    return { exitCode: 1, stopReason: "aborted" };
  };

  const started = startSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute,
    runs,
  });
  const result = await started.settled;

  assert.equal(sawAbort, true, "the executor sees its own run cancelled");
  assert.equal(result.lifecycle.phase, "cancelled");
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "requested");
  }
});

// ── Trust ─────────────────────────────────────────────────────────────────────

test("startSubagent forwards Pi's project-trust decision to the child", async () => {
  const recorded = recordingExecutor();

  await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "do it",
    projectTrusted: true,
    execute: recorded.execute,
  });

  assert.equal(recorded.calls[0].task.projectTrusted, true);
});

test("startSubagent denies project trust when the caller reports none", async () => {
  const recorded = recordingExecutor();

  await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
  });

  // A caller that says nothing must not be read as trusting the directory.
  assert.equal(recorded.calls[0].task.projectTrusted, false);
});
