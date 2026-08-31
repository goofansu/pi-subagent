import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  type ControlSource,
  createControlSource,
} from "../../control-source.ts";
import {
  DEPTH_ENV_KEY,
  type RunControl,
  type RunReporter,
  type SubagentContext,
  type SubagentTask,
} from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "../conformance.ts";
import type { Harness, HarnessRun } from "../contract.ts";
import {
  type ChildProcessSpawn,
  type CodexAppServerEvent,
  type CodexAppServerSessionOptions,
  type CodexAppServerTurnOptions,
  createCodexAppServerSession,
} from "./app-server.ts";
import { codexEffort, createCodexHarness } from "./harness.ts";

function prepareCodexRun(
  harness: Harness,
  input: SubagentContext & SubagentTask,
): HarnessRun {
  const { description, prompt, ...context } = input;
  return harness.prepare(context).prepareRun({ description, prompt });
}

function controlsFrom(...controls: RunControl[]): ControlSource {
  const source = createControlSource();
  for (const control of controls)
    assert.equal(source.offer(control), "accepted");
  return source.controls;
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal: string): boolean;
  signals: string[];
  finish(code: number | null): void;
}

function fakeChild(
  onRequest: (request: Record<string, unknown>, child: FakeChild) => void,
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  let closed = false;
  child.stdin.setEncoding("utf8");
  child.stdin.on("finish", () => child.finish(0));
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      onRequest(JSON.parse(line) as Record<string, unknown>, child);
    }
  });
  child.kill = ((signal: string) => {
    child.signals.push(signal);
    return true;
  }) as FakeChild["kill"];
  child.finish = (code) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", code, null));
  };
  return child;
}

function send(child: FakeChild, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runCodexAppServer(
  options: CodexAppServerSessionOptions & CodexAppServerTurnOptions,
) {
  const {
    prompt,
    report,
    signal,
    controls,
    missingAnswerMessage,
    ...sessionOptions
  } = options;
  const session = createCodexAppServerSession(sessionOptions);
  try {
    return await session.runNextTurn({
      prompt,
      report,
      ...(signal ? { signal } : {}),
      ...(controls ? { controls } : {}),
      missingAnswerMessage,
    });
  } finally {
    await session.close();
  }
}

function createTestAppServerRun(
  options: CodexAppServerSessionOptions & { readonly prompt: string },
) {
  return (
    sink: {
      message?(fact: Parameters<RunReporter["message"]>[0]): void;
      stderr(chunk: string): void;
    },
    signal: AbortSignal,
  ) =>
    runCodexAppServer({
      ...options,
      report: {
        message: (fact) => sink.message?.(fact),
        transcript: () => {},
        activity: () => {},
        stderr: sink.stderr,
      },
      signal,
      missingAnswerMessage: "missing answer",
    });
}

const THREAD_ID = "thread-provider-id";
const TURN_ID = "turn-provider-id";

interface ConformanceObservation {
  child?: FakeChild;
  depth?: number;
  receivedControlTexts: string[];
  providerControlStarts: number;
  activeProviderControls: number;
  maxConcurrentProviderControls: number;
  releaseProviderControl?: () => void;
  openIntermediate?: () => void;
}

function event(
  method: string,
  params: Record<string, unknown>,
): CodexAppServerEvent {
  return { method, params } as CodexAppServerEvent;
}

function initializeResponse(id: unknown): Record<string, unknown> {
  return {
    id,
    result: {
      userAgent: "fixture",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "test",
    },
  };
}
function itemCompleted(item: Record<string, unknown>): CodexAppServerEvent {
  return event("item/completed", {
    item,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    completedAtMs: 1,
  });
}

function agent(
  text: string,
  phase: string | undefined = "final_answer",
): CodexAppServerEvent {
  return itemCompleted({
    type: "agentMessage",
    id: `message-${text}`,
    text,
    ...(phase === undefined ? {} : { phase }),
  });
}
function completedTurn(status = "completed"): CodexAppServerEvent {
  return event("turn/completed", {
    threadId: THREAD_ID,
    turn: {
      id: TURN_ID,
      items: [],
      status,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  });
}

function appServerSpawn(
  scenario: HarnessConformanceScenario,
  observed: ConformanceObservation,
  ready: { resolve?: (value?: undefined) => void },
): ChildProcessSpawn {
  return (_command, args, options) => {
    assert.deepEqual(args, ["app-server"]);
    assert.equal(options.cwd, process.cwd());
    observed.depth = Number(options.env?.[DEPTH_ENV_KEY]);
    assert.equal(options.env?.PATH, process.env.PATH);
    const child = fakeChild((request, current) => {
      const id = request.id;
      const method = request.method;
      if (method === "initialize") {
        send(current, {
          id,
          result: {
            userAgent: "fixture",
            codexHome: "/tmp",
            platformFamily: "unix",
            platformOs: "test",
          },
        });
      } else if (method === "thread/start") {
        send(current, {
          id,
          result: { thread: { id: THREAD_ID, ephemeral: true } },
        });
      } else if (method === "turn/start") {
        send(current, {
          id,
          result: { turn: { id: TURN_ID, status: "inProgress" } },
        });
        queueMicrotask(() => {
          switch (scenario) {
            case "backend-crash":
              current.stdout.write("fixture crash tail");
              current.finish(1);
              break;
            case "abort-mid-run":
            case "terminal-answer-then-abort":
              if (scenario === "terminal-answer-then-abort")
                send(current, agent("codex answer"));
              ready.resolve?.();
              break;
            case "usage-totals":
              send(
                current,
                event("thread/tokenUsage/updated", {
                  threadId: THREAD_ID,
                  turnId: TURN_ID,
                  tokenUsage: {
                    total: {
                      totalTokens: 10,
                      inputTokens: 7,
                      cachedInputTokens: 2,
                      cacheWriteInputTokens: 1,
                      outputTokens: 2,
                      reasoningOutputTokens: 1,
                    },
                    last: {
                      totalTokens: 10,
                      inputTokens: 7,
                      cachedInputTokens: 2,
                      cacheWriteInputTokens: 1,
                      outputTokens: 2,
                      reasoningOutputTokens: 1,
                    },
                    modelContextWindow: 100,
                  },
                }),
              );
              send(
                current,
                event("thread/tokenUsage/updated", {
                  threadId: THREAD_ID,
                  turnId: TURN_ID,
                  tokenUsage: {
                    total: {
                      totalTokens: 25,
                      inputTokens: 15,
                      cachedInputTokens: 5,
                      cacheWriteInputTokens: 2,
                      outputTokens: 6,
                      reasoningOutputTokens: 2,
                    },
                    last: {
                      totalTokens: 15,
                      inputTokens: 8,
                      cachedInputTokens: 3,
                      cacheWriteInputTokens: 1,
                      outputTokens: 4,
                      reasoningOutputTokens: 1,
                    },
                    modelContextWindow: 100,
                  },
                }),
              );
              send(current, agent("usage answer"));
              send(current, completedTurn());
              break;
            case "child-depth":
            case "config-immutable":
            case "post-answer-failure":
              send(current, agent("codex answer"));
              if (scenario === "post-answer-failure") current.finish(7);
              else send(current, completedTurn());
              break;
            case "no-terminal-answer":
              send(current, completedTurn());
              break;
            case "terminal-transcript-healing":
              send(current, agent("codex draft"));
              send(current, agent("codex final answer"));
              send(current, completedTurn());
              break;
            case "steering-single-consumed":
            case "steering-fifo-consumed":
            case "steering-intermediate-completion":
            case "steering-admission-no-fact":
              ready.resolve?.();
              break;
          }
        });
      } else if (method === "turn/steer") {
        const params = request.params as Record<string, unknown>;
        const input = params.input as Array<Record<string, unknown>>;
        const text = input[0]?.text;
        assert.equal(typeof text, "string");
        observed.providerControlStarts++;
        observed.activeProviderControls++;
        observed.maxConcurrentProviderControls = Math.max(
          observed.maxConcurrentProviderControls,
          observed.activeProviderControls,
        );
        observed.receivedControlTexts.push(text as string);
        if (observed.providerControlStarts === 1) observed.openIntermediate?.();
        const expectedControls = scenario === "steering-fifo-consumed" ? 2 : 1;
        const acknowledge = (): void => {
          send(current, { id, result: {} });
          if (scenario !== "steering-admission-no-fact") {
            send(
              current,
              itemCompleted({
                type: "userMessage",
                id: `confirmed-${observed.providerControlStarts}`,
                clientId: params.clientUserMessageId,
                content: [
                  {
                    type: "text",
                    text: `confirmed: ${text as string}`,
                    text_elements: [],
                  },
                ],
              }),
            );
          }
          observed.activeProviderControls--;
          if (observed.providerControlStarts === expectedControls) {
            send(current, agent("controlled answer"));
            send(current, completedTurn());
          }
        };
        if (observed.providerControlStarts === 1)
          observed.releaseProviderControl = acknowledge;
        else acknowledge();
      } else if (method === "turn/interrupt") {
        send(current, { id, result: {} });
        send(current, completedTurn("interrupted"));
      }
    });
    observed.child = child;
    return child as unknown as ChildProcess;
  };
}

function conformanceRig(): HarnessConformanceRig {
  return {
    name: "codex",
    build(scenario): HarnessConformanceFixture {
      const observed: ConformanceObservation = {
        receivedControlTexts: [],
        providerControlStarts: 0,
        activeProviderControls: 0,
        maxConcurrentProviderControls: 0,
      };
      const readyState: { resolve?: () => void } = {};
      const readyForCancellation = new Promise<void>((resolve) => {
        readyState.resolve = resolve;
      });
      const intermediateCheckpoint = new Promise<void>((resolve) => {
        observed.openIntermediate = resolve;
      });
      const harness = createCodexHarness({
        spawn: appServerSpawn(scenario, observed, readyState),
        killEscalationMs: 10,
      });
      const base = (
        expected: HarnessConformanceFixture["expected"],
      ): HarnessConformanceFixture => ({
        harness,
        expected,
        ...(scenario === "abort-mid-run" ||
        scenario === "terminal-answer-then-abort"
          ? { readyForCancellation }
          : {}),
        depthProbe: () => observed.depth,
      });
      switch (scenario) {
        case "backend-crash":
          return base({
            phase: "failed",
            errorMessage: "Child codex exited with code 1",
            stderrIncludes: "Last stdout:",
          });
        case "abort-mid-run":
          return base({
            phase: "cancelled",
            cancellationReason: "requested",
            stderrExcludes: "Last stdout:",
          });
        case "terminal-answer-then-abort":
          return base({
            phase: "completed",
            finalOutput: "codex answer",
            errorMessage: undefined,
          });
        case "usage-totals":
          return base({
            phase: "completed",
            usage: {
              input: 15,
              output: 8,
              cacheRead: 5,
              cacheWrite: 2,
              cost: 0,
              contextTokens: 15,
              turns: 2,
            },
          });
        case "child-depth":
          return base({ phase: "completed", childDepth: 1 });
        case "config-immutable":
          return base({ phase: "completed" });
        case "no-terminal-answer":
          return base({
            phase: "failed",
            errorMessage:
              "Codex exited without a terminal agent message answer.",
          });
        case "post-answer-failure":
          return base({
            phase: "completed",
            finalOutput: "codex answer",
            errorMessage: undefined,
            stderrExcludes: "Last stdout:",
          });
        case "terminal-transcript-healing":
          return base({
            phase: "completed",
            finalOutput: "codex final answer",
            messageCount: 2,
          });
        case "steering-single-consumed":
        case "steering-fifo-consumed":
        case "steering-intermediate-completion":
        case "steering-admission-no-fact": {
          const offeredTexts =
            scenario === "steering-fifo-consumed"
              ? ["first guidance", "second guidance"]
              : ["first guidance"];
          const fixture = base({
            phase: "completed",
            finalOutput: "controlled answer",
            userFactTexts:
              scenario === "steering-admission-no-fact"
                ? []
                : offeredTexts.map((text) => `confirmed: ${text}`),
          });
          return {
            ...fixture,
            steering: {
              ready: readyForCancellation,
              offeredTexts,
              expectedOutcome: "accepted",
              release: () => {
                assert.ok(observed.releaseProviderControl);
                const release = observed.releaseProviderControl;
                observed.releaseProviderControl = undefined;
                release();
              },
              receivedTexts: () => observed.receivedControlTexts,
              providerControlStarts: () => observed.providerControlStarts,
              maxConcurrentProviderControls: () =>
                observed.maxConcurrentProviderControls,
              ...(scenario === "steering-intermediate-completion"
                ? { intermediateCheckpoint }
                : {}),
            },
          };
        }
      }
    },
  };
}

runHarnessConformance(conformanceRig());

test("Codex App Server sends the ephemeral handshake and one prompt", async () => {
  const writes: Record<string, unknown>[] = [];
  const child = fakeChild((request, current) => {
    writes.push(request);
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    if (request.method === "turn/start") {
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
      send(current, agent("answer"));
      send(current, completedTurn());
    }
  });
  const source = createTestAppServerRun({
    cwd: "/work",
    childDepth: 1,
    prompt: "system\n\nuser",
    model: "gpt",
    effort: "none",
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const sink = { stderr: () => {} };
  assert.deepEqual(await source(sink, new AbortController().signal), {
    ending: "answered",
  });
  assert.deepEqual(
    writes.map((write) => write.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );
  assert.deepEqual(writes[0]?.params, {
    clientInfo: { name: "pi-subagent", title: "pi-subagent", version: "1.0.0" },
    capabilities: null,
  });
  assert.deepEqual(writes[2]?.params, {
    cwd: "/work",
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model: "gpt",
    config: { model_reasoning_effort: "none" },
  });
  assert.deepEqual(writes[3]?.params, {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "system\n\nuser", text_elements: [] }],
  });
});

test("a prepared Codex adapter lazily retains one ephemeral session across clean Runs", async () => {
  const requests: Record<string, unknown>[] = [];
  const signals: string[] = [];
  let spawnCount = 0;
  let turnNumber = 0;
  let closeCount = 0;
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize") {
      send(current, initializeResponse(request.id));
      return;
    }
    if (request.method === "thread/start") {
      send(current, {
        id: request.id,
        result: { thread: { id: THREAD_ID, turns: [] } },
      });
      return;
    }
    if (request.method !== "turn/start") return;

    turnNumber++;
    const turnId = `retained-adapter-turn-${turnNumber}`;
    send(current, {
      id: request.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    const usage =
      turnNumber === 1
        ? { total: 10, input: 7, cacheRead: 2, output: 1, context: 8 }
        : { total: 16, input: 11, cacheRead: 3, output: 2, context: 6 };
    send(
      current,
      event("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId,
        tokenUsage: {
          total: {
            totalTokens: usage.total,
            inputTokens: usage.input,
            cachedInputTokens: usage.cacheRead,
            cacheWriteInputTokens: 0,
            outputTokens: usage.output,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: usage.context,
            inputTokens: usage.input,
            cachedInputTokens: usage.cacheRead,
            cacheWriteInputTokens: 0,
            outputTokens: usage.output,
            reasoningOutputTokens: 0,
          },
        },
      }),
    );
    send(
      current,
      event("item/completed", {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: "agentMessage",
          id: `retained-answer-${turnNumber}`,
          text: turnNumber === 1 ? "first answer" : "second retained answer",
          phase: "final_answer",
        },
        completedAtMs: turnNumber,
      }),
    );
    send(
      current,
      event("turn/completed", {
        threadId: THREAD_ID,
        turn: { id: turnId, items: [], status: "completed", error: null },
      }),
    );
  });
  child.on("close", () => closeCount++);
  const originalKill = child.kill;
  child.kill = (signal) => {
    signals.push(signal);
    return originalKill(signal);
  };
  const adapter = createCodexHarness({
    spawn: () => {
      spawnCount++;
      return child as unknown as ChildProcess;
    },
  }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: { model: "gpt-fixed", effort: "high" },
      systemPrompt: "fixed profile role",
    },
    cwd: "/fixed/work",
    childDepth: 1,
    projectTrusted: false,
  });
  assert.equal(spawnCount, 0);
  const execute = async (prompt: string) => {
    const facts: Parameters<RunReporter["message"]>[0][] = [];
    const ending = await adapter
      .prepareRun({ description: prompt, prompt })
      .execute({
        report: {
          message: (fact) => facts.push(fact),
          transcript: () => {},
          activity: () => {},
          stderr: () => {},
        },
        controls: controlsFrom(),
      });
    return { ending, facts };
  };

  const first = await execute("first prompt");
  assert.deepEqual(first.ending, { ending: "answered" });
  assert.equal(spawnCount, 1);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(closeCount, 0);
  const second = await execute("second prompt only");
  assert.deepEqual(second.ending, { ending: "answered" });
  assert.equal(spawnCount, 1);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(closeCount, 0);

  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "initialized", "thread/start", "turn/start", "turn/start"],
  );
  assert.deepEqual(requests[2]?.params, {
    cwd: "/fixed/work",
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model: "gpt-fixed",
    config: { model_reasoning_effort: "high" },
  });
  assert.deepEqual(
    requests
      .filter((request) => request.method === "turn/start")
      .map((request) => request.params),
    [
      {
        threadId: THREAD_ID,
        input: [
          {
            type: "text",
            text: "fixed profile role\n\nfirst prompt",
            text_elements: [],
          },
        ],
      },
      {
        threadId: THREAD_ID,
        input: [
          { type: "text", text: "second prompt only", text_elements: [] },
        ],
      },
    ],
  );
  assert.deepEqual(
    first.facts.find((fact) => fact.role === "metadata")?.usage,
    {
      input: 7,
      cacheRead: 2,
      cacheWrite: 0,
      output: 1,
      contextTokens: 8,
      turns: 1,
    },
  );
  assert.deepEqual(
    second.facts.find((fact) => fact.role === "metadata")?.usage,
    {
      input: 4,
      cacheRead: 1,
      cacheWrite: 0,
      output: 1,
      contextTokens: 6,
      turns: 1,
    },
  );

  await adapter.close();
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(closeCount, 1);
  assert.deepEqual(signals, []);
  assert.equal(child.listenerCount("close"), 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("pre-spawn cancellation preserves the profile prompt for the first provider Turn", async () => {
  const requests: Record<string, unknown>[] = [];
  let spawnCount = 0;
  let turnNumber = 0;
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize") {
      send(current, initializeResponse(request.id));
      return;
    }
    if (request.method === "thread/start") {
      send(current, {
        id: request.id,
        result: { thread: { id: THREAD_ID, turns: [] } },
      });
      return;
    }
    if (request.method !== "turn/start") return;

    turnNumber++;
    const turnId = `first-provider-turn-${turnNumber}`;
    send(current, {
      id: request.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    send(
      current,
      event("item/completed", {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: "agentMessage",
          id: `answer-${turnNumber}`,
          text: `answer ${turnNumber}`,
          phase: "final_answer",
        },
        completedAtMs: turnNumber,
      }),
    );
    send(
      current,
      event("turn/completed", {
        threadId: THREAD_ID,
        turn: { id: turnId, items: [], status: "completed", error: null },
      }),
    );
  });
  const adapter = createCodexHarness({
    spawn: () => {
      spawnCount++;
      return child as unknown as ChildProcess;
    },
  }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "fixed profile role",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const execute = (prompt: string, signal?: AbortSignal) =>
    adapter.prepareRun({ description: prompt, prompt }).execute({
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      ...(signal ? { signal } : {}),
      controls: controlsFrom(),
    });
  const cancelled = new AbortController();
  cancelled.abort();

  assert.deepEqual(await execute("cancelled before spawn", cancelled.signal), {
    ending: "cancelled",
  });
  assert.equal(spawnCount, 0);
  assert.equal(
    adapter.admitResume({ description: "resume", prompt: "continue" }).outcome,
    "admitted",
  );
  assert.deepEqual(await execute("first actual task"), { ending: "answered" });
  assert.deepEqual(await execute("later task only"), { ending: "answered" });

  assert.equal(spawnCount, 1);
  assert.deepEqual(
    requests
      .filter((request) => request.method === "turn/start")
      .map((request) => request.params),
    [
      {
        threadId: THREAD_ID,
        input: [
          {
            type: "text",
            text: "fixed profile role\n\nfirst actual task",
            text_elements: [],
          },
        ],
      },
      {
        threadId: THREAD_ID,
        input: [{ type: "text", text: "later task only", text_elements: [] }],
      },
    ],
  );

  await adapter.close();
});

test("adapter close before a resumed executor reaches the session settles cancelled without a write", async () => {
  const requests: Record<string, unknown>[] = [];
  let turnId = "first-turn";
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize") {
      send(current, initializeResponse(request.id));
      return;
    }
    if (request.method === "thread/start") {
      send(current, {
        id: request.id,
        result: { thread: { id: THREAD_ID, turns: [] } },
      });
      return;
    }
    if (request.method !== "turn/start") return;
    send(current, {
      id: request.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    send(
      current,
      event("item/completed", {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: "agentMessage",
          id: "first-answer",
          text: "first answer",
          phase: "final_answer",
        },
        completedAtMs: 1,
      }),
    );
    send(
      current,
      event("turn/completed", {
        threadId: THREAD_ID,
        turn: { id: turnId, items: [], status: "completed", error: null },
      }),
    );
    turnId = "unexpected-second-turn";
  });
  const adapter = createCodexHarness({
    spawn: () => child as unknown as ChildProcess,
  }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "fixed role",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const run = (prompt: string) =>
    adapter.prepareRun({ description: prompt, prompt }).execute({
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      controls: controlsFrom(),
    });

  assert.deepEqual(await run("first task"), { ending: "answered" });
  const resumed = run("never written");
  await adapter.close();

  assert.deepEqual(await resumed, { ending: "cancelled" });
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    1,
  );
});

test("steering and active-Run admission stay scoped across retained adapter Runs", async () => {
  const requests: Record<string, unknown>[] = [];
  const controls = createControlSource();
  let turnNumber = 0;
  let firstTurnReady!: () => void;
  const firstTurnStarted = new Promise<void>((resolve) => {
    firstTurnReady = resolve;
  });
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize") {
      send(current, initializeResponse(request.id));
      return;
    }
    if (request.method === "thread/start") {
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
      return;
    }
    if (request.method === "turn/start") {
      turnNumber++;
      const turnId = `adapter-steered-turn-${turnNumber}`;
      send(current, {
        id: request.id,
        result: { turn: { id: turnId, status: "inProgress" } },
      });
      if (turnNumber === 1) firstTurnReady();
      else {
        send(
          current,
          event("item/completed", {
            threadId: THREAD_ID,
            turnId,
            item: {
              type: "agentMessage",
              id: "after-steering-answer",
              text: "continued after steering",
              phase: "final_answer",
            },
            completedAtMs: 2,
          }),
        );
        send(
          current,
          event("turn/completed", {
            threadId: THREAD_ID,
            turn: { id: turnId, items: [], status: "completed", error: null },
          }),
        );
      }
      return;
    }
    if (request.method === "turn/steer") {
      const params = request.params as Record<string, unknown>;
      send(current, { id: request.id, result: {} });
      send(
        current,
        event("item/completed", {
          threadId: THREAD_ID,
          turnId: "adapter-steered-turn-1",
          item: {
            type: "userMessage",
            id: "confirmed-adapter-guidance",
            clientId: params.clientUserMessageId,
            content: [
              {
                type: "text",
                text: "confirmed adapter guidance",
                text_elements: [],
              },
            ],
          },
          completedAtMs: 1,
        }),
      );
      send(
        current,
        event("item/completed", {
          threadId: THREAD_ID,
          turnId: "adapter-steered-turn-1",
          item: {
            type: "agentMessage",
            id: "steered-answer",
            text: "answer after guidance",
            phase: "final_answer",
          },
          completedAtMs: 1,
        }),
      );
      send(
        current,
        event("turn/completed", {
          threadId: THREAD_ID,
          turn: {
            id: "adapter-steered-turn-1",
            items: [],
            status: "completed",
            error: null,
          },
        }),
      );
    }
  });
  let spawnCount = 0;
  const adapter = createCodexHarness({
    spawn: () => {
      spawnCount++;
      return child as unknown as ChildProcess;
    },
  }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "fixed role",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const execute = (
    prompt: string,
    report: Parameters<RunReporter["message"]>[0][],
    source: ControlSource = controlsFrom(),
  ) =>
    adapter.prepareRun({ description: prompt, prompt }).execute({
      report: {
        message: (fact) => report.push(fact),
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      controls: source,
    });

  const firstFacts: Parameters<RunReporter["message"]>[0][] = [];
  const first = execute("first", firstFacts, controls.controls);
  await firstTurnStarted;
  const overlap = await execute("must not start", []);
  assert.deepEqual(overlap, {
    ending: "failed",
    errorMessage: "Codex adapter already has an active Run",
  });
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    1,
  );
  assert.equal(
    controls.offer({ type: "steer", text: "adapter guidance" }),
    "accepted",
  );
  assert.deepEqual(await first, { ending: "answered" });
  const firstSnapshot = structuredClone(firstFacts);

  const secondFacts: Parameters<RunReporter["message"]>[0][] = [];
  assert.deepEqual(await execute("continue after steering", secondFacts), {
    ending: "answered",
  });
  assert.deepEqual(firstFacts, firstSnapshot);
  assert.deepEqual(
    firstFacts.filter((fact) => fact.role === "user"),
    [
      {
        role: "user",
        parts: [{ type: "text", text: "confirmed adapter guidance" }],
      },
    ],
  );
  assert.equal(
    secondFacts.some((fact) => fact.role === "user"),
    false,
  );
  assert.equal(spawnCount, 1);
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/steer",
      "turn/start",
    ],
  );

  await adapter.close();
  assert.equal(child.stdout.listenerCount("data"), 0);
});

test("parallel Codex Subagent adapters own independent retained sessions and usage baselines", async () => {
  const requests: Array<Record<string, unknown>[]> = [[], []];
  const children: FakeChild[] = [];
  const turnCounts = [0, 0];
  const activeTurnIds: Array<string | undefined> = [undefined, undefined];
  let firstTurnsReady!: () => void;
  const bothFirstTurnsStarted = new Promise<void>((resolve) => {
    firstTurnsReady = resolve;
  });
  let firstTurnsStarted = 0;
  const sendUsage = (
    child: FakeChild,
    threadId: string,
    turnId: string,
    inputTokens: number,
  ): void => {
    send(
      child,
      event("thread/tokenUsage/updated", {
        threadId,
        turnId,
        tokenUsage: {
          total: {
            totalTokens: inputTokens,
            inputTokens,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: inputTokens,
            inputTokens,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        },
      }),
    );
  };
  const complete = (index: number, text: string): void => {
    const child = children[index];
    const turnId = activeTurnIds[index];
    assert.ok(child && turnId);
    const threadId = `parallel-thread-${index + 1}`;
    send(
      child,
      event("item/completed", {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          id: `parallel-answer-${index + 1}-${turnCounts[index]}`,
          text,
          phase: "final_answer",
        },
        completedAtMs: 1,
      }),
    );
    send(
      child,
      event("turn/completed", {
        threadId,
        turn: { id: turnId, items: [], status: "completed", error: null },
      }),
    );
  };
  const spawn: ChildProcessSpawn = (_command, _args, options) => {
    const index = children.length;
    assert.ok(index < 2, "each adapter creates at most one App Server");
    assert.equal(options.cwd, `/parallel/${index + 1}`);
    assert.equal(options.env?.[DEPTH_ENV_KEY], String(index + 1));
    const threadId = `parallel-thread-${index + 1}`;
    const child = fakeChild((request, current) => {
      requests[index]?.push(request);
      if (request.method === "initialize") {
        send(current, initializeResponse(request.id));
        return;
      }
      if (request.method === "thread/start") {
        send(current, { id: request.id, result: { thread: { id: threadId } } });
        return;
      }
      if (request.method !== "turn/start") return;
      const turnNumber = (turnCounts[index] ?? 0) + 1;
      turnCounts[index] = turnNumber;
      const turnId = `parallel-turn-${index + 1}-${turnNumber}`;
      activeTurnIds[index] = turnId;
      send(current, {
        id: request.id,
        result: { turn: { id: turnId, status: "inProgress" } },
      });
      const inputTokens =
        index === 0 ? (turnNumber === 1 ? 7 : 11) : turnNumber === 1 ? 70 : 79;
      sendUsage(current, threadId, turnId, inputTokens);
      if (turnNumber === 1) {
        firstTurnsStarted++;
        if (firstTurnsStarted === 2) firstTurnsReady();
      } else complete(index, `parallel resumed answer ${index + 1}`);
    });
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const harness = createCodexHarness({ spawn });
  const adapters = [0, 1].map((index) =>
    harness.prepare({
      config: {
        name: `codex-${index + 1}`,
        description: "codex",
        harness: "codex",
        fields: {},
        systemPrompt: `role ${index + 1}`,
      },
      cwd: `/parallel/${index + 1}`,
      childDepth: index + 1,
      projectTrusted: false,
    }),
  );
  const execute = async (index: number, prompt: string) => {
    const facts: Parameters<RunReporter["message"]>[0][] = [];
    const adapter = adapters[index];
    assert.ok(adapter);
    const ending = await adapter
      .prepareRun({ description: prompt, prompt })
      .execute({
        report: {
          message: (fact) => facts.push(fact),
          transcript: () => {},
          activity: () => {},
          stderr: () => {},
        },
        controls: controlsFrom(),
      });
    return { ending, facts };
  };

  const firstRuns = [execute(0, "first one"), execute(1, "first two")];
  await bothFirstTurnsStarted;
  assert.equal(children.length, 2);
  assert.equal(
    children.every((child) => !child.stdin.writableEnded),
    true,
  );
  complete(0, "parallel first answer 1");
  complete(1, "parallel first answer 2");
  const first = await Promise.all(firstRuns);
  assert.deepEqual(
    first.map(({ ending }) => ending),
    [{ ending: "answered" }, { ending: "answered" }],
  );

  const second = await Promise.all([
    execute(0, "second one"),
    execute(1, "second two"),
  ]);
  assert.deepEqual(
    second.map(
      ({ facts }) =>
        facts.find((fact) => fact.role === "metadata")?.usage?.input,
    ),
    [4, 9],
  );
  assert.deepEqual(
    requests.map((writes) => writes.map((request) => request.method)),
    [
      ["initialize", "initialized", "thread/start", "turn/start", "turn/start"],
      ["initialize", "initialized", "thread/start", "turn/start", "turn/start"],
    ],
  );
  for (let index = 0; index < requests.length; index++) {
    assert.deepEqual(requests[index]?.[2]?.params, {
      cwd: `/parallel/${index + 1}`,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  }

  await Promise.all(adapters.map((adapter) => adapter.close()));
  for (const child of children) {
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stdin.listenerCount("error"), 0);
  }
});

test("terminal App Server loss disables adapter resume without leaking provider identity", async () => {
  const requests: Record<string, unknown>[] = [];
  const facts: Parameters<RunReporter["message"]>[0][] = [];
  const stderr: string[] = [];
  let turnReady!: () => void;
  const activeTurn = new Promise<void>((resolve) => {
    turnReady = resolve;
  });
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    if (request.method === "thread/start")
      send(current, {
        id: request.id,
        result: { thread: { id: "loss-thread-secret" } },
      });
    if (request.method === "turn/start") {
      send(current, {
        id: request.id,
        result: {
          turn: { id: "loss-turn-secret", status: "inProgress" },
        },
      });
      send(
        current,
        event("item/completed", {
          threadId: "loss-thread-secret",
          turnId: "loss-turn-secret",
          item: {
            type: "agentMessage",
            id: "loss-item-secret",
            text: "partial answer retained",
            phase: "commentary",
          },
          completedAtMs: 1,
        }),
      );
      turnReady();
    }
  });
  let spawnCount = 0;
  const adapter = createCodexHarness({
    spawn: () => {
      spawnCount++;
      return child as unknown as ChildProcess;
    },
  }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "role",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const ending = adapter
    .prepareRun({ description: "lose process", prompt: "lose process" })
    .execute({
      report: {
        message: (fact) => facts.push(fact),
        transcript: () => {},
        activity: () => {},
        stderr: (chunk) => stderr.push(chunk),
      },
      controls: controlsFrom(),
    });
  await activeTurn;
  child.emit(
    "error",
    new Error(
      'lost loss-thread-secret loss-turn-secret loss-item-secret {"requestId":"request-secret"}',
    ),
  );

  const result = await ending;
  assert.equal(result.ending, "failed");
  assert.equal(
    adapter.admitResume({ description: "resume", prompt: "continue" }).outcome,
    "conversation lost",
  );
  assert.deepEqual(facts, [
    {
      role: "assistant",
      parts: [{ type: "text", text: "partial answer retained" }],
      usage: { turns: 0 },
    },
  ]);
  const publicState = JSON.stringify({ result, facts, stderr });
  assert.doesNotMatch(
    publicState,
    /loss-thread-secret|loss-turn-secret|loss-item-secret|request-secret/,
  );
  const writesAfterLoss = requests.length;
  assert.deepEqual(
    await adapter
      .prepareRun({
        description: "must not restart",
        prompt: "must not restart",
      })
      .execute({
        report: {
          message: () => {},
          transcript: () => {},
          activity: () => {},
          stderr: () => {},
        },
        controls: controlsFrom(),
      }),
    {
      ending: "failed",
      errorMessage: "Codex App Server session is closed",
    },
  );
  assert.equal(requests.length, writesAfterLoss);
  assert.equal(spawnCount, 1);

  await adapter.close();
  assert.equal(child.stdout.listenerCount("data"), 0);
});

test("closing a Codex adapter while attaching cancels and fully cleans its session", async () => {
  let child!: FakeChild;
  let spawned!: () => void;
  const didSpawn = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  const adapter = createCodexHarness({
    killEscalationMs: 1,
    spawn: () => {
      child = fakeChild(() => {});
      const originalKill = child.kill;
      child.kill = (signal) => {
        const killed = originalKill(signal);
        if (signal === "SIGTERM") queueMicrotask(() => child.finish(0));
        return killed;
      };
      spawned();
      return child as unknown as ChildProcess;
    },
  }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "fixed role",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const execution = adapter.prepareRun({
    description: "attaching",
    prompt: "wait during initialization",
  });
  const pending = execution.execute({
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    controls: controlsFrom(),
  });
  await didSpawn;

  const firstClose = adapter.close();
  const secondClose = adapter.close();
  await Promise.all([firstClose, secondClose]);

  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
  await adapter.close();
});

test("closing a Codex adapter before spawn preserves the cancelled Ending", async () => {
  let spawnCount = 0;
  const adapter = createCodexHarness({
    spawn: () => {
      spawnCount++;
      return fakeChild(() => {}) as unknown as ChildProcess;
    },
  }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "fixed role",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const execution = adapter.prepareRun({
    description: "pre-spawn cancellation",
    prompt: "must never spawn",
  });

  const pending = execution.execute({
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    controls: controlsFrom(),
  });
  await adapter.close();

  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.equal(spawnCount, 0);
});

test("retained Turns isolate reused item state and stale interleaved notifications", async () => {
  const turnIds = ["turn-first", "turn-failed", "turn-recovery"];
  const requests: Record<string, unknown>[] = [];
  let turnIndex = -1;
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize") {
      send(current, initializeResponse(request.id));
      return;
    }
    if (request.method === "thread/start") {
      send(current, {
        id: request.id,
        result: { thread: { id: THREAD_ID, turns: [] } },
      });
      return;
    }
    if (request.method !== "turn/start") return;

    turnIndex++;
    const turnId = turnIds[turnIndex] as string;
    const priorTurnId = turnIds[turnIndex - 1];
    if (priorTurnId) {
      for (const stale of [
        event("item/agentMessage/delta", {
          threadId: THREAD_ID,
          turnId: priorTurnId,
          itemId: "shared-message",
          delta: "stale message tail",
        }),
        event("item/commandExecution/outputDelta", {
          threadId: THREAD_ID,
          turnId: priorTurnId,
          itemId: "shared-command",
          delta: "stale command tail",
        }),
        event("item/reasoning/summaryTextDelta", {
          threadId: THREAD_ID,
          turnId: priorTurnId,
          itemId: "shared-reasoning",
          delta: "stale reasoning",
          summaryIndex: 0,
        }),
        event("error", {
          threadId: THREAD_ID,
          turnId: priorTurnId,
          error: { message: "stale prior failure" },
          willRetry: false,
        }),
        event("error", {
          threadId: THREAD_ID,
          turnId: priorTurnId,
          error: { message: "stale retry activity" },
          willRetry: true,
        }),
        event("item/completed", {
          threadId: THREAD_ID,
          turnId: priorTurnId,
          item: {
            type: "agentMessage",
            id: "stale-completed-message",
            text: "stale prior output",
            phase: "final_answer",
          },
          completedAtMs: 1,
        }),
        event("turn/completed", {
          threadId: THREAD_ID,
          turn: {
            id: priorTurnId,
            items: [],
            status: "completed",
            error: null,
          },
        }),
      ])
        send(current, stale);
      send(current, {
        method: "future/unknown",
        params: { threadId: THREAD_ID, turnId: priorTurnId },
      });
    }
    send(current, {
      id: request.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    send(
      current,
      event("item/agentMessage/delta", {
        threadId: "foreign-thread",
        turnId,
        itemId: "shared-message",
        delta: "foreign message tail",
      }),
    );
    send(
      current,
      event("item/agentMessage/delta", {
        threadId: THREAD_ID,
        turnId,
        itemId: "shared-message",
        delta:
          turnIndex === 0
            ? "first draft"
            : turnIndex === 1
              ? "second draft"
              : "fresh recovery",
      }),
    );
    if (turnIndex === 0) {
      send(
        current,
        event("item/started", {
          threadId: THREAD_ID,
          turnId,
          item: {
            type: "commandExecution",
            id: "shared-command",
            command: "first-command",
            cwd: "/work",
            status: "inProgress",
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
            commandActions: [],
          },
        }),
      );
    }
    send(
      current,
      event("item/commandExecution/outputDelta", {
        threadId: THREAD_ID,
        turnId,
        itemId: "shared-command",
        delta: `${turnIndex === 0 ? "first" : turnIndex === 1 ? "second" : "recovery"} output\n`,
      }),
    );
    send(
      current,
      event("item/reasoning/summaryTextDelta", {
        threadId: THREAD_ID,
        turnId,
        itemId: "shared-reasoning",
        delta: `${turnIndex === 0 ? "first" : turnIndex === 1 ? "second" : "recovery"} reasoning`,
        summaryIndex: 0,
      }),
    );

    const text =
      turnIndex === 0
        ? "first stable answer"
        : turnIndex === 1
          ? "partial second output"
          : "recovered answer";
    send(
      current,
      event("item/completed", {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: "agentMessage",
          id: "shared-message",
          text,
          phase: turnIndex === 1 ? "commentary" : "final_answer",
        },
        completedAtMs: 1,
      }),
    );
    if (turnIndex === 1)
      send(
        current,
        event("error", {
          threadId: THREAD_ID,
          turnId,
          error: { message: "second-only provider failure" },
          willRetry: false,
        }),
      );
    send(
      current,
      event("turn/completed", {
        threadId: THREAD_ID,
        turn: {
          id: turnId,
          items: [],
          status: turnIndex === 1 ? "failed" : "completed",
          error: null,
        },
      }),
    );
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 1,
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const execute = async (prompt: string) => {
    const facts: Parameters<RunReporter["message"]>[0][] = [];
    const activity: Array<string | undefined> = [];
    const stderr: string[] = [];
    const ending = await session.runNextTurn({
      prompt,
      report: {
        message: (fact) => facts.push(fact),
        transcript: () => {},
        activity: (value) => activity.push(value),
        stderr: (value) => stderr.push(value),
      },
      missingAnswerMessage: "missing answer",
    });
    return { ending, facts, activity, stderr };
  };

  const first = await execute("first");
  const firstSnapshot = structuredClone(first);
  const failed = await execute("fail after partial output");
  const failedSnapshot = structuredClone(failed);
  const recovered = await execute("recover explicitly");

  assert.deepEqual(first, firstSnapshot);
  assert.deepEqual(failed, failedSnapshot);
  assert.deepEqual(first.ending, { ending: "answered" });
  assert.deepEqual(failed.ending, {
    ending: "failed",
    errorMessage: "second-only provider failure",
  });
  assert.deepEqual(recovered.ending, { ending: "answered" });
  assert.deepEqual(
    recovered.facts.filter((fact) => fact.role === "assistant"),
    [
      {
        role: "assistant",
        parts: [{ type: "text", text: "recovered answer" }],
        usage: { turns: 0 },
      },
    ],
  );
  assert.deepEqual(recovered.activity, [
    "fresh recovery",
    "recovery output",
    "recovery reasoning",
    undefined,
  ]);
  assert.deepEqual(recovered.stderr, []);
  assert.equal(
    JSON.stringify(recovered).includes("first-command") ||
      JSON.stringify(recovered).includes("stale") ||
      JSON.stringify(recovered).includes("second-only"),
    false,
  );
  assert.equal(
    failed.facts.some((fact) =>
      fact.parts.some(
        (part) => part.type === "text" && part.text === "partial second output",
      ),
    ),
    true,
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/start",
      "turn/start",
    ],
  );
  assert.equal(
    requests.some((request) => request.method === "thread/resume"),
    false,
  );

  await session.close();
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("retained steering is Turn-local FIFO and disposes prior correlations", async () => {
  const turnIds = ["turn-guided-first", "turn-guided-second"];
  const requests: Record<string, unknown>[] = [];
  const steerRequests: Array<{
    request: Record<string, unknown>;
    turnIndex: number;
  }> = [];
  const turnStarted: Array<Promise<void>> = [];
  const resolveTurnStarted: Array<() => void> = [];
  const steerStarted: Array<Promise<void>> = [];
  const resolveSteerStarted: Array<() => void> = [];
  for (let index = 0; index < 2; index++)
    turnStarted.push(
      new Promise<void>((resolve) => resolveTurnStarted.push(resolve)),
    );
  for (let index = 0; index < 3; index++)
    steerStarted.push(
      new Promise<void>((resolve) => resolveSteerStarted.push(resolve)),
    );
  let turnIndex = -1;
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize") {
      send(current, initializeResponse(request.id));
      return;
    }
    if (request.method === "thread/start") {
      send(current, {
        id: request.id,
        result: { thread: { id: THREAD_ID, turns: [] } },
      });
      return;
    }
    if (request.method === "turn/start") {
      turnIndex++;
      const turnId = turnIds[turnIndex] as string;
      send(current, {
        id: request.id,
        result: { turn: { id: turnId, status: "inProgress" } },
      });
      if (turnIndex === 1) {
        const priorSteering = steerRequests[0];
        assert.ok(priorSteering);
        const priorCorrelation = (
          priorSteering.request.params as Record<string, unknown>
        ).clientUserMessageId;
        for (const staleTurnId of [turnIds[0], turnId])
          send(
            current,
            event("item/completed", {
              threadId: THREAD_ID,
              turnId: staleTurnId,
              item: {
                type: "userMessage",
                id: "confirmed-guidance-reused",
                clientId: priorCorrelation,
                content: [
                  {
                    type: "text",
                    text: "stale confirmed first guidance",
                    text_elements: [],
                  },
                ],
              },
              completedAtMs: 1,
            }),
          );
      }
      resolveTurnStarted[turnIndex]?.();
      return;
    }
    if (request.method === "turn/steer") {
      steerRequests.push({ request, turnIndex });
      resolveSteerStarted[steerRequests.length - 1]?.();
    }
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 1,
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const startTurn = (prompt: string) => {
    const facts: Parameters<RunReporter["message"]>[0][] = [];
    const controls = createControlSource();
    const ending = session.runNextTurn({
      prompt,
      report: {
        message: (fact) => facts.push(fact),
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      controls: controls.controls,
      missingAnswerMessage: "missing answer",
    });
    return { ending, facts, controls };
  };
  const settleSteer = (
    steerIndex: number,
    confirmedText: string,
    itemId: string,
  ): void => {
    const steering = steerRequests[steerIndex];
    assert.ok(steering);
    const params = steering.request.params as Record<string, unknown>;
    send(child, { id: steering.request.id, result: {} });
    send(
      child,
      event("item/completed", {
        threadId: THREAD_ID,
        turnId: turnIds[steering.turnIndex],
        item: {
          type: "userMessage",
          id: itemId,
          clientId: params.clientUserMessageId,
          content: [{ type: "text", text: confirmedText, text_elements: [] }],
        },
        completedAtMs: 1,
      }),
    );
  };
  const completeTurn = (index: number): void => {
    const turnId = turnIds[index] as string;
    send(
      child,
      event("item/completed", {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: "agentMessage",
          id: `guided-answer-${index}`,
          text: index === 0 ? "first guided answer" : "second guided answer",
          phase: "final_answer",
        },
        completedAtMs: 1,
      }),
    );
    send(
      child,
      event("turn/completed", {
        threadId: THREAD_ID,
        turn: { id: turnId, items: [], status: "completed", error: null },
      }),
    );
  };

  const first = startTurn("first");
  await turnStarted[0];
  assert.equal(
    first.controls.offer({ type: "steer", text: "first guidance" }),
    "accepted",
  );
  await steerStarted[0];
  settleSteer(0, "confirmed first guidance", "confirmed-guidance-reused");
  completeTurn(0);
  assert.deepEqual(await first.ending, { ending: "answered" });
  assert.equal(
    first.controls.offer({ type: "steer", text: "too late for first" }),
    "closed",
  );
  const firstSnapshot = structuredClone(first.facts);

  const second = startTurn("second");
  await turnStarted[1];
  assert.equal(
    second.controls.offer({ type: "steer", text: "second guidance" }),
    "accepted",
  );
  assert.equal(
    second.controls.offer({ type: "steer", text: "third guidance" }),
    "accepted",
  );
  await steerStarted[1];
  assert.equal(steerRequests.length, 2);
  settleSteer(1, "confirmed second guidance", "confirmed-guidance-reused");
  await steerStarted[2];
  assert.equal(steerRequests.length, 3);
  settleSteer(2, "confirmed third guidance", "confirmed-third-guidance");
  completeTurn(1);

  assert.deepEqual(await second.ending, { ending: "answered" });
  assert.deepEqual(first.facts, firstSnapshot);
  assert.equal(
    second.controls.offer({ type: "steer", text: "too late for second" }),
    "closed",
  );
  assert.deepEqual(
    second.facts
      .filter((fact) => fact.role === "user")
      .flatMap((fact) => fact.parts)
      .map((part) => (part.type === "text" ? part.text : "")),
    ["confirmed second guidance", "confirmed third guidance"],
  );
  assert.equal(JSON.stringify(second.facts).includes("first guidance"), false);
  assert.deepEqual(
    steerRequests.map(({ request, turnIndex: index }) => {
      const params = request.params as Record<string, unknown>;
      return {
        threadId: params.threadId,
        expectedTurnId: params.expectedTurnId,
        text: (params.input as Array<Record<string, unknown>>)[0]?.text,
        turnIndex: index,
      };
    }),
    [
      {
        threadId: THREAD_ID,
        expectedTurnId: turnIds[0],
        text: "first guidance",
        turnIndex: 0,
      },
      {
        threadId: THREAD_ID,
        expectedTurnId: turnIds[1],
        text: "second guidance",
        turnIndex: 1,
      },
      {
        threadId: THREAD_ID,
        expectedTurnId: turnIds[1],
        text: "third guidance",
        turnIndex: 1,
      },
    ],
  );
  const correlations = steerRequests.map(
    ({ request }) =>
      (request.params as Record<string, unknown>).clientUserMessageId,
  );
  assert.equal(new Set(correlations).size, 3);
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/steer",
      "turn/start",
      "turn/steer",
      "turn/steer",
    ],
  );
  assert.equal(
    requests.some((request) => request.method === "thread/resume"),
    false,
  );

  await session.close();
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("cancelling an active Turn interrupts only that Turn and preserves partial output", async () => {
  const controller = new AbortController();
  const facts: Parameters<RunReporter["message"]>[0][] = [];
  const stderr: string[] = [];
  let controlReturns = 0;
  let steerRequest: Record<string, unknown> | undefined;
  let steerReady!: () => void;
  const steered = new Promise<void>((resolve) => {
    steerReady = resolve;
  });
  const child = fakeChild((request, current) => {
    if (request.method === "initialize") {
      send(current, initializeResponse(request.id));
    } else if (request.method === "thread/start") {
      send(current, {
        id: request.id,
        result: { thread: { id: THREAD_ID } },
      });
    } else if (request.method === "turn/start") {
      send(current, {
        id: request.id,
        result: { turn: { id: "turn-resumed-cancel", status: "inProgress" } },
      });
      send(
        current,
        event("item/completed", {
          threadId: THREAD_ID,
          turnId: "turn-resumed-cancel",
          item: {
            type: "agentMessage",
            id: "partial-resumed-answer",
            text: "partial resumed output",
            phase: "commentary",
          },
          completedAtMs: 1,
        }),
      );
    } else if (request.method === "turn/steer") {
      steerRequest = request;
      steerReady();
    } else if (request.method === "turn/interrupt") {
      assert.deepEqual(request.params, {
        threadId: THREAD_ID,
        turnId: "turn-resumed-cancel",
      });
      assert.ok(steerRequest);
      send(current, {
        id: steerRequest.id,
        error: { code: -32001, message: "resumed steering refused" },
      });
      send(current, { id: request.id, result: {} });
      send(
        current,
        event("turn/completed", {
          threadId: THREAD_ID,
          turn: {
            id: "turn-resumed-cancel",
            items: [],
            status: "interrupted",
            error: null,
          },
        }),
      );
    }
  });
  const controlOwner = createControlSource();
  assert.equal(
    controlOwner.offer({ type: "steer", text: "racing guidance" }),
    "accepted",
  );
  const controls: ControlSource = {
    subscribe(onAdmission, onClose) {
      return controlOwner.controls.subscribe(onAdmission, () => {
        controlReturns++;
        onClose?.();
      });
    },
  };
  const endingPromise = runCodexAppServer({
    cwd: "/work",
    childDepth: 1,
    prompt: "resumed prompt",
    spawn: (() => child) as unknown as ChildProcessSpawn,
    killEscalationMs: 1,
    report: {
      message: (fact) => facts.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: (chunk) => stderr.push(chunk),
    },
    signal: controller.signal,
    controls,
    missingAnswerMessage: "missing answer",
  });
  await steered;
  controller.abort();

  assert.deepEqual(await endingPromise, { ending: "cancelled" });
  assert.deepEqual(facts, [
    {
      role: "assistant",
      parts: [{ type: "text", text: "partial resumed output" }],
      usage: { turns: 0 },
    },
  ]);
  assert.deepEqual(stderr, ["Steering rejected: resumed steering refused\n"]);
  assert.equal(controlReturns, 1);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("a completed Codex answer admitted before cancellation remains authoritative", async () => {
  const controller = new AbortController();
  const facts: Parameters<RunReporter["message"]>[0][] = [];
  const child = fakeChild((request, current) => {
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start") {
      // The complete notification has entered stdout first, but the response
      // that establishes Turn identity has not. Cancellation must not overtake
      // that retained ingress when identity arrives afterward.
      send(current, agent("answer before cancellation"));
      controller.abort();
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
    }
  });
  const harness = createCodexHarness({
    spawn: (() => child) as unknown as ChildProcessSpawn,
    killEscalationMs: 1,
  });
  const execution = prepareCodexRun(harness, {
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "",
    },
    description: "codex",
    prompt: "prompt",
    cwd: process.cwd(),
    childDepth: 1,
    projectTrusted: false,
  });

  const ending = await execution.execute({
    report: {
      message: (fact) => facts.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    signal: controller.signal,
    controls: controlsFrom(),
  });

  assert.deepEqual(ending, { ending: "answered" });
  assert.deepEqual(facts, [
    {
      role: "assistant",
      parts: [{ type: "text", text: "answer before cancellation" }],
      usage: { turns: 0 },
    },
  ]);
});

test("a completed Codex answer first admitted after cancellation is not authoritative", async () => {
  const controller = new AbortController();
  const facts: Parameters<RunReporter["message"]>[0][] = [];
  const child = fakeChild((request, current) => {
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start") {
      controller.abort();
      send(current, agent("answer after cancellation"));
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
    }
  });
  const task = {
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "",
    },
    description: "codex",
    prompt: "prompt",
    cwd: process.cwd(),
    childDepth: 1,
    projectTrusted: false,
  } as const;
  const execution = prepareCodexRun(
    createCodexHarness({
      spawn: (() => child) as unknown as ChildProcessSpawn,
      killEscalationMs: 1,
    }),
    task,
  );

  const ending = await execution.execute({
    report: {
      message: (fact) => facts.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    signal: controller.signal,
    controls: controlsFrom(),
  });

  assert.deepEqual(ending, { ending: "cancelled" });
  assert.deepEqual(facts, [
    {
      role: "assistant",
      parts: [{ type: "text", text: "answer after cancellation" }],
      usage: { turns: 0 },
    },
  ]);
});

test("complete messages in one stdout ingress precede cancellation from reporting", async () => {
  const controller = new AbortController();
  const facts: Parameters<RunReporter["message"]>[0][] = [];
  const usage = event("thread/tokenUsage/updated", {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    tokenUsage: {
      total: {
        totalTokens: 1,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 1,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 100,
    },
  });
  const child = fakeChild((request, current) => {
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start") {
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
      current.stdout.write(
        `${[usage, agent("answer already in ingress"), completedTurn()]
          .map((message) => JSON.stringify(message))
          .join("\n")}\n`,
      );
    }
  });
  const task = {
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "",
    },
    description: "codex",
    prompt: "prompt",
    cwd: process.cwd(),
    childDepth: 1,
    projectTrusted: false,
  } as const;
  const execution = prepareCodexRun(
    createCodexHarness({
      spawn: (() => child) as unknown as ChildProcessSpawn,
      killEscalationMs: 1,
    }),
    task,
  );

  const ending = await execution.execute({
    report: {
      message: (fact) => {
        facts.push(fact);
        if (fact.role === "metadata") controller.abort();
      },
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    signal: controller.signal,
    controls: controlsFrom(),
  });

  assert.deepEqual(ending, { ending: "answered" });
  assert.equal(facts.at(-1)?.role, "assistant");
});

test("only correlated provider consumption creates one neutral steering Fact", async (t) => {
  const controller = new AbortController();
  const facts: Parameters<RunReporter["message"]>[0][] = [];
  let steerRequest: Record<string, unknown> | undefined;
  let steerSent!: () => void;
  const steered = new Promise<void>((resolve) => {
    steerSent = resolve;
  });
  const child = fakeChild((request, current) => {
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start")
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
    else if (request.method === "turn/steer") {
      steerRequest = request;
      send(current, { id: request.id, result: {} });
      steerSent();
    }
  });
  const task = {
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "",
    },
    description: "codex",
    prompt: "prompt",
    cwd: process.cwd(),
    childDepth: 1,
    projectTrusted: false,
  } as const;
  const execution = prepareCodexRun(
    createCodexHarness({
      spawn: (() => child) as unknown as ChildProcessSpawn,
      killEscalationMs: 1,
    }),
    task,
  );
  const controls = controlsFrom({
    type: "steer",
    text: "locally accepted guidance",
  });

  const pending = execution.execute({
    report: {
      message: (fact) => facts.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    signal: controller.signal,
    controls,
  });
  t.after(async () => {
    controller.abort();
    child.finish(0);
    await pending;
  });
  assert.equal(
    await Promise.race([
      steered.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]),
    true,
  );
  assert.deepEqual(facts, []);
  const correlation = (
    steerRequest?.params as Record<string, unknown> | undefined
  )?.clientUserMessageId;
  assert.equal(typeof correlation, "string");
  const userItem = {
    type: "userMessage",
    id: "provider-user-item",
    clientId: correlation,
    content: [
      { type: "text", text: "provider-confirmed guidance", text_elements: [] },
    ],
  };
  send(
    child,
    event("item/started", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: userItem,
      startedAtMs: 1,
    }),
  );
  send(child, itemCompleted(userItem));
  send(
    child,
    itemCompleted({
      ...userItem,
      id: "repeated-correlation-item",
    }),
  );
  send(
    child,
    itemCompleted({
      ...userItem,
      id: "unknown-correlation-item",
      clientId: "unknown-correlation",
    }),
  );
  send(
    child,
    itemCompleted({
      type: "userMessage",
      id: "absent-correlation-item",
      content: userItem.content,
    }),
  );
  send(
    child,
    itemCompleted({
      type: "userMessage",
      id: "null-correlation-item",
      clientId: null,
      content: userItem.content,
    }),
  );
  send(child, agent("answer"));
  send(child, completedTurn());

  assert.deepEqual(await pending, { ending: "answered" });
  assert.deepEqual(facts, [
    {
      role: "user",
      parts: [{ type: "text", text: "provider-confirmed guidance" }],
    },
    {
      role: "assistant",
      parts: [{ type: "text", text: "answer" }],
      usage: { turns: 0 },
    },
  ]);
});

test("a steering server rejection racing semantic completion preserves the answer", async () => {
  const facts: Parameters<RunReporter["message"]>[0][] = [];
  const stderr: string[] = [];
  const child = fakeChild((request, current) => {
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start")
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
    else if (request.method === "turn/steer") {
      current.stdout.write(
        `${[
          {
            id: request.id,
            error: {
              code: 7,
              message: "active turn refused steering",
              data: {
                codexErrorInfo: {
                  activeTurnNotSteerable: { turnKind: "compact" },
                },
              },
            },
          },
          agent("semantic answer"),
          completedTurn(),
        ]
          .map((message) => JSON.stringify(message))
          .join("\n")}\n`,
      );
    }
  });
  const task = {
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "",
    },
    description: "codex",
    prompt: "prompt",
    cwd: process.cwd(),
    childDepth: 1,
    projectTrusted: false,
  } as const;
  const execution = prepareCodexRun(
    createCodexHarness({
      spawn: (() => child) as unknown as ChildProcessSpawn,
      killEscalationMs: 1,
    }),
    task,
  );

  const ending = await execution.execute({
    report: {
      message: (fact) => facts.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: (chunk) => stderr.push(chunk),
    },
    controls: controlsFrom({ type: "steer", text: "racing guidance" }),
  });

  assert.deepEqual(ending, { ending: "answered" });
  assert.deepEqual(facts, [
    {
      role: "assistant",
      parts: [{ type: "text", text: "semantic answer" }],
      usage: { turns: 0 },
    },
  ]);
  assert.deepEqual(stderr, [
    "Steering rejected: active turn refused steering\n",
  ]);
});

test("one retained App Server owns cumulative usage while fresh Turn translators report local deltas", async () => {
  const totals = [
    [
      {
        totalTokens: 10,
        inputTokens: 6,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 1,
        reasoningOutputTokens: 1,
        contextTokens: 8,
      },
      {
        totalTokens: 16,
        inputTokens: 10,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        contextTokens: 12,
      },
    ],
    [
      {
        totalTokens: 22,
        inputTokens: 14,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        contextTokens: 9,
      },
    ],
    [
      {
        totalTokens: 5,
        inputTokens: 3,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        contextTokens: 5,
      },
    ],
    [
      {
        totalTokens: 9,
        inputTokens: 5,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 0,
        contextTokens: 6,
      },
    ],
  ] as const;
  const requests: Record<string, unknown>[] = [];
  let turnNumber = 0;
  const child = fakeChild((request, current) => {
    requests.push(request);
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    if (request.method === "thread/start")
      send(current, {
        id: request.id,
        result: { thread: { id: THREAD_ID, turns: [] } },
      });
    if (request.method !== "turn/start") return;

    turnNumber++;
    const turnId = `retained-turn-${turnNumber}`;
    if (turnNumber > 1) {
      send(
        current,
        event("thread/tokenUsage/updated", {
          threadId: THREAD_ID,
          turnId: `retained-turn-${turnNumber - 1}`,
          tokenUsage: {
            total: {
              totalTokens: 999,
              inputTokens: 999,
              cachedInputTokens: 999,
              cacheWriteInputTokens: 999,
              outputTokens: 999,
              reasoningOutputTokens: 999,
            },
            last: {
              totalTokens: 999,
              inputTokens: 999,
              cachedInputTokens: 999,
              cacheWriteInputTokens: 999,
              outputTokens: 999,
              reasoningOutputTokens: 999,
            },
          },
        }),
      );
    }
    send(current, {
      id: request.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    send(
      current,
      event("thread/tokenUsage/updated", {
        threadId: "foreign-thread",
        turnId,
        tokenUsage: {
          total: {
            totalTokens: 777,
            inputTokens: 777,
            cachedInputTokens: 777,
            cacheWriteInputTokens: 777,
            outputTokens: 777,
            reasoningOutputTokens: 777,
          },
          last: {
            totalTokens: 777,
            inputTokens: 777,
            cachedInputTokens: 777,
            cacheWriteInputTokens: 777,
            outputTokens: 777,
            reasoningOutputTokens: 777,
          },
        },
      }),
    );
    for (const update of totals[turnNumber - 1] ?? []) {
      const { contextTokens, ...total } = update;
      send(
        current,
        event("thread/tokenUsage/updated", {
          threadId: THREAD_ID,
          turnId,
          tokenUsage: {
            total,
            last: { ...total, totalTokens: contextTokens },
          },
        }),
      );
    }
    send(
      current,
      event("item/completed", {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: "agentMessage",
          id: `answer-${turnNumber}`,
          text: `answer ${turnNumber}`,
          phase: "final_answer",
        },
        completedAtMs: turnNumber,
      }),
    );
    send(
      current,
      event("turn/completed", {
        threadId: THREAD_ID,
        turn: {
          id: turnId,
          items: [],
          status: "completed",
          error: null,
        },
      }),
    );
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 1,
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const observedUsage: Array<
    Array<NonNullable<Parameters<RunReporter["message"]>[0]["usage"]>>
  > = [];

  for (let index = 0; index < totals.length; index++) {
    const usage: Array<
      NonNullable<Parameters<RunReporter["message"]>[0]["usage"]>
    > = [];
    assert.deepEqual(
      await session.runNextTurn({
        prompt: `prompt ${index + 1}`,
        report: {
          message: (fact) => {
            if (fact.usage?.turns === 1) usage.push(fact.usage);
          },
          transcript: () => {},
          activity: () => {},
          stderr: () => {},
        },
        missingAnswerMessage: "missing answer",
      }),
      { ending: "answered" },
    );
    observedUsage.push(usage);
  }

  assert.deepEqual(observedUsage, [
    [
      {
        input: 6,
        cacheRead: 2,
        cacheWrite: 1,
        output: 2,
        contextTokens: 8,
        turns: 1,
      },
      {
        input: 4,
        cacheRead: 1,
        cacheWrite: 0,
        output: 1,
        contextTokens: 12,
        turns: 1,
      },
    ],
    [
      {
        input: 4,
        cacheRead: 1,
        cacheWrite: 1,
        output: 1,
        contextTokens: 9,
        turns: 1,
      },
    ],
    [
      {
        input: 3,
        cacheRead: 1,
        cacheWrite: 0,
        output: 1,
        contextTokens: 5,
        turns: 1,
      },
    ],
    [
      {
        input: 2,
        cacheRead: 0,
        cacheWrite: 0,
        output: 2,
        contextTokens: 6,
        turns: 1,
      },
    ],
  ]);
  assert.equal(
    requests.filter((request) => request.method === "initialize").length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "thread/start").length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    4,
  );
  assert.equal(
    requests.some((request) => request.method === "thread/resume"),
    false,
  );

  await session.close();
});

test("Codex preserves profile validation, effort mapping, and prompt composition", () => {
  const harness = createCodexHarness();
  const profile: AgentConfig = {
    name: "codex",
    description: "codex",
    harness: "codex",
    fields: { model: "gpt", effort: "high" },
    systemPrompt: "system",
  };
  assert.deepEqual(harness.validate(profile, "/agents/codex.md"), []);
  assert.deepEqual(
    harness.validate(
      { ...profile, fields: { tools: "Bash" } },
      "/agents/codex.md",
    ),
    [{ reason: "Codex harness does not recognize field 'tools'" }],
  );
  assert.deepEqual(
    EFFORTS.map((effort) => [effort, codexEffort(effort)]),
    [
      ["off", "none"],
      ["minimal", "minimal"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ],
  );
});

test("prepared Codex Runs advertise steering", () => {
  const harness = createCodexHarness();
  const config: AgentConfig = {
    name: "codex",
    description: "codex",
    harness: "codex",
    fields: {},
    systemPrompt: "",
  };

  const prepared = prepareCodexRun(harness, {
    config,
    description: "codex",
    prompt: "prompt",
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });

  assert.deepEqual(prepared.supportedControls, ["steer"]);
});

// Keep the required reporter shape visible in this adapter's test helpers.
const reporterShapeCheck: RunReporter["activity"] = () => {};
void reporterShapeCheck;

test("App Server filters foreign/unknown notifications and answers server requests", async () => {
  const writes: Record<string, unknown>[] = [];
  const forwarded: string[] = [];
  const child = fakeChild((request, current) => {
    writes.push(request);
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start") {
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
      send(current, {
        method: "unknown/noise",
        params: { threadId: THREAD_ID },
      });
      send(current, {
        method: "item/completed",
        params: {
          threadId: "other-thread",
          turnId: TURN_ID,
          item: {
            type: "agentMessage",
            text: "foreign",
            phase: "final_answer",
          },
        },
      });
      send(current, {
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: {},
      });
      send(current, agent("answer"));
      send(current, completedTurn());
    }
  });
  const source = createTestAppServerRun({
    cwd: "/work",
    childDepth: 1,
    prompt: "prompt",
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const stderr: string[] = [];
  const conclusion = await source(
    {
      message: (fact) =>
        forwarded.push(
          ...fact.parts.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          ),
        ),
      stderr: (value) => stderr.push(value),
    },
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, { ending: "answered" });
  assert.deepEqual(forwarded, ["answer"]);
  assert.deepEqual(writes.at(-1), {
    jsonrpc: "2.0",
    id: 99,
    error: { code: -32601, message: "Method not supported by pi-subagent" },
  });
  assert.match(stderr.join(""), /requested unsupported method/);
});

test("App Server cancellation interrupts the known turn before escalating", async () => {
  const controller = new AbortController();
  let interrupt: Record<string, unknown> | undefined;
  const child = fakeChild((request, current) => {
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start") {
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
      setTimeout(() => controller.abort(), 100);
    } else if (request.method === "turn/interrupt") {
      interrupt = request;
      send(current, { id: request.id, result: {} });
      send(current, completedTurn("interrupted"));
    }
  });
  const source = createTestAppServerRun({
    cwd: "/work",
    childDepth: 1,
    prompt: "prompt",
    killEscalationMs: 500,
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const pending = source({ stderr: () => {} }, controller.signal);
  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.deepEqual(interrupt?.params, { threadId: THREAD_ID, turnId: TURN_ID });
  assert.deepEqual(child.signals, []);
});

test("App Server escalates an ignored interrupt from SIGTERM to SIGKILL", async () => {
  const controller = new AbortController();
  let child!: FakeChild;
  child = fakeChild((request, current) => {
    if (request.method === "initialize")
      send(current, initializeResponse(request.id));
    else if (request.method === "thread/start")
      send(current, { id: request.id, result: { thread: { id: THREAD_ID } } });
    else if (request.method === "turn/start") {
      send(current, { id: request.id, result: { turn: { id: TURN_ID } } });
      setTimeout(() => controller.abort(), 0);
    }
  });
  const originalKill = child.kill;
  child.kill = (signal) => {
    const result = originalKill(signal);
    if (signal === "SIGKILL") child.finish(137);
    return result;
  };
  const source = createTestAppServerRun({
    cwd: "/work",
    childDepth: 1,
    prompt: "prompt",
    killEscalationMs: 5,
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  assert.deepEqual(await source({ stderr: () => {} }, controller.signal), {
    ending: "cancelled",
  });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
