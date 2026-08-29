import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessSpawn } from "../../child-process.ts";
import { DEPTH_ENV_KEY, type RunControl, type RunReporter } from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "../conformance.ts";
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
  const execution = harness.prepare({
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
    task: {
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
    },
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
  const execution = createCodexHarness({
    spawn: (() => child) as unknown as ChildProcessSpawn,
    killEscalationMs: 1,
  }).prepare(task);

  const ending = await execution.execute({
    task,
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
  const execution = createCodexHarness({
    spawn: (() => child) as unknown as ChildProcessSpawn,
    killEscalationMs: 1,
  }).prepare(task);

  const ending = await execution.execute({
    task,
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
  const execution = createCodexHarness({
    spawn: (() => child) as unknown as ChildProcessSpawn,
    killEscalationMs: 1,
  }).prepare(task);
  const controls = (async function* (): AsyncIterable<RunControl> {
    yield { type: "steer", text: "locally accepted guidance" };
  })();

  const pending = execution.execute({
    task,
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
  const execution = createCodexHarness({
    spawn: (() => child) as unknown as ChildProcessSpawn,
    killEscalationMs: 1,
  }).prepare(task);

  const ending = await execution.execute({
    task,
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

  const prepared = harness.prepare({
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
