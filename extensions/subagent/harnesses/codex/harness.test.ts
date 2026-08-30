import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessSpawn } from "../../child-process.ts";
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
  type CodexAppServerEvent,
  type CodexAppServerOptions,
  runCodexAppServer,
} from "./app-server.ts";
import {
  codexEffort,
  createCodexHarness,
  createCodexTranslator,
} from "./harness.ts";

function prepareCodexRun(
  harness: Harness,
  input: SubagentContext & SubagentTask,
): HarnessRun {
  const { description, prompt, ...context } = input;
  return harness.prepare(context).prepareRun({ description, prompt });
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

function createTestAppServerRun(options: CodexAppServerOptions) {
  return (
    sink: {
      event(event: CodexAppServerEvent): boolean | undefined;
      stderr(chunk: string): void;
    },
    signal: AbortSignal,
  ) =>
    runCodexAppServer({
      ...options,
      translate: (value) => ({
        terminal:
          sink.event(value) === true || value.method === "turn/completed",
      }),
      report: {
        message: () => {},
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

function agentMessageDelta(
  translate: ReturnType<typeof createCodexTranslator>,
  itemId: string,
  delta: string,
) {
  return translate(
    event("item/agentMessage/delta", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId,
      delta,
    }),
  );
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
        const expectedControls =
          scenario === "steering-single-consumed" ? 1 : 2;
        const acknowledge = (): void => {
          send(current, { id, result: {} });
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
        case "steering-fifo-consumed": {
          const offeredTexts =
            scenario === "steering-single-consumed"
              ? ["first guidance"]
              : ["first guidance", "second guidance"];
          const fixture = base({
            phase: "completed",
            finalOutput: "controlled answer",
            userFactTexts: offeredTexts.map((text) => `confirmed: ${text}`),
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
            },
          };
        }
      }
    },
  };
}

runHarnessConformance(conformanceRig());

test("Codex App Server sends the disposable handshake and one prompt", async () => {
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
  const sink = { event: () => undefined, stderr: () => {} };
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
    ephemeral: false,
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

test("a prepared Codex adapter resumes one Conversation through cleaned disposable Attempts", async () => {
  const order: string[] = [];
  const children: FakeChild[] = [];
  const writes: Record<string, unknown>[][] = [[], [], []];
  const turnIds = ["turn-first", "turn-second", "turn-third"];
  const spawn: ChildProcessSpawn = (_command, args, options) => {
    const attempt = children.length;
    assert.ok(attempt < 3, "each Run starts exactly one App Server child");
    assert.deepEqual(args, ["app-server"]);
    assert.equal(options.cwd, "/fixed/work");
    assert.equal(options.env?.[DEPTH_ENV_KEY], "1");
    assert.equal(options.env?.PATH, process.env.PATH);
    order.push(`spawn-${attempt + 1}`);
    const turnId = turnIds[attempt] as string;
    const child = fakeChild((request, current) => {
      writes[attempt]?.push(request);
      const method = request.method;
      order.push(`${attempt + 1}:${String(method)}`);
      if (method === "initialize") {
        send(current, initializeResponse(request.id));
      } else if (method === "thread/start") {
        send(current, {
          id: request.id,
          result: { thread: { id: THREAD_ID, turns: [] } },
        });
      } else if (method === "thread/resume") {
        // Resumed turns are attachment data. Even a terminal answer in this
        // response must not become a Fact in the new Run.
        send(current, {
          id: request.id,
          result: {
            thread: {
              id: THREAD_ID,
              turns: [
                {
                  id: turnIds[0],
                  items: [
                    {
                      type: "agentMessage",
                      id: "attached-old-answer",
                      text: "first answer from attachment",
                      phase: "final_answer",
                    },
                  ],
                  status: "completed",
                },
              ],
            },
          },
        });
      } else if (method === "turn/start") {
        if (attempt === 1) {
          send(
            current,
            event("item/completed", {
              threadId: THREAD_ID,
              turnId: turnIds[0],
              item: {
                type: "agentMessage",
                id: "late-old-answer",
                text: "late first answer",
                phase: "final_answer",
              },
              completedAtMs: 1,
            }),
          );
          send(
            current,
            event("item/completed", {
              threadId: "foreign-thread",
              turnId,
              item: {
                type: "agentMessage",
                id: "foreign-answer",
                text: "foreign answer",
                phase: "final_answer",
              },
              completedAtMs: 1,
            }),
          );
        }
        send(current, {
          id: request.id,
          result: { turn: { id: turnId, status: "inProgress" } },
        });
        const totals = [
          { total: 10, input: 7, cacheRead: 2, output: 1 },
          { total: 16, input: 11, cacheRead: 3, output: 2 },
          // Some resumed App Server versions expose counters scoped to the
          // current attachment instead of the retained Conversation.
          { total: 6, input: 4, cacheRead: 1, output: 1 },
        ] as const;
        const currentUsage = totals[attempt];
        assert.ok(currentUsage);
        send(
          current,
          event("thread/tokenUsage/updated", {
            threadId: THREAD_ID,
            turnId,
            tokenUsage: {
              total: {
                totalTokens: currentUsage.total,
                inputTokens: currentUsage.input,
                cachedInputTokens: currentUsage.cacheRead,
                cacheWriteInputTokens: 0,
                outputTokens: currentUsage.output,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: attempt === 0 ? 10 : 6,
                inputTokens: attempt === 0 ? 7 : 4,
                cachedInputTokens: attempt === 0 ? 2 : 1,
                cacheWriteInputTokens: 0,
                outputTokens: 1,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 100,
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
              id: `answer-${attempt + 1}`,
              text:
                attempt === 0
                  ? "first answer"
                  : attempt === 1
                    ? "second answer in context"
                    : "third answer after reset counters",
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
              id: turnId,
              items: [],
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          }),
        );
      }
    });
    const originalKill = child.kill;
    child.kill = (signal) => {
      const killed = originalKill(signal);
      if (signal === "SIGTERM") {
        order.push(`dispose-${attempt + 1}`);
        queueMicrotask(() => child.finish(0));
      }
      return killed;
    };
    children.push(child);
    return child as unknown as ChildProcess;
  };

  const adapter = createCodexHarness({
    spawn,
    killEscalationMs: 20,
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
  assert.equal(adapter.capabilities.resume, true);

  const execute = async (prompt: string) => {
    const facts: Parameters<RunReporter["message"]>[0][] = [];
    const stderr: string[] = [];
    let controlReturns = 0;
    let finishNext: ((value: IteratorResult<RunControl>) => void) | undefined;
    const controls: AsyncIterable<RunControl> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<RunControl>>((resolve) => {
              finishNext = resolve;
            }),
          return: async () => {
            controlReturns++;
            finishNext?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        };
      },
    };
    const prepared = adapter.prepareRun({ description: prompt, prompt });
    const ending = await prepared.execute({
      report: {
        message: (fact) => facts.push(fact),
        transcript: () => {},
        activity: () => {},
        stderr: (chunk) => stderr.push(chunk),
      },
      controls,
    });
    return { ending, facts, stderr, controlReturns };
  };

  const first = await execute("first prompt");
  assert.deepEqual(first.ending, { ending: "answered" });
  assert.equal(first.controlReturns, 1);
  assert.equal(children[0]?.listenerCount("close"), 0);
  assert.equal(children[0]?.stdout.listenerCount("data"), 0);
  assert.equal(children[0]?.stderr.listenerCount("data"), 0);
  assert.equal(children[0]?.stdin.listenerCount("error"), 0);

  const second = await execute("second prompt only");
  assert.deepEqual(second.ending, { ending: "answered" });
  assert.equal(second.controlReturns, 1);
  assert.equal(children[1]?.listenerCount("close"), 0);
  assert.equal(children[1]?.stdout.listenerCount("data"), 0);
  assert.equal(children[1]?.stderr.listenerCount("data"), 0);
  assert.equal(children[1]?.stdin.listenerCount("error"), 0);

  const third = await execute("third prompt only");
  assert.deepEqual(third.ending, { ending: "answered" });
  assert.equal(third.controlReturns, 1);
  assert.equal(children[2]?.listenerCount("close"), 0);
  assert.equal(children[2]?.stdout.listenerCount("data"), 0);
  assert.equal(children[2]?.stderr.listenerCount("data"), 0);
  assert.equal(children[2]?.stdin.listenerCount("error"), 0);

  assert.deepEqual(
    writes.map((attempt) => attempt.map((request) => request.method)),
    [
      ["initialize", "initialized", "thread/start", "turn/start"],
      ["initialize", "initialized", "thread/resume", "turn/start"],
      ["initialize", "initialized", "thread/resume", "turn/start"],
    ],
  );
  assert.deepEqual(writes[0]?.[2]?.params, {
    cwd: "/fixed/work",
    ephemeral: false,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model: "gpt-fixed",
    config: { model_reasoning_effort: "high" },
  });
  assert.deepEqual(writes[0]?.[3]?.params, {
    threadId: THREAD_ID,
    input: [
      {
        type: "text",
        text: "fixed profile role\n\nfirst prompt",
        text_elements: [],
      },
    ],
  });
  assert.deepEqual(writes[1]?.[2]?.params, {
    threadId: THREAD_ID,
    cwd: "/fixed/work",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model: "gpt-fixed",
    config: { model_reasoning_effort: "high" },
  });
  assert.deepEqual(writes[1]?.[3]?.params, {
    threadId: THREAD_ID,
    input: [
      {
        type: "text",
        text: "second prompt only",
        text_elements: [],
      },
    ],
  });
  assert.deepEqual(
    first.facts.filter((fact) => fact.role === "assistant"),
    [
      {
        role: "assistant",
        parts: [{ type: "text", text: "first answer" }],
        usage: { turns: 0 },
      },
    ],
  );
  assert.deepEqual(
    second.facts.filter((fact) => fact.role === "assistant"),
    [
      {
        role: "assistant",
        parts: [{ type: "text", text: "second answer in context" }],
        usage: { turns: 0 },
      },
    ],
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
  assert.deepEqual(
    third.facts.find((fact) => fact.role === "metadata")?.usage,
    {
      input: 4,
      cacheRead: 1,
      cacheWrite: 0,
      output: 1,
      contextTokens: 6,
      turns: 1,
    },
  );
  assert.deepEqual(first.stderr, []);
  assert.deepEqual(second.stderr, []);
  assert.deepEqual(order, [
    "spawn-1",
    "1:initialize",
    "1:initialized",
    "1:thread/start",
    "1:turn/start",
    "dispose-1",
    "spawn-2",
    "2:initialize",
    "2:initialized",
    "2:thread/resume",
    "2:turn/start",
    "dispose-2",
    "spawn-3",
    "3:initialize",
    "3:initialized",
    "3:thread/resume",
    "3:turn/start",
    "dispose-3",
  ]);
});

test("closing a Codex adapter while attaching cancels and fully cleans its Attempt", async () => {
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
    controls: (async function* () {})(),
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

test("repeated Session-owned close versus resumed settlement has one winner", async () => {
  for (let iteration = 0; iteration < 32; iteration++) {
    for (const completionFirst of [true, false]) {
      const children: FakeChild[] = [];
      let resumedChild: FakeChild | undefined;
      let resumedTurnReady!: () => void;
      const resumedReady = new Promise<void>((resolve) => {
        resumedTurnReady = resolve;
      });
      const spawn: ChildProcessSpawn = () => {
        const attempt = children.length;
        const turnId = attempt === 0 ? "turn-seed" : "turn-resumed-race";
        const child = fakeChild((request, current) => {
          if (request.method === "initialize") {
            send(current, initializeResponse(request.id));
          } else if (request.method === "thread/start") {
            send(current, {
              id: request.id,
              result: { thread: { id: THREAD_ID } },
            });
          } else if (request.method === "thread/resume") {
            send(current, {
              id: request.id,
              result: { thread: { id: THREAD_ID } },
            });
          } else if (request.method === "turn/start") {
            send(current, {
              id: request.id,
              result: { turn: { id: turnId, status: "inProgress" } },
            });
            if (attempt === 0) {
              send(
                current,
                event("item/completed", {
                  threadId: THREAD_ID,
                  turnId,
                  item: {
                    type: "agentMessage",
                    id: "seed-answer",
                    text: "seed",
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
                    id: turnId,
                    items: [],
                    status: "completed",
                    error: null,
                  },
                }),
              );
            } else {
              resumedChild = current;
              resumedTurnReady();
            }
          } else if (request.method === "turn/interrupt") {
            send(current, { id: request.id, result: {} });
          }
        });
        children.push(child);
        return child as unknown as ChildProcess;
      };
      const adapter = createCodexHarness({
        spawn,
        killEscalationMs: 1,
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
      const execute = (prompt: string) =>
        adapter.prepareRun({ description: prompt, prompt }).execute({
          report: {
            message: () => {},
            transcript: () => {},
            activity: () => {},
            stderr: () => {},
          },
          controls: (async function* () {})(),
        });
      assert.deepEqual(await execute("seed"), { ending: "answered" });
      const pending = execute("resumed race");
      await resumedReady;
      assert.ok(resumedChild);
      const sendSettlement = (): void => {
        send(
          resumedChild as FakeChild,
          event("item/completed", {
            threadId: THREAD_ID,
            turnId: "turn-resumed-race",
            item: {
              type: "agentMessage",
              id: "resumed-race-answer",
              text: "resumed race answer",
              phase: "final_answer",
            },
            completedAtMs: 1,
          }),
        );
        send(
          resumedChild as FakeChild,
          event("turn/completed", {
            threadId: THREAD_ID,
            turn: {
              id: "turn-resumed-race",
              items: [],
              status: "completed",
              error: null,
            },
          }),
        );
      };

      let closing: Promise<void>;
      if (completionFirst) {
        sendSettlement();
        closing = adapter.close();
      } else {
        closing = adapter.close();
        sendSettlement();
      }

      assert.deepEqual(await pending, {
        ending: completionFirst ? "answered" : "cancelled",
      });
      await closing;
      await adapter.close();
      assert.equal(children[1]?.listenerCount("close"), 0);
      assert.equal(children[1]?.stdout.listenerCount("data"), 0);
      assert.equal(children[1]?.stderr.listenerCount("data"), 0);
      assert.equal(children[1]?.stdin.listenerCount("error"), 0);
    }
  }
});

test("Codex creates after a pre-Conversation failure but never falls back after continuation exists", async () => {
  const attempts: Record<string, unknown>[][] = [[], [], []];
  const children: FakeChild[] = [];
  const spawn: ChildProcessSpawn = () => {
    const attempt = children.length;
    const child = fakeChild((request, current) => {
      attempts[attempt]?.push(request);
      if (request.method === "initialize") {
        if (attempt === 0) {
          send(current, {
            id: request.id,
            error: { code: -32000, message: "initialization unavailable" },
          });
        } else send(current, initializeResponse(request.id));
      } else if (request.method === "thread/start") {
        send(current, {
          id: request.id,
          result: { thread: { id: THREAD_ID, turns: [] } },
        });
      } else if (request.method === "thread/resume") {
        send(current, {
          id: request.id,
          error: {
            code: -32001,
            message: `continuation ${THREAD_ID} unavailable`,
          },
        });
      } else if (request.method === "turn/start") {
        send(current, {
          id: request.id,
          result: { turn: { id: TURN_ID, status: "inProgress" } },
        });
        send(current, agent("created on retry"));
        send(current, completedTurn());
      }
    });
    const originalKill = child.kill;
    child.kill = (signal) => {
      const killed = originalKill(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.finish(0));
      return killed;
    };
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const adapter = createCodexHarness({
    spawn,
    killEscalationMs: 20,
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
  const execute = (prompt: string) =>
    adapter.prepareRun({ description: prompt, prompt }).execute({
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      controls: (async function* () {})(),
    });

  assert.deepEqual(await execute("first prompt"), {
    ending: "failed",
    errorMessage: "initialization unavailable",
  });
  assert.deepEqual(await execute("retry prompt"), { ending: "answered" });
  assert.deepEqual(await execute("resume prompt"), {
    ending: "failed",
    errorMessage: "continuation [redacted] unavailable",
  });

  assert.deepEqual(
    attempts.map((writes) => writes.map((write) => write.method)),
    [
      ["initialize"],
      ["initialize", "initialized", "thread/start", "turn/start"],
      ["initialize", "initialized", "thread/resume"],
    ],
  );
  assert.deepEqual(attempts[1]?.[3]?.params, {
    threadId: THREAD_ID,
    input: [
      {
        type: "text",
        text: "fixed role\n\nretry prompt",
        text_elements: [],
      },
    ],
  });
});

test("Codex does not retain a created thread before its first Turn accepts the Profile role", async () => {
  const attempts: Record<string, unknown>[][] = [[], []];
  const children: FakeChild[] = [];
  const spawn: ChildProcessSpawn = () => {
    const attempt = children.length;
    let attachedThread = `thread-${attempt + 1}`;
    const child = fakeChild((request, current) => {
      attempts[attempt]?.push(request);
      if (request.method === "initialize") {
        send(current, initializeResponse(request.id));
      } else if (request.method === "thread/start") {
        send(current, {
          id: request.id,
          result: { thread: { id: attachedThread } },
        });
      } else if (request.method === "thread/resume") {
        attachedThread = "thread-1";
        send(current, {
          id: request.id,
          result: { thread: { id: attachedThread } },
        });
      } else if (request.method === "turn/start") {
        if (attempt === 0) {
          send(current, {
            id: request.id,
            error: { code: -32000, message: "first turn rejected" },
          });
          return;
        }
        send(current, {
          id: request.id,
          result: { turn: { id: "turn-retry", status: "inProgress" } },
        });
        send(
          current,
          event("item/completed", {
            threadId: attachedThread,
            turnId: "turn-retry",
            item: {
              type: "agentMessage",
              id: "retry-answer",
              text: "role retained on retry",
              phase: "final_answer",
            },
            completedAtMs: 1,
          }),
        );
        send(
          current,
          event("turn/completed", {
            threadId: attachedThread,
            turn: {
              id: "turn-retry",
              items: [],
              status: "completed",
              error: null,
            },
          }),
        );
      }
    });
    const originalKill = child.kill;
    child.kill = (signal) => {
      const killed = originalKill(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.finish(0));
      return killed;
    };
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const adapter = createCodexHarness({ spawn, killEscalationMs: 1 }).prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "fixed Profile role",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const execute = (prompt: string) =>
    adapter.prepareRun({ description: prompt, prompt }).execute({
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      controls: (async function* () {})(),
    });

  assert.equal((await execute("first prompt")).ending, "failed");
  const retry = await execute("retry prompt");
  assert.deepEqual(
    attempts.map((writes) => writes.map((write) => write.method)),
    [
      ["initialize", "initialized", "thread/start", "turn/start"],
      ["initialize", "initialized", "thread/start", "turn/start"],
    ],
  );
  assert.deepEqual(attempts[1]?.[3]?.params, {
    threadId: "thread-2",
    input: [
      {
        type: "text",
        text: "fixed Profile role\n\nretry prompt",
        text_elements: [],
      },
    ],
  });
  assert.deepEqual(retry, { ending: "answered" });
  await adapter.close();
});

test("resumed Codex failures are honest, bounded, cleaned, and never fall back", async () => {
  const cases = [
    {
      name: "spawn failure",
      expected: "resumed spawn unavailable",
    },
    {
      name: "initialization failure",
      expected: "resumed initialization unavailable",
    },
    {
      name: "malformed resume response",
      expected: "invalid thread/resume response",
    },
    {
      name: "unavailable continuation",
      expected: "continuation [redacted] unavailable",
    },
    {
      name: "process loss",
      expected: "Child codex exited with code 9",
    },
    {
      name: "clean exit without answer",
      expected: "Codex exited without a terminal agent message answer.",
    },
  ] as const;

  for (const failure of cases) {
    let spawnCalls = 0;
    const children: FakeChild[] = [];
    const methods: string[][] = [[], []];
    const spawn: ChildProcessSpawn = () => {
      const attempt = spawnCalls++;
      if (attempt === 1 && failure.name === "spawn failure") {
        throw new Error(
          `resumed spawn unavailable {"threadId":"${THREAD_ID}"} ${"detail ".repeat(400)}`,
        );
      }
      const turnId = attempt === 0 ? "turn-seed" : "turn-failure";
      const child = fakeChild((request, current) => {
        methods[attempt]?.push(String(request.method));
        if (request.method === "initialize") {
          if (attempt === 1 && failure.name === "initialization failure") {
            send(current, {
              id: request.id,
              error: {
                code: -32000,
                message: "resumed initialization unavailable",
              },
            });
          } else send(current, initializeResponse(request.id));
        } else if (request.method === "thread/start") {
          send(current, {
            id: request.id,
            result: { thread: { id: THREAD_ID } },
          });
        } else if (request.method === "thread/resume") {
          if (failure.name === "malformed resume response") {
            send(current, { id: request.id, result: { thread: {} } });
          } else if (failure.name === "unavailable continuation") {
            send(current, {
              id: request.id,
              error: {
                code: -32001,
                message: `continuation ${THREAD_ID} unavailable`,
              },
            });
          } else {
            send(current, {
              id: request.id,
              result: { thread: { id: THREAD_ID } },
            });
          }
        } else if (request.method === "turn/start") {
          send(current, {
            id: request.id,
            result: { turn: { id: turnId, status: "inProgress" } },
          });
          if (attempt === 0) {
            send(
              current,
              event("item/completed", {
                threadId: THREAD_ID,
                turnId,
                item: {
                  type: "agentMessage",
                  id: "seed-answer",
                  text: "seed answer",
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
                  id: turnId,
                  items: [],
                  status: "completed",
                  error: null,
                },
              }),
            );
          } else if (failure.name === "process loss") {
            current.finish(9);
          } else if (failure.name === "clean exit without answer") {
            current.finish(0);
          }
        }
      });
      children.push(child);
      return child as unknown as ChildProcess;
    };
    const adapter = createCodexHarness({ spawn, killEscalationMs: 1 }).prepare({
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
    const execute = (prompt: string) =>
      adapter.prepareRun({ description: prompt, prompt }).execute({
        report: {
          message: () => {},
          transcript: () => {},
          activity: () => {},
          stderr: () => {},
        },
        controls: (async function* () {})(),
      });

    assert.deepEqual(await execute("seed"), { ending: "answered" });
    const ending = await execute(`fail: ${failure.name}`);
    assert.equal(ending.ending, "failed", failure.name);
    assert.ok(ending.errorMessage?.includes(failure.expected), failure.name);
    assert.ok((ending.errorMessage?.length ?? 0) <= 1024, failure.name);
    assert.equal(ending.errorMessage?.includes(THREAD_ID), false, failure.name);
    assert.equal(spawnCalls, 2, failure.name);
    assert.deepEqual(
      methods[1]?.filter(
        (method) => method === "thread/start" || method === "thread/resume",
      ),
      failure.name === "spawn failure" ||
        failure.name === "initialization failure"
        ? []
        : ["thread/resume"],
      failure.name,
    );
    for (const child of children) {
      assert.equal(child.listenerCount("close"), 0, failure.name);
      assert.equal(child.stdout.listenerCount("data"), 0, failure.name);
      assert.equal(child.stderr.listenerCount("data"), 0, failure.name);
      assert.equal(child.stdin.listenerCount("error"), 0, failure.name);
    }
    await adapter.close();
  }
});

test("a failed resumed Turn keeps only its partial output and leaks no state into recovery", async () => {
  const turnIds = ["turn-first", "turn-failed", "turn-recovery"];
  const children: FakeChild[] = [];
  const methods: string[][] = [[], [], []];
  const spawn: ChildProcessSpawn = () => {
    const attempt = children.length;
    const turnId = turnIds[attempt] as string;
    const child = fakeChild((request, current) => {
      methods[attempt]?.push(String(request.method));
      if (request.method === "initialize") {
        send(current, initializeResponse(request.id));
      } else if (request.method === "thread/start") {
        send(current, {
          id: request.id,
          result: { thread: { id: THREAD_ID, turns: [] } },
        });
      } else if (request.method === "thread/resume") {
        send(current, {
          id: request.id,
          result: { thread: { id: THREAD_ID, turns: [] } },
        });
      } else if (request.method === "turn/start") {
        send(current, {
          id: request.id,
          result: { turn: { id: turnId, status: "inProgress" } },
        });
        if (attempt === 1) {
          send(
            current,
            event("item/agentMessage/delta", {
              threadId: THREAD_ID,
              turnId,
              itemId: "failed-draft",
              delta: "second-only live activity",
            }),
          );
          send(
            current,
            event("item/completed", {
              threadId: THREAD_ID,
              turnId,
              item: {
                type: "agentMessage",
                id: "failed-draft",
                text: "partial second output",
                phase: "commentary",
              },
              completedAtMs: 1,
            }),
          );
          send(
            current,
            event("error", {
              threadId: THREAD_ID,
              turnId,
              error: { message: "second-only provider failure" },
              willRetry: false,
            }),
          );
          current.stderr.write("second-only stderr\n");
          current.finish(7);
          return;
        }
        const text = attempt === 0 ? "first stable answer" : "recovered answer";
        send(
          current,
          event("item/completed", {
            threadId: THREAD_ID,
            turnId,
            item: {
              type: "agentMessage",
              id: `answer-${attempt}`,
              text,
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
              id: turnId,
              items: [],
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          }),
        );
      }
    });
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const adapter = createCodexHarness({ spawn, killEscalationMs: 1 }).prepare({
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
  const execute = async (prompt: string) => {
    const facts: Parameters<RunReporter["message"]>[0][] = [];
    const activity: Array<string | undefined> = [];
    const stderr: string[] = [];
    const ending = await adapter
      .prepareRun({ description: prompt, prompt })
      .execute({
        report: {
          message: (fact) => facts.push(fact),
          transcript: () => {},
          activity: (value) => activity.push(value),
          stderr: (value) => stderr.push(value),
        },
        controls: (async function* () {})(),
      });
    return { ending, facts, activity, stderr };
  };

  const first = await execute("first");
  const firstSnapshot = structuredClone(first);
  const failed = await execute("fail after partial output");
  const recovered = await execute("recover explicitly");

  assert.deepEqual(first, firstSnapshot);
  assert.deepEqual(first.ending, { ending: "answered" });
  assert.deepEqual(failed.ending, {
    ending: "failed",
    errorMessage: "second-only provider failure",
  });
  assert.equal(
    failed.facts.some((fact) =>
      fact.parts.some(
        (part) => part.type === "text" && part.text === "partial second output",
      ),
    ),
    true,
  );
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
  assert.deepEqual(recovered.activity, [undefined]);
  assert.deepEqual(recovered.stderr, []);
  assert.equal(JSON.stringify(recovered).includes("second-only"), false);
  assert.deepEqual(methods, [
    ["initialize", "initialized", "thread/start", "turn/start"],
    ["initialize", "initialized", "thread/resume", "turn/start"],
    ["initialize", "initialized", "thread/resume", "turn/start"],
  ]);
  for (const child of children) {
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stdin.listenerCount("error"), 0);
  }
  await adapter.close();
});

test("resumed steering is current-Turn FIFO and never re-emits prior confirmed guidance", async () => {
  const turnIds = ["turn-guided-first", "turn-guided-second"];
  const children: FakeChild[] = [];
  const steerParams: Array<Record<string, unknown>[]> = [[], []];
  const spawn: ChildProcessSpawn = () => {
    const attempt = children.length;
    const turnId = turnIds[attempt] as string;
    const child = fakeChild((request, current) => {
      if (request.method === "initialize") {
        send(current, initializeResponse(request.id));
      } else if (request.method === "thread/start") {
        send(current, {
          id: request.id,
          result: { thread: { id: THREAD_ID, turns: [] } },
        });
      } else if (request.method === "thread/resume") {
        send(current, {
          id: request.id,
          result: {
            thread: {
              id: THREAD_ID,
              turns: [
                {
                  id: turnIds[0],
                  status: "completed",
                  items: [
                    {
                      type: "userMessage",
                      id: "attached-old-guidance",
                      clientId: "attached-old-correlation",
                      content: [
                        {
                          type: "text",
                          text: "confirmed first guidance",
                          text_elements: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        });
      } else if (request.method === "turn/start") {
        if (attempt === 1) {
          send(
            current,
            event("item/completed", {
              threadId: THREAD_ID,
              turnId: turnIds[0],
              item: {
                type: "userMessage",
                id: "late-old-guidance",
                clientId: "attached-old-correlation",
                content: [
                  {
                    type: "text",
                    text: "confirmed first guidance",
                    text_elements: [],
                  },
                ],
              },
              completedAtMs: 1,
            }),
          );
        }
        send(current, {
          id: request.id,
          result: { turn: { id: turnId, status: "inProgress" } },
        });
      } else if (request.method === "turn/steer") {
        const params = request.params as Record<string, unknown>;
        steerParams[attempt]?.push(params);
        send(current, { id: request.id, result: {} });
        const input = params.input as Array<Record<string, unknown>>;
        const text = String(input[0]?.text);
        send(
          current,
          event("item/completed", {
            threadId: THREAD_ID,
            turnId,
            item: {
              type: "userMessage",
              id: `confirmed-${attempt}-${steerParams[attempt]?.length}`,
              clientId: params.clientUserMessageId,
              content: [
                {
                  type: "text",
                  text: `confirmed ${text}`,
                  text_elements: [],
                },
              ],
            },
            completedAtMs: 1,
          }),
        );
        const expected = attempt === 0 ? 1 : 2;
        if (steerParams[attempt]?.length === expected) {
          send(
            current,
            event("item/completed", {
              threadId: THREAD_ID,
              turnId,
              item: {
                type: "agentMessage",
                id: `guided-answer-${attempt}`,
                text:
                  attempt === 0
                    ? "first guided answer"
                    : "resumed guided answer",
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
                id: turnId,
                items: [],
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            }),
          );
        }
      }
    });
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const adapter = createCodexHarness({ spawn, killEscalationMs: 1 }).prepare({
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
  const execute = async (prompt: string, controls: string[]) => {
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
        controls: (async function* (): AsyncIterable<RunControl> {
          for (const text of controls) yield { type: "steer", text };
        })(),
      });
    return { ending, facts };
  };

  const first = await execute("first", ["first guidance"]);
  const second = await execute("second", ["second guidance", "third guidance"]);

  assert.deepEqual(first.ending, { ending: "answered" });
  assert.deepEqual(second.ending, { ending: "answered" });
  assert.deepEqual(
    second.facts
      .filter((fact) => fact.role === "user")
      .flatMap((fact) => fact.parts)
      .map((part) => (part.type === "text" ? part.text : "")),
    ["confirmed second guidance", "confirmed third guidance"],
  );
  assert.equal(JSON.stringify(second.facts).includes("first guidance"), false);
  assert.deepEqual(
    steerParams.map((attempt) =>
      attempt.map((params) => ({
        threadId: params.threadId,
        expectedTurnId: params.expectedTurnId,
        text: (params.input as Array<Record<string, unknown>>)[0]?.text,
      })),
    ),
    [
      [
        {
          threadId: THREAD_ID,
          expectedTurnId: turnIds[0],
          text: "first guidance",
        },
      ],
      [
        {
          threadId: THREAD_ID,
          expectedTurnId: turnIds[1],
          text: "second guidance",
        },
        {
          threadId: THREAD_ID,
          expectedTurnId: turnIds[1],
          text: "third guidance",
        },
      ],
    ],
  );
  await adapter.close();
});

test("cancelling a resumed Turn interrupts only that Turn and preserves partial output", async () => {
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
    } else if (request.method === "thread/resume") {
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
  const endingPromise = runCodexAppServer({
    cwd: "/work",
    childDepth: 1,
    prompt: "resumed prompt",
    continuationThreadId: THREAD_ID,
    spawn: (() => child) as unknown as ChildProcessSpawn,
    killEscalationMs: 1,
    translate: createCodexTranslator("/work"),
    report: {
      message: (fact) => facts.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: (chunk) => stderr.push(chunk),
    },
    signal: controller.signal,
    controls: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({
            done: false as const,
            value: { type: "steer" as const, text: "racing guidance" },
          }),
          return: async () => {
            controlReturns++;
            return { done: true as const, value: undefined };
          },
        };
      },
    },
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
    controls: (async function* () {})(),
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
    controls: (async function* () {})(),
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
    controls: (async function* () {})(),
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
  const controls = (async function* (): AsyncIterable<RunControl> {
    yield { type: "steer", text: "locally accepted guidance" };
  })();

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
    controls: (async function* (): AsyncIterable<RunControl> {
      yield { type: "steer", text: "racing guidance" };
    })(),
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

test("Codex translator maps pinned events without leaking provider ids", () => {
  const translate = createCodexTranslator("/work");
  assert.deepEqual(
    translate(
      event("item/completed", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          type: "commandExecution",
          id: "item-id",
          command: "echo hi",
          cwd: "/work",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 1,
          commandActions: [],
        },
        completedAtMs: 1,
      }),
    ),
    {
      facts: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              name: "command_execution",
              arguments: { command: "echo hi" },
            },
          ],
          usage: { turns: 0 },
        },
      ],
    },
  );
  assert.deepEqual(translate(agent("answer")), {
    facts: [
      {
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        usage: { turns: 0 },
      },
    ],
    terminal: true,
  });
  assert.equal(translate(agent("legacy answer", undefined))?.terminal, true);

  const commentary = createCodexTranslator("/work");
  assert.equal(commentary(agent("working", "commentary"))?.terminal, false);
  assert.deepEqual(commentary(completedTurn()), {
    terminal: true,
    activity: null,
  });

  const facts = translate(agent("answer"))?.facts ?? [];
  assert.equal(JSON.stringify(facts).includes("provider"), false);
  assert.equal(JSON.stringify(facts).includes("thread"), false);
});

test("Codex translator reports normalized live activity", () => {
  const translate = createCodexTranslator("/work");
  assert.deepEqual(
    translate(
      event("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          type: "commandExecution",
          id: "command-item",
          command: "/bin/zsh -lc 'echo   hi'",
          cwd: "/work",
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
          commandActions: [],
        },
      }),
    ),
    { activity: "$ /bin/zsh -lc 'echo hi'" },
  );
  assert.deepEqual(
    translate(
      event("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "fileChange", changes: [{ path: "/work/src/index.ts" }] },
      }),
    ),
    { activity: "Editing src/index.ts" },
  );
  assert.deepEqual(
    translate(
      event("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "reasoning" },
      }),
    ),
    { activity: "Thinking…" },
  );
  assert.deepEqual(
    translate(
      event("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "plan" },
      }),
    ),
    { activity: "Planning…" },
  );
  assert.deepEqual(
    translate(
      event("item/reasoning/summaryTextDelta", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "r",
        delta: "**Inspecting auth**\nmore",
        summaryIndex: 0,
      }),
    ),
    { activity: "Inspecting auth" },
  );
  assert.deepEqual(
    translate(
      event("item/agentMessage/delta", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "m",
        delta: "answer",
      }),
    ),
    { activity: "answer" },
  );
  assert.deepEqual(
    translate(
      event("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "webSearch", query: "latest auth docs" },
      }),
    ),
    { activity: "Searching: latest auth docs" },
  );
  assert.deepEqual(
    translate(
      event("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "mcpToolCall", tool: "lookup" },
      }),
    ),
    { activity: "Calling lookup…" },
  );
  assert.equal(
    translate(
      event("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "mcpToolCall", tool: "x".repeat(200) },
      }),
    )?.activity?.length,
    120,
  );
});

test("Codex previews streaming agent messages without making them durable", () => {
  const translate = createCodexTranslator("/work");
  const delta = (itemId: string, text: string) =>
    agentMessageDelta(translate, itemId, text);

  assert.deepEqual(delta("message-1", "First"), { activity: "First" });
  assert.deepEqual(delta("message-1", " sentence. "), {
    activity: "First sentence.",
  });
  assert.deepEqual(delta("message-1", "Second"), { activity: "Second" });
  assert.deepEqual(delta("message-1", " sentence."), {
    activity: "Second sentence.",
  });
  assert.deepEqual(delta("message-1", "\n\n"), {
    activity: "Second sentence.",
  });
  assert.deepEqual(delta("message-2", "Version v1.2 is ready"), {
    activity: "Version v1.2 is ready",
  });
  assert.deepEqual(delta("message-3", "## **Summary**"), {
    activity: "Summary",
  });
  assert.deepEqual(delta("message-4", "- _ran_ agent_start"), {
    activity: "ran agent_start",
  });
  assert.deepEqual(delta("message-4", " and __checked__ PI_SUBAGENT_DEPTH"), {
    activity: "ran agent_start and __checked__ PI_SUBAGENT_DEPTH",
  });
  assert.deepEqual(delta("message-4", " via agent__start"), {
    activity:
      "ran agent_start and __checked__ PI_SUBAGENT_DEPTH via agent__start",
  });
  assert.deepEqual(delta("message-5", "```"), {
    activity: "Writing response…",
  });

  const preview = delta("message-6", "still ephemeral");
  assert.deepEqual(preview, { activity: "still ephemeral" });
});

test("Codex strips only paired unambiguous markdown from prose previews", () => {
  const translate = createCodexTranslator("/work");
  const preview = agentMessageDelta(
    translate,
    "markdown-and-code",
    "**bold** _italic_ ~~strike~~ `code` _private __dirname __init__ __checked__ value_ ~/.config *.ts *ptr",
  );

  assert.deepEqual(preview, {
    activity:
      "bold italic strike code _private __dirname __init__ __checked__ value_ ~/.config *.ts *ptr",
  });
});

test("Codex previews the advancing tail of a long current sentence", () => {
  const translate = createCodexTranslator("/work");
  const delta = (text: string) =>
    agentMessageDelta(translate, "long-message", text);

  const opening = `Working through ${"the implementation details ".repeat(6)}`;
  const first = delta(opening)?.activity;
  const second = delta("and now the final verification is running")?.activity;

  assert.equal(first?.length, 120);
  assert.match(first ?? "", /implementation details$/);
  assert.equal(second?.length, 120);
  assert.match(second ?? "", /final verification is running$/);
  assert.notEqual(second, first);
});

test("Codex isolates interleaved message previews and preserves fallback activity", () => {
  const translate = createCodexTranslator("/work");
  const delta = (itemId: string, text: string) =>
    agentMessageDelta(translate, itemId, text);

  assert.deepEqual(delta("one", "First item is "), {
    activity: "First item is",
  });
  assert.deepEqual(delta("two", "Second item is complete."), {
    activity: "Second item is complete.",
  });
  assert.deepEqual(delta("one", "still writing."), {
    activity: "First item is still writing.",
  });
  assert.deepEqual(delta("two", "\n\n"), {
    activity: "Second item is complete.",
  });
  assert.deepEqual(delta("three", "   \n\t"), {
    activity: "Writing response…",
  });
  assert.deepEqual(delta("four", "~~~typescript"), {
    activity: "Writing response…",
  });
});

test("Codex bounds and clears streaming message previews independently", () => {
  const translate = createCodexTranslator("/work");
  const delta = (itemId: string, text: string) =>
    agentMessageDelta(translate, itemId, text);
  const fullText = `Answer: ${"x".repeat(3_000)}`;

  assert.equal(delta("message-1", fullText)?.activity?.length, 120);
  assert.deepEqual(
    translate(
      itemCompleted({
        type: "agentMessage",
        id: "message-1",
        text: fullText,
        phase: "final_answer",
      }),
    )?.facts?.[0]?.parts,
    [{ type: "text", text: fullText }],
  );
  assert.deepEqual(delta("message-1", "fresh"), { activity: "fresh" });
});

test("Codex command output deltas surface the latest meaningful line", () => {
  const translate = createCodexTranslator("/work");
  const outputDelta = (itemId: string, delta: string) =>
    translate(
      event("item/commandExecution/outputDelta", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId,
        delta,
      }),
    );
  translate(
    event("item/started", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "npm test",
        cwd: "/work",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
        commandActions: [],
      },
    }),
  );
  // Blank output does not overwrite the current activity.
  assert.equal(outputDelta("command-1", "\n  \n"), undefined);
  assert.deepEqual(outputDelta("command-1", "PASS src/index.test.ts\n"), {
    activity: "$ npm test · PASS src/index.test.ts",
  });
  // Carriage-return progress rewrites count as the latest line.
  assert.deepEqual(outputDelta("command-1", "\rTests 12/40"), {
    activity: "$ npm test · Tests 12/40",
  });
  // Output for a command that never announced itself still shows progress.
  assert.deepEqual(outputDelta("command-2", "compiling worker\n"), {
    activity: "compiling worker",
  });
  // A long command leaves room for the output line.
  translate(
    event("item/started", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: {
        type: "commandExecution",
        id: "command-3",
        command: `run ${"x".repeat(200)}`,
        cwd: "/work",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
        commandActions: [],
      },
    }),
  );
  const long = outputDelta("command-3", "done\n");
  assert.equal(long?.activity?.endsWith("· done"), true);
  assert.equal((long?.activity?.length ?? 0) <= 120, true);
});

test("Codex folds cumulative usage updates exactly once", () => {
  const translate = createCodexTranslator("/work");
  const make = (total: Record<string, number>): CodexAppServerEvent =>
    event("thread/tokenUsage/updated", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      tokenUsage: { total, last: total },
    });
  const first = translate(
    make({
      totalTokens: 10,
      inputTokens: 7,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 2,
      reasoningOutputTokens: 1,
    }),
  );
  const second = translate(
    make({
      totalTokens: 25,
      inputTokens: 15,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 2,
      outputTokens: 6,
      reasoningOutputTokens: 2,
    }),
  );
  assert.deepEqual(
    [first?.facts?.[0]?.usage, second?.facts?.[0]?.usage],
    [
      {
        input: 7,
        cacheRead: 2,
        cacheWrite: 1,
        output: 3,
        contextTokens: 10,
        turns: 1,
      },
      {
        input: 8,
        cacheRead: 3,
        cacheWrite: 1,
        output: 5,
        contextTokens: 25,
        turns: 1,
      },
    ],
  );
});

test("Codex retryable errors are activity; fatal errors are facts", () => {
  const translate = createCodexTranslator("/work");
  const retry = translate(
    event("error", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      error: { message: "temporary" },
      willRetry: true,
    }),
  );
  const fatal = translate(
    event("error", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      error: { message: "permanent" },
      willRetry: false,
    }),
  );
  assert.deepEqual(retry, { activity: "Retrying after a provider error…" });
  assert.deepEqual(fatal, {
    facts: [{ role: "metadata", parts: [], errorMessage: "permanent" }],
    errorMessage: "permanent",
  });
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
      event: (value) => {
        forwarded.push(value.method);
        return undefined;
      },
      stderr: (value) => stderr.push(value),
    },
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, { ending: "answered" });
  assert.deepEqual(forwarded, ["item/completed", "turn/completed"]);
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
  const pending = source(
    { event: () => undefined, stderr: () => {} },
    controller.signal,
  );
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
  assert.deepEqual(
    await source(
      { event: () => undefined, stderr: () => {} },
      controller.signal,
    ),
    { ending: "cancelled" },
  );
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
