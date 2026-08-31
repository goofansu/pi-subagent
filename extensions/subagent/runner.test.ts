/**
 * Dispatcher tests: the depth guard, lifecycle settling, and progress
 * reporting — the rules that hold for every subagent run, exercised against a
 * stand-in executors, plus the real Codex adapter at the ordered-Control seam.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import type { ControlSource } from "./control-source.ts";
import type { ChildProcessSpawn } from "./harnesses/codex/app-server.ts";
import { createCodexHarness } from "./harnesses/codex/harness.ts";
import {
  createHarnessRegistry,
  type Harness,
  type HarnessAdapter,
} from "./harnesses/contract.ts";
import { createPiHarness } from "./harnesses/pi/harness.ts";
import { getFinalOutput } from "./messages.ts";
import {
  createEmptyResult,
  type Fact,
  type RunEnding,
  type SubagentContext,
  type SubagentExecutor,
  type SubagentRun,
  type SubagentTask,
} from "./run.ts";
import {
  assertSubagentDepthAvailable,
  dispatchSubagentRun,
  getSubagentDepth,
} from "./runner.ts";
import { createSubagentRuns } from "./runs.ts";
import {
  startSubagent as dispatchSubagent,
  type RunSubagentOptions,
} from "./standalone-run-helper.ts";
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

function assistantMessage(): Fact {
  return {
    role: "assistant",
    parts: [{ type: "text", text: "ran the agent" }],
    usage: { input: 0, output: 0, turns: 1 },
    model: "test-provider/test-model",
    stopReason: "stop",
  };
}

/** An executor that records what it was handed and reports a canned success. */
function recordingExecutor(): {
  execute: SubagentExecutor;
  calls: SubagentRun[];
  contexts: SubagentContext[];
  tasks: SubagentTask[];
} {
  const calls: SubagentRun[] = [];
  const contexts: SubagentContext[] = [];
  const tasks: SubagentTask[] = [];
  const execute: SubagentExecutor = async (run) => {
    calls.push(run);
    run.report.message(assistantMessage());
    return { ending: "answered" };
  };
  return { execute, calls, contexts, tasks };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Does work",
    systemPrompt: "Work.",
    ...overrides,
  };
}

function controlledAdapter(
  prepareRun: HarnessAdapter["prepareRun"],
  close: HarnessAdapter["close"] = async () => {},
): HarnessAdapter {
  return {
    capabilities: { resume: false },
    model: undefined,
    prepareRun,
    close,
  };
}

/** Keep executor injection behind the same harness seam production uses. */
function startSubagent(
  options: Omit<RunSubagentOptions, "harnesses"> & {
    execute: SubagentExecutor;
    observations?: {
      contexts: SubagentContext[];
      tasks: SubagentTask[];
    };
  },
): ReturnType<typeof dispatchSubagent> {
  const { execute, observations, ...dispatchOptions } = options;
  const harness: Harness = {
    name: "pi",
    validate: () => [],
    prepare: (context) => {
      observations?.contexts.push(context);
      const adapter = createPiHarness().prepare(context);
      return {
        ...adapter,
        prepareRun: (task) => {
          observations?.tasks.push(task);
          return { ...adapter.prepareRun(task), execute };
        },
      };
    },
  };
  return dispatchSubagent({
    ...dispatchOptions,
    harnesses: createHarnessRegistry([harness]),
  });
}

/**
 * Start a run against a throwaway registry and settle it. Nothing releases a
 * started run except delivery, so tests must not lean on the process-wide
 * registry or entries would accumulate across them.
 */
async function startAndSettle(
  options: Omit<RunSubagentOptions, "runs" | "harnesses"> & {
    execute: SubagentExecutor;
    observations?: {
      contexts: SubagentContext[];
      tasks: SubagentTask[];
    };
  },
): Promise<SingleResult> {
  const started = startSubagent({
    ...options,
    runs: createSubagentRuns(),
  });
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
  assert.deepEqual(result.messages, []);
  assert.equal(result.usage.turns, 0);
  assert.equal(result.usage.cost, 0);
});

// ── Task handoff ──────────────────────────────────────────────────────────────

test("startSubagent hands the executor resolved dispatch policy", async () => {
  const recorded = recordingExecutor();

  await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "do it",
    parentModel: {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "high",
    },
    cwd: "/tmp/workspace",
    execute: recorded.execute,
    observations: recorded,
  });

  const [context] = recorded.contexts;
  const [task] = recorded.tasks;
  assert.equal(context.cwd, "/tmp/workspace");
  assert.equal(context.childDepth, 1);
  assert.deepEqual(context.parentModel, {
    provider: "anthropic",
    id: "claude-opus-4-5",
    thinkingLevel: "high",
  });
  assert.equal(task.prompt, "do it");
  assert.equal("config" in task, false);
  assert.equal("cwd" in task, false);
  assert.equal("parentModel" in task, false);
  assert.equal("depth" in task, false);
});

test("a controlled Harness receives admitted Controls through the executor seam in FIFO order", async () => {
  let releaseExecutor = () => {};
  const executorGate = new Promise<void>((resolve) => {
    releaseExecutor = resolve;
  });
  const received: string[] = [];
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(() => ({
        supportedControls: ["steer"],
        execute: async (run) => {
          await executorGate;
          await new Promise<void>((resolve) => {
            run.controls.subscribe((admission) => {
              received.push(admission.control.text);
              admission.acknowledge();
              if (received.length === 2) resolve();
            });
          });
          run.report.message({
            role: "assistant",
            parts: [{ type: "text", text: "followed both Controls" }],
          });
          return { ending: "answered" };
        },
      })),
  };
  const runs = createSubagentRuns();
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });

  assert.equal(
    runs.offer(started.id, { type: "steer", text: "first" }),
    "accepted",
  );
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "second" }),
    "accepted",
  );
  releaseExecutor();
  const result = await started.settled;

  assert.deepEqual(received, ["first", "second"]);
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "after settlement" }),
    "already completed",
  );
});

test("a controlled Harness observes accepted Control admission before a later cancellation abort", async () => {
  const occurrences: string[] = [];
  let executorReady = () => {};
  const ready = new Promise<void>((resolve) => {
    executorReady = resolve;
  });
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(() => ({
        supportedControls: ["steer"],
        execute: async (run) => {
          run.controls.subscribe(
            (admission) => {
              occurrences.push(`Control: ${admission.control.text}`);
              admission.acknowledge();
            },
            () => occurrences.push("Control source closed"),
          );
          const aborted = new Promise<void>((resolve) => {
            run.signal?.addEventListener(
              "abort",
              () => {
                occurrences.push("executor aborted");
                resolve();
              },
              { once: true },
            );
          });
          executorReady();
          await aborted;
          return { ending: "cancelled" };
        },
      })),
  };
  const runs = createSubagentRuns();
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  await ready;

  occurrences.push(
    `offer: ${runs.offer(started.id, { type: "steer", text: "guidance" })}`,
  );
  runs.cancel([started.id], "requested");

  assert.deepEqual(occurrences, [
    "Control: guidance",
    "offer: accepted",
    "Control source closed",
    "executor aborted",
  ]);
  assert.equal((await started.settled).lifecycle.phase, "cancelled");
});

test("cancellation-first closes a controlled Harness source before rejecting later Control", async () => {
  const occurrences: string[] = [];
  let executorReady = () => {};
  const ready = new Promise<void>((resolve) => {
    executorReady = resolve;
  });
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(() => ({
        supportedControls: ["steer"],
        execute: async (run) => {
          run.controls.subscribe(
            (admission) =>
              occurrences.push(`Control: ${admission.control.text}`),
            () => occurrences.push("Control source closed"),
          );
          const aborted = new Promise<void>((resolve) => {
            run.signal?.addEventListener(
              "abort",
              () => {
                occurrences.push("executor aborted");
                resolve();
              },
              { once: true },
            );
          });
          executorReady();
          await aborted;
          return { ending: "cancelled" };
        },
      })),
  };
  const runs = createSubagentRuns();
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  await ready;

  runs.cancel([started.id], "requested");
  occurrences.push(
    `offer: ${runs.offer(started.id, { type: "steer", text: "too late" })}`,
  );

  assert.deepEqual(occurrences, [
    "Control source closed",
    "executor aborted",
    "offer: not steerable",
  ]);
  assert.equal((await started.settled).lifecycle.phase, "cancelled");
});

const CONTROL_ORDER_REPETITIONS = 32;

async function proveCodexControlOrder(
  order: "control-first" | "cancellation-first",
): Promise<void> {
  for (let iteration = 0; iteration < CONTROL_ORDER_REPETITIONS; iteration++) {
    const providerMethods: string[][] = [[], []];
    const turnReady: Array<Promise<void>> = [];
    const releaseTurn: Array<() => void> = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      turnReady.push(
        new Promise<void>((resolve) => {
          releaseTurn.push(resolve);
        }),
      );
    }
    const threadId = `thread-${iteration}`;
    let spawnCount = 0;
    const spawn: ChildProcessSpawn = () => {
      spawnCount++;
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal: string): boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      };
      const send = (value: unknown): void => {
        child.stdout.write(`${JSON.stringify(value)}\n`);
      };
      let currentTurn = -1;
      let turnId = "";
      child.stdin.setEncoding("utf8");
      child.stdin.on("finish", close);
      child.stdin.on("data", (chunk) => {
        for (const line of String(chunk).split("\n")) {
          if (!line.trim()) continue;
          const request = JSON.parse(line) as Record<string, unknown>;
          const method = String(request.method);
          if (method === "turn/steer" || method === "turn/interrupt")
            providerMethods[currentTurn]?.push(method);
          if (method === "initialize") {
            send({
              id: request.id,
              result: {
                userAgent: "fixture",
                codexHome: "/tmp",
                platformFamily: "unix",
                platformOs: "test",
              },
            });
          } else if (method === "thread/start") {
            send({ id: request.id, result: { thread: { id: threadId } } });
          } else if (method === "turn/start") {
            currentTurn++;
            turnId = `turn-${iteration}-${currentTurn}`;
            send({
              id: request.id,
              result: { turn: { id: turnId, status: "inProgress" } },
            });
            releaseTurn[currentTurn]?.();
          } else if (method === "turn/interrupt") {
            send({
              method: "turn/completed",
              params: {
                threadId,
                turn: {
                  id: turnId,
                  items: [],
                  status: "interrupted",
                  error: null,
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                },
              },
            });
          }
        }
      });
      return child as unknown as ChildProcess;
    };
    const adapter = createCodexHarness({ spawn, killEscalationMs: 1 }).prepare({
      config: agent({ harness: "codex" }),
      cwd: "/work",
      childDepth: 1,
      projectTrusted: true,
    });
    const runs = createSubagentRuns();

    for (let currentAttempt = 0; currentAttempt < 2; currentAttempt++) {
      const started = dispatchSubagentRun({
        subagentId: `subagent-${iteration}`,
        agent: "worker",
        harness: "codex",
        description: `attempt ${currentAttempt}`,
        prompt: `prompt ${currentAttempt}`,
        adapter,
        runs,
      });
      await turnReady[currentAttempt];
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });

      const offer = () =>
        runs.offer(started.id, {
          type: "steer",
          text: `guidance ${iteration}-${currentAttempt}`,
        });
      if (order === "control-first") {
        assert.equal(offer(), "accepted");
        assert.deepEqual(runs.cancel([started.id], "requested"), [started.id]);
      } else {
        assert.deepEqual(runs.cancel([started.id], "requested"), [started.id]);
        assert.equal(offer(), "not steerable");
      }

      assert.equal((await started.settled).lifecycle.phase, "cancelled");
      assert.deepEqual(
        providerMethods[currentAttempt],
        order === "control-first"
          ? ["turn/steer", "turn/interrupt"]
          : ["turn/interrupt"],
      );
    }

    await adapter.close();
    assert.equal(spawnCount, 1, "both cancelled Runs retain one App Server");
  }
}

test("accepted steering enters first and resumed Codex Turns before synchronous later cancellation", async () => {
  await proveCodexControlOrder("control-first");
});

test("cancellation-first closes first and resumed Codex Turns before later steering", async () => {
  await proveCodexControlOrder("cancellation-first");
});

test("the selected harness resolves models without exposing effort", () => {
  const harness = createPiHarness();
  const context: SubagentContext = {
    config: agent({ model: "sonnet", effort: "high" }),
    cwd: "/tmp",
    childDepth: 1,
    projectTrusted: false,
    parentModel: {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "low",
    },
  };
  const prepared = harness.prepare(context);
  assert.equal(prepared.model, "sonnet");
  assert.equal("effort" in prepared, false);
  const inherited = harness.prepare({ ...context, config: agent() });
  assert.equal(inherited.model, "anthropic/claude-opus-4-5");
  assert.equal("effort" in inherited, false);
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
  assert.equal(reported.lifecycle.phase, "completed");
  assert.equal(reported.startedAt, 1_000);
  assert.equal(
    "finishedAt" in reported.lifecycle
      ? reported.lifecycle.finishedAt
      : undefined,
    4_500,
  );
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
    { ending: { ending: "answered" }, expected: "completed" },
    { ending: { ending: "failed" }, expected: "failed" },
    {
      ending: { ending: "cancelled" },
      expected: "cancelled",
    },
  ] as const;

  for (const { expected, ending } of cases) {
    const execute: SubagentExecutor = async () => ending;
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

test("live activity is display-only, deduplicated, and cleared on settlement", async () => {
  const runs = createSubagentRuns();
  let notifications = 0;
  runs.subscribe(() => {
    notifications++;
  });
  const started = startSubagent({
    config: agent(),
    description: "task",
    prompt: "go",
    runs,
    execute: async (run) => {
      const beforeActivity = notifications;
      run.report.activity("Reading files");
      assert.equal(notifications, beforeActivity + 1);
      run.report.activity("Reading files");
      assert.equal(notifications, beforeActivity + 1);
      run.report.activity("   ");
      assert.equal(notifications, beforeActivity + 2);
      run.report.activity("Reading files");
      assert.equal(notifications, beforeActivity + 3);
      run.report.message({
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        usage: { turns: 1 },
      });
      const view = runs.list()[0];
      assert.equal(view?.activity, "Reading files");
      assert.equal(view?.status, "running");
      return { ending: "answered" };
    },
  });

  const result = await started.settled;
  assert.equal(result.liveActivity, undefined);
  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(getFinalOutput(result.messages), "answer");
  assert.equal(runs.list()[0]?.activity, undefined);
});

test("the fold derives usage and activity from reported messages", async () => {
  const execute: SubagentExecutor = async (run) => {
    run.report.message({
      role: "assistant",
      parts: [
        { type: "tool_call", name: "grep", arguments: { pattern: "TODO" } },
      ],
      usage: { input: 7, cost: 0.5, turns: 1 },
    });
    run.report.message({
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
      usage: { input: 3, cost: 0.25, turns: 1 },
    });
    return { ending: "answered" };
  };

  const result = await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "go",
    execute,
  });

  // Derived, not reported: the executor named a message, and the dispatcher's
  // fold worked out what it means for usage and activity.
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.input, 10);
  assert.equal(result.usage.cost, 0.75);
  assert.equal(result.activity, "grep: TODO");
});

test("an authoritative streamed model replaces the harness baseline", async () => {
  const result = await startAndSettle({
    config: agent({ model: "baseline-model" }),
    description: "task",
    prompt: "go",
    execute: async (run) => {
      run.report.message({
        role: "assistant",
        parts: [{ type: "text", text: "authoritative" }],
        model: "terminal-model",
      });
      return { ending: "answered" };
    },
  });

  assert.equal(result.model, "terminal-model");
});

test("a terminal transcript model replaces a stale streamed model", async () => {
  const result = await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "go",
    execute: async (run) => {
      run.report.message({
        role: "assistant",
        parts: [{ type: "text", text: "stale" }],
        model: "stale-model",
      });
      run.report.transcript([
        {
          role: "assistant",
          parts: [{ type: "text", text: "authoritative" }],
          model: "terminal-model",
        },
      ]);
      return { ending: "answered" };
    },
  });

  assert.equal(result.model, "terminal-model");
});

test("a terminal transcript removes a stale fact-derived model", async () => {
  const result = await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "go",
    execute: async (run) => {
      run.report.message({
        role: "assistant",
        parts: [{ type: "text", text: "stale" }],
        model: "stale-model",
      });
      run.report.transcript([
        { role: "assistant", parts: [{ type: "text", text: "authoritative" }] },
      ]);
      return { ending: "answered" };
    },
  });

  assert.equal("model" in result, false);
});

test("transcript healing preserves the harness-resolved baseline model", async () => {
  const result = await startAndSettle({
    config: agent({ model: "baseline-model" }),
    description: "task",
    prompt: "go",
    execute: async (run) => {
      run.report.message({
        role: "assistant",
        parts: [{ type: "text", text: "stale" }],
        model: "stale-model",
      });
      run.report.transcript([
        { role: "assistant", parts: [{ type: "text", text: "authoritative" }] },
      ]);
      return { ending: "answered" };
    },
  });

  assert.equal(result.model, "baseline-model");
});

test("a transcript snapshot replaces the streamed fold, healing usage", async () => {
  const execute: SubagentExecutor = async (run) => {
    run.report.message(assistantMessage());
    run.report.message(assistantMessage());
    run.report.transcript([assistantMessage()]);
    return { ending: "answered" };
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

test("startSubagent does not retain effort on the result", async () => {
  const recorded = recordingExecutor();
  const result = await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
  });

  assert.equal("effort" in result, false);
});

test("the standalone one-Run test composition closes its adapter after settlement", async () => {
  let adapter: HarnessAdapter | undefined;
  let releaseCount = 0;
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () => {
      let closed = false;
      adapter = controlledAdapter(
        () => ({
          supportedControls: [],
          execute: async (run) => {
            run.report.message(assistantMessage());
            return { ending: "answered" };
          },
        }),
        async () => {
          if (closed) return;
          closed = true;
          releaseCount++;
        },
      );
      return adapter;
    },
  };
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    harnesses: createHarnessRegistry([harness]),
    runs: createSubagentRuns(),
  });

  assert.equal((await started.settled).lifecycle.phase, "completed");
  assert.equal(releaseCount, 1);
  await adapter?.close();
  await adapter?.close();
  assert.equal(releaseCount, 1);
});

// ── Cancellation ──────────────────────────────────────────────────────────────

test("a run cancelled before execution closes its adapter without invoking it", async () => {
  let executorCalls = 0;
  let closeCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(
        () => ({
          supportedControls: [],
          execute: async () => {
            executorCalls++;
            return { ending: "answered" };
          },
        }),
        async () => {
          closeCalls++;
        },
      ),
  };
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    signal: controller.signal,
    harnesses: createHarnessRegistry([harness]),
    runs: createSubagentRuns(),
  });

  assert.equal((await started.settled).lifecycle.phase, "cancelled");
  assert.equal(executorCalls, 0);
  assert.equal(closeCalls, 1);
});

test("a run cancelled before it starts never spawns a child", async () => {
  let executorCalls = 0;
  const execute: SubagentExecutor = async () => {
    executorCalls++;
    return { ending: "answered" };
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
  assert.equal(result.stopReason, undefined);
  assert.doesNotMatch(
    result.errorMessage ?? "",
    /aborted/,
    "backend cancellation vocabulary does not escape the seam",
  );
  assert.equal(
    "finishedAt" in result.lifecycle ? result.lifecycle.finishedAt : undefined,
    500,
  );
});

test("a Control admitted before cancellation may be discarded without changing the cancelled ending", async () => {
  let executorReady = () => {};
  const ready = new Promise<void>((resolve) => {
    executorReady = resolve;
  });
  let allowConsumption = () => {};
  const consumptionGate = new Promise<void>((resolve) => {
    allowConsumption = resolve;
  });
  const consumed: string[] = [];
  let closeCalls = 0;
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(
        () => ({
          supportedControls: ["steer"],
          execute: async (run) => {
            executorReady();
            await consumptionGate;
            run.controls.subscribe((admission) => {
              consumed.push(admission.control.text);
              admission.acknowledge();
            });
            return run.signal?.aborted
              ? { ending: "cancelled" }
              : { ending: "answered" };
          },
        }),
        async () => {
          closeCalls++;
        },
      ),
  };
  const runs = createSubagentRuns();
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  await ready;

  assert.equal(
    runs.offer(started.id, { type: "steer", text: "admitted first" }),
    "accepted",
  );
  assert.deepEqual(runs.cancel([started.id], "requested"), [started.id]);
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "after cancellation" }),
    "not steerable",
  );
  allowConsumption();

  const result = await started.settled;
  assert.deepEqual(consumed, []);
  assert.equal(result.lifecycle.phase, "cancelled");
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "requested");
  }
  assert.equal(closeCalls, 1);
});

test("external cancellation uses the Registry cancellation linearization point", async () => {
  let executorReady = () => {};
  const ready = new Promise<void>((resolve) => {
    executorReady = resolve;
  });
  const external = new AbortController();
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(() => ({
        supportedControls: ["steer"],
        execute: async (run) => {
          executorReady();
          await new Promise<void>((resolve) => {
            if (run.signal?.aborted) resolve();
            else
              run.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return { ending: "cancelled" };
        },
      })),
  };
  const runs = createSubagentRuns();
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    signal: external.signal,
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  await ready;

  external.abort();
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "too late" }),
    "not steerable",
  );
  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "cancelled");
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "requested");
  }
});

test("startup failure closes a controlled Run source without draining it", async () => {
  let sourceClosed: Promise<void> | undefined;
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(() => ({
        supportedControls: ["steer"],
        execute: async (run) => {
          sourceClosed = new Promise<void>((resolve) => {
            run.controls.subscribe(
              () => assert.fail("startup failure consumed a Control"),
              resolve,
            );
          });
          throw new Error("startup failed");
        },
      })),
  };
  const runs = createSubagentRuns();
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "failed");
  await sourceClosed;
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "too late" }),
    "already failed",
  );
});

test("settlement before Control subscription discards early admission", async () => {
  let finishExecutor = () => {};
  const finishing = new Promise<void>((resolve) => {
    finishExecutor = resolve;
  });
  let controls: ControlSource | undefined;
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () =>
      controlledAdapter(() => ({
        supportedControls: ["steer"],
        execute: async (run) => {
          controls = run.controls;
          await finishing;
          return { ending: "answered" };
        },
      })),
  };
  const runs = createSubagentRuns();
  const started = dispatchSubagent({
    config: agent({ harness: "controlled" }),
    description: "task",
    prompt: "work",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "discard on settlement" }),
    "accepted",
  );

  finishExecutor();
  assert.equal((await started.settled).lifecycle.phase, "completed");

  let closed = false;
  controls?.subscribe(
    () => assert.fail("settlement retained early Control admission"),
    () => {
      closed = true;
    },
  );
  assert.equal(closed, true);
});

// ── Registry ──────────────────────────────────────────────────────────────────

test("an unregistered harness name fails loudly at dispatch", () => {
  assert.throws(
    () =>
      dispatchSubagent({
        config: agent({ harness: "claude" }),
        description: "task",
        prompt: "do it",
        harnesses: createHarnessRegistry([]),
        runs: createSubagentRuns(),
      }),
    /No harness registered for 'claude'/,
  );
});

test("a started run stays tracked after it settles, until its delivery", async () => {
  const runs = createSubagentRuns();
  const seen: number[] = [];
  const execute: SubagentExecutor = async () => {
    seen.push(runs.list().length);
    return { ending: "answered" };
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
  assert.equal(runs.list().length, 1, "settling does not release the run");
});

test("a cancellation reason survives registry release until settlement", async () => {
  const runs = createSubagentRuns();
  let finish: (ending: RunEnding) => void = () => {};
  const execute: SubagentExecutor = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const started = startSubagent({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute,
    runs,
  });

  runs.cancel([started.id], "shutdown");
  runs.release(started.id);
  finish({ ending: "cancelled" });
  const result = await started.settled;

  assert.equal(result.lifecycle.phase, "cancelled");
  assert.equal(result.stopReason, undefined);
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "shutdown");
  }
});

test("a backend aborted stop fact never persists in the domain result", async () => {
  const result = await startAndSettle({
    config: agent(),
    description: "cancelled",
    prompt: "go",
    execute: async (run) => {
      run.report.message({
        role: "assistant",
        parts: [],
        stopReason: "aborted",
      });
      return { ending: "answered" };
    },
  });

  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.stopReason, undefined);
});

test("the registry can cancel one run without touching the turn", async () => {
  const runs = createSubagentRuns();
  let sawAbort = false;
  const execute: SubagentExecutor = async (run) => {
    const [id] = runs.list().map((view) => view.id);
    runs.cancel([id], "requested");
    sawAbort = run.signal?.aborted ?? false;
    return { ending: "cancelled" };
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
    observations: recorded,
  });

  assert.equal(recorded.contexts[0].projectTrusted, true);
});

test("startSubagent denies project trust when the caller reports none", async () => {
  const recorded = recordingExecutor();

  await startAndSettle({
    config: agent(),
    description: "task",
    prompt: "do it",
    execute: recorded.execute,
    observations: recorded,
  });

  // A caller that says nothing must not be read as trusting the directory.
  assert.equal(recorded.contexts[0].projectTrusted, false);
});
