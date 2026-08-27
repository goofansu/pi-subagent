import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessSpawn } from "../../child-process.ts";
import { DEPTH_ENV_KEY, type RunReporter } from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "../conformance.ts";
import {
  type CodexAppServerEvent,
  createCodexAppServerSource,
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

const THREAD_ID = "thread-provider-id";
const TURN_ID = "turn-provider-id";

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
  observed: { child?: FakeChild; depth?: number },
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
          }
        });
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
      const observed: { child?: FakeChild; depth?: number } = {};
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
  const source = createCodexAppServerSource({
    cwd: "/work",
    childDepth: 1,
    prompt: "system\n\nuser",
    model: "gpt",
    effort: "none",
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const sink = { event: () => undefined, stderr: () => {} };
  assert.deepEqual(await source(sink, new AbortController().signal), {
    status: "clean",
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
    { activity: "Writing response…" },
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
  const source = createCodexAppServerSource({
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
  assert.deepEqual(conclusion, { status: "clean" });
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
  const source = createCodexAppServerSource({
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
  assert.deepEqual(await pending, { status: "clean" });
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
  const source = createCodexAppServerSource({
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
    { status: "clean" },
  );
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
