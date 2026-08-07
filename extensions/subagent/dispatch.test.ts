/**
 * Dispatcher tests: harness selection, the depth guard, and the rules that must
 * hold identically for every backend.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentBackend, SubagentRunContext } from "./backend.ts";
import {
  createBackendRegistry,
  createEmptyResult,
  resolveBackend,
} from "./backend.ts";
import { createSubagentLimiter } from "./concurrency.ts";
import { runSubagent } from "./runner.ts";
import type {
  AgentConfig,
  Harness,
  SingleResult,
  SubagentDetails,
} from "./types.ts";

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

/** A backend that records what it was handed and reports a canned success. */
function recordingBackend(name: Harness): {
  backend: SubagentBackend;
  calls: SubagentRunContext[];
} {
  const calls: SubagentRunContext[] = [];
  const backend: SubagentBackend = {
    name,
    isAvailable: async () => true,
    async run(ctx) {
      calls.push(ctx);
      ctx.emit();
      ctx.result.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `ran on ${name}` }],
        api: "anthropic-messages",
        provider: name,
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
      ctx.result.exitCode = 0;
      ctx.emit();
      return ctx.result;
    },
  };
  return { backend, calls };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Does work",
    systemPrompt: "Work.",
    ...overrides,
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

test("resolveBackend finds a registered harness", () => {
  const { backend } = recordingBackend("claude");
  const registry = createBackendRegistry([backend]);

  assert.equal(resolveBackend(registry, "claude"), backend);
});

test("resolveBackend names the registered harnesses when one is missing", () => {
  const registry = createBackendRegistry([recordingBackend("pi").backend]);

  assert.throws(
    () => resolveBackend(registry, "claude"),
    /No backend registered for harness 'claude'\. Registered: pi/,
  );
});

test("createEmptyResult starts a run queued with its entry time", () => {
  const result = createEmptyResult("worker", "a task", "claude", 1_000);

  assert.equal(result.status, "queued");
  assert.equal(result.queuedAt, 1_000);
  assert.equal(result.startedAt, undefined);
  assert.equal(result.finishedAt, undefined);
  assert.equal(result.exitCode, -1);
  assert.equal(result.harness, "claude");
  assert.deepEqual(result.messages, []);
  assert.equal(result.usage.turns, 0);
  assert.equal(result.usage.cost, 0);
});

// ── Harness selection ─────────────────────────────────────────────────────────

test("runSubagent routes to the harness named by the agent profile", async () => {
  const pi = recordingBackend("pi");
  const claude = recordingBackend("claude");
  const registry = createBackendRegistry([pi.backend, claude.backend]);

  const result = await runSubagent({
    config: agent({ harness: "claude" }),
    description: "task",
    prompt: "do it",
    registry,
  });

  assert.equal(claude.calls.length, 1);
  assert.equal(pi.calls.length, 0);
  assert.equal(result.harness, "claude");
});

test("runSubagent defaults to the pi harness when a profile omits it", async () => {
  const pi = recordingBackend("pi");
  const claude = recordingBackend("claude");
  const registry = createBackendRegistry([pi.backend, claude.backend]);

  const result = await runSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    registry,
  });

  assert.equal(pi.calls.length, 1);
  assert.equal(claude.calls.length, 0);
  assert.equal(result.harness, "pi");
});

test("runSubagent hands the backend the task's cwd, agent dir, and parent model", async () => {
  const claude = recordingBackend("claude");
  const registry = createBackendRegistry([claude.backend]);

  await runSubagent({
    config: agent({ harness: "claude" }),
    description: "task",
    prompt: "do it",
    parentModel: { provider: "anthropic", id: "claude-opus-4-5" },
    cwd: "/tmp/workspace",
    agentDir: "/tmp/agent",
    registry,
  });

  const { task } = claude.calls[0];
  assert.equal(task.cwd, "/tmp/workspace");
  assert.equal(task.agentDir, "/tmp/agent");
  assert.equal(task.prompt, "do it");
  assert.deepEqual(task.parentModel, {
    provider: "anthropic",
    id: "claude-opus-4-5",
  });
});

test("runSubagent reports the current depth so backends can advance it", async () => {
  const claude = recordingBackend("claude");
  await runSubagent({
    config: agent({ harness: "claude" }),
    description: "task",
    prompt: "do it",
    registry: createBackendRegistry([claude.backend]),
  });

  assert.equal(claude.calls[0].task.depth, 0);
});

// ── Depth guard ───────────────────────────────────────────────────────────────

test("runSubagent refuses to nest a subagent inside a subagent, on any harness", async () => {
  process.env.PI_SUBAGENT_DEPTH = "1";

  for (const harness of ["pi", "claude"] as const) {
    const recorded = recordingBackend(harness);
    await assert.rejects(
      runSubagent({
        config: agent({ harness }),
        description: "task",
        prompt: "do it",
        registry: createBackendRegistry([recorded.backend]),
      }),
      /Subagents cannot spawn other subagents/,
    );
    assert.equal(recorded.calls.length, 0, `${harness} must not be started`);
  }
});

// ── Skills and progress ───────────────────────────────────────────────────────

test("runSubagent reports queued, running, and centrally settled progress", async () => {
  const updates: AgentToolResult<SubagentDetails>[] = [];
  const statuses: Array<{
    status: SingleResult["status"];
    queuedAt?: number;
    startedAt?: number;
    finishedAt?: number;
  }> = [];
  const claude = recordingBackend("claude");
  const times = [1_000, 1_500, 4_500];

  const reported = await runSubagent({
    config: agent({ harness: "claude", effort: "high" }),
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
    registry: createBackendRegistry([claude.backend]),
    now: () => times.shift() ?? assert.fail("unexpected clock read"),
  });

  // The dispatcher publishes both lifecycle boundaries. The recording backend
  // also emits its initial and final legacy progress snapshots.
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
    "ran on claude",
  );
  const lastResult: SingleResult = last.details.results[0];
  assert.equal(lastResult.harness, "claude");
  assert.equal(lastResult.exitCode, 0);
  assert.equal(lastResult.status, "completed");
  assert.equal(lastResult.queuedAt, 1_000);
  assert.equal(lastResult.startedAt, 1_500);
  assert.equal(lastResult.finishedAt, 4_500);
  assert.equal(updates[0].details.results[0].effort, "high");
  assert.equal(reported.effort, "high");
});

test("runSubagent centrally maps every backend outcome to a terminal state", async () => {
  const cases = [
    { exitCode: 0, stopReason: "stop", expected: "completed" },
    { exitCode: 1, stopReason: "error", expected: "failed" },
    { exitCode: 1, stopReason: "aborted", expected: "aborted" },
  ] as const;

  for (const outcome of cases) {
    let stateSeenByBackend: SingleResult["status"] | undefined;
    const backend: SubagentBackend = {
      name: "pi",
      isAvailable: async () => true,
      async run(ctx) {
        stateSeenByBackend = ctx.result.status;
        ctx.result.exitCode = outcome.exitCode;
        ctx.result.stopReason = outcome.stopReason;
        return ctx.result;
      },
    };
    const times = [100, 200, 700];

    const result = await runSubagent({
      config: agent(),
      description: outcome.expected,
      prompt: "go",
      registry: createBackendRegistry([backend]),
      now: () => times.shift() ?? assert.fail("unexpected clock read"),
    });

    assert.equal(stateSeenByBackend, "running");
    assert.equal(result.status, outcome.expected);
    assert.equal(result.queuedAt, 100);
    assert.equal(result.startedAt, 200);
    assert.equal(result.finishedAt, 700);
  }
});

test("runSubagent omits effort when the profile does not configure it", async () => {
  const pi = recordingBackend("pi");
  const result = await runSubagent({
    config: agent({ harness: "pi" }),
    description: "task",
    prompt: "do it",
    registry: createBackendRegistry([pi.backend]),
  });

  assert.equal(result.effort, undefined);
  assert.equal("effort" in result, false);
});

// ── Concurrency cap ───────────────────────────────────────────────────────────

/** A backend whose runs settle only when the test says so. */
function gatedBackend(name: Harness = "pi"): {
  backend: SubagentBackend;
  started: () => number;
  finishAll: () => void;
} {
  let started = 0;
  const finishers: Array<() => void> = [];
  const backend: SubagentBackend = {
    name,
    isAvailable: async () => true,
    async run(ctx) {
      started++;
      await new Promise<void>((resolve) => finishers.push(resolve));
      ctx.result.exitCode = 0;
      return ctx.result;
    },
  };
  return {
    backend,
    started: () => started,
    finishAll: () => {
      for (const finish of finishers.splice(0)) finish();
    },
  };
}

test("runSubagent runs no more than the limiter allows at once", {
  timeout: 5_000,
}, async () => {
  const gated = gatedBackend();
  const registry = createBackendRegistry([gated.backend]);
  const limiter = createSubagentLimiter(2);

  const runs = [1, 2, 3, 4].map(() =>
    runSubagent({
      config: agent(),
      description: "queued",
      prompt: "go",
      registry,
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

test("a run cancelled while queued never starts its backend", {
  timeout: 5_000,
}, async () => {
  const gated = gatedBackend();
  const registry = createBackendRegistry([gated.backend]);
  const limiter = createSubagentLimiter(1);

  const holding = runSubagent({
    config: agent(),
    description: "holds the slot",
    prompt: "go",
    registry,
    limiter,
  });
  const controller = new AbortController();
  const queuedTimes = [1_000, 4_000];
  const queued = runSubagent({
    config: agent(),
    description: "waits",
    prompt: "go",
    signal: controller.signal,
    registry,
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

test("a run releases its slot even when the backend throws", async () => {
  const registry = createBackendRegistry([
    {
      name: "pi" as Harness,
      isAvailable: async () => true,
      async run() {
        throw new Error("backend exploded");
      },
    },
  ]);
  const limiter = createSubagentLimiter(1);

  await assert.rejects(
    () =>
      runSubagent({
        config: agent(),
        description: "throws",
        prompt: "go",
        registry,
        limiter,
      }),
    /backend exploded/,
  );

  assert.equal(limiter.active(), 0, "a thrown run must not leak its slot");
});

test("a queued run reports itself before it holds a slot", {
  timeout: 5_000,
}, async () => {
  const gated = gatedBackend();
  const registry = createBackendRegistry([gated.backend]);
  const limiter = createSubagentLimiter(1);

  const holding = runSubagent({
    config: agent(),
    description: "holds the slot",
    prompt: "go",
    registry,
    limiter,
  });
  const updates: AgentToolResult<SubagentDetails>[] = [];
  const queued = runSubagent({
    config: agent(),
    description: "waits",
    prompt: "go",
    onUpdate: (partial) => updates.push(partial),
    registry,
    limiter,
  });
  await new Promise((resolve) => setImmediate(resolve));

  // The backend has not run, so nothing but the dispatcher can have reported
  // this run — and without that report a fan-out wider than the cap would show
  // no row at all for the agents still waiting.
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

test("runSubagent forwards pi's trust decision to the backend", async () => {
  const claude = recordingBackend("claude");
  const registry = createBackendRegistry([claude.backend]);

  await runSubagent({
    config: agent({ harness: "claude" }),
    description: "task",
    prompt: "do it",
    projectTrusted: true,
    registry,
  });

  assert.equal(claude.calls[0].task.projectTrusted, true);
});

test("runSubagent treats an unreported trust decision as untrusted", async () => {
  const claude = recordingBackend("claude");
  const registry = createBackendRegistry([claude.backend]);

  await runSubagent({
    config: agent({ harness: "claude" }),
    description: "task",
    prompt: "do it",
    registry,
  });

  // A caller that says nothing must not be read as trusting the directory.
  assert.equal(claude.calls[0].task.projectTrusted, false);
});
