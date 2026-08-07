import assert from "node:assert/strict";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { SubagentTask } from "../backend.ts";
import { createEmptyResult } from "../backend.ts";
import {
  applyCodexNotification,
  buildCodexAppServerArgs,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  codexFeatureListSupportsBackend,
  collectCodexInheritedIntegrations,
  createCodexTranslationState,
  findCodexExecutable,
  getCodexSpawnOptions,
  hasCodexAppServer,
  resolveCodexEffort,
  resolveCodexModel,
  runCodexAgent,
} from "./codex.ts";

function task(
  overrides: Omit<Partial<SubagentTask>, "config"> & {
    config?: Partial<SubagentTask["config"]>;
  } = {},
): SubagentTask {
  const { config, ...taskOverrides } = overrides;
  return {
    config: {
      name: "worker",
      description: "Does work",
      harness: "codex",
      systemPrompt: "You are the worker.",
      ...config,
    },
    description: "Implement",
    prompt: "Implement the change.",
    cwd: "/tmp/a.project",
    agentDir: "/tmp/agent",
    depth: 0,
    projectTrusted: true,
    ...taskOverrides,
  };
}

test("resolveCodexModel leaves inherit to Codex and passes pins verbatim", () => {
  assert.equal(resolveCodexModel(task().config), undefined);
  assert.equal(
    resolveCodexModel(task({ config: { model: "inherit" } }).config),
    undefined,
  );
  assert.equal(
    resolveCodexModel(task({ config: { model: "gpt-5.6-sol" } }).config),
    "gpt-5.6-sol",
  );
});

test("resolveCodexEffort maps off to Codex none", () => {
  assert.equal(resolveCodexEffort("off"), "none");
  assert.equal(resolveCodexEffort("minimal"), "minimal");
  assert.equal(resolveCodexEffort("max"), "max");
  assert.equal(resolveCodexEffort(undefined), undefined);
});

test("Codex compatibility requires both delegation feature gates", () => {
  assert.equal(
    codexFeatureListSupportsBackend(`
multi_agent       stable             true
multi_agent_v2    under development  false
`),
    true,
  );
  assert.equal(
    codexFeatureListSupportsBackend(`
multi_agent       stable  true
hooks             stable  true
`),
    false,
  );
});

function probeSpawn(
  responses: Array<{ stdout?: string; code?: number; error?: Error }>,
  calls: string[][],
): typeof spawn {
  return ((_: string, args: readonly string[]) => {
    calls.push([...args]);
    const response = responses.shift() ?? { code: 1 };
    const child = new EventEmitter() as ChildProcess & {
      stdout: PassThrough;
    };
    child.stdout = new PassThrough();
    queueMicrotask(() => {
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.error) child.emit("error", response.error);
      child.emit("close", response.code ?? (response.error ? 1 : 0));
    });
    return child;
  }) as unknown as typeof spawn;
}

test("Codex availability probes app server and its required features", async () => {
  const calls: string[][] = [];
  const available = await hasCodexAppServer(
    "/fake/codex",
    probeSpawn(
      [
        { code: 0 },
        {
          code: 0,
          stdout:
            "multi_agent stable true\nmulti_agent_v2 under-development false\n",
        },
      ],
      calls,
    ),
  );

  assert.equal(available, true);
  assert.deepEqual(calls, [
    ["app-server", "--help"],
    ["features", "list"],
  ]);
});

test("Codex availability rejects an app server missing a required feature", async () => {
  const available = await hasCodexAppServer(
    "/fake/codex",
    probeSpawn(
      [{ code: 0 }, { code: 0, stdout: "multi_agent stable true\n" }],
      [],
    ),
  );

  assert.equal(available, false);
});

test("Codex availability rejects a missing binary and spawn errors", async () => {
  assert.equal(findCodexExecutable(""), undefined);
  assert.equal(
    await hasCodexAppServer(
      "/fake/codex",
      probeSpawn([{ error: new Error("ENOENT") }], []),
    ),
    false,
  );
});

test("Codex app-server args disable native delegation and forward trust", () => {
  assert.deepEqual(buildCodexAppServerArgs(task()), [
    "app-server",
    "--stdio",
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "-c",
    'projects."/tmp/a.project".trust_level="trusted"',
  ]);
});

test("an untrusted Codex run disables executable project integrations", () => {
  const args = buildCodexAppServerArgs(task({ projectTrusted: false }));
  assert.deepEqual(args.slice(-6), [
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    "--disable",
    "apps",
  ]);
  assert.ok(args.includes('projects."/tmp/a.project".trust_level="untrusted"'));
});

test("Codex advances the harness-neutral nesting depth", () => {
  const options = getCodexSpawnOptions(task({ depth: 2 }));
  assert.equal(options.env?.PI_SUBAGENT_DEPTH, "3");
  assert.equal(options.cwd, "/tmp/a.project");
  assert.equal(options.shell, false);
});

test("Codex appends system instructions when the field is omitted", () => {
  const appended = buildCodexThreadStartParams(task());
  assert.equal(appended.cwd, "/tmp/a.project");
  assert.equal(appended.baseInstructions, undefined);
  assert.equal(appended.developerInstructions, "You are the worker.");
  assert.equal(appended.approvalPolicy, "never");
  assert.equal(appended.sandbox, "danger-full-access");
  assert.equal(appended.ephemeral, true);
  assert.deepEqual(appended.config.features, {
    multi_agent: false,
    multi_agent_v2: false,
  });
});

test("Codex replaces system instructions when explicitly configured", () => {
  const replaced = buildCodexThreadStartParams(
    task({ config: { appendSystemPrompt: false } }),
  );
  assert.equal(replaced.baseInstructions, "You are the worker.");
  assert.equal(replaced.developerInstructions, undefined);
});

test("an untrusted Codex thread disables inherited integrations without an explicit cwd", () => {
  const params = buildCodexThreadStartParams(task({ projectTrusted: false }), {
    mcpServers: ["computer-use", "node.repl"],
    apps: ["github", "linear"],
  });
  assert.equal(params.cwd, undefined);
  assert.deepEqual(params.config.mcp_servers, {
    "computer-use": { enabled: false },
    "node.repl": { enabled: false },
  });
  assert.deepEqual(params.config.apps, {
    github: { enabled: false },
    linear: { enabled: false },
  });
  assert.deepEqual(params.config.features, {
    multi_agent: false,
    multi_agent_v2: false,
    hooks: false,
    plugins: false,
    apps: false,
  });
});

test("Codex disables effective integrations but ignores layer-only entries", () => {
  assert.deepEqual(
    collectCodexInheritedIntegrations({
      config: {
        mcp_servers: { user: {}, shared: {} },
        apps: { calendar: {} },
      },
      layers: [
        {
          name: { type: "project" },
          config: {
            mcp_servers: { project: {}, shared: {} },
            apps: { github: {}, calendar: {} },
          },
        },
        { name: { type: "system" }, config: {} },
      ],
    }),
    {
      mcpServers: ["shared", "user"],
      apps: ["calendar"],
    },
  );
});

test("Codex turn input keeps the prompt off the process arguments", () => {
  assert.deepEqual(
    buildCodexTurnStartParams("thread-1", task({ config: { effort: "high" } })),
    {
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: "Implement the change.",
          text_elements: [],
        },
      ],
      effort: "high",
    },
  );
});

test("Codex agent deltas are coalesced and completed authoritatively", () => {
  const result = createEmptyResult("worker", "Implement", "codex");
  result.model = "gpt-test";
  const state = createCodexTranslationState();

  applyCodexNotification(
    {
      method: "item/agentMessage/delta",
      params: { itemId: "answer", delta: "hel" },
    },
    result,
    state,
  );
  applyCodexNotification(
    {
      method: "item/agentMessage/delta",
      params: { itemId: "answer", delta: "lo" },
    },
    result,
    state,
  );
  applyCodexNotification(
    {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: "answer",
          text: "hello!",
          phase: "final_answer",
        },
      },
    },
    result,
    state,
  );

  assert.equal(result.messages.length, 1);
  const message = result.messages[0];
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [{ type: "text", text: "hello!" }]);
});

test("Codex command items become a tool call and result exactly once", () => {
  const result = createEmptyResult("worker", "Implement", "codex");
  const state = createCodexTranslationState();
  const started = {
    type: "commandExecution",
    id: "cmd-1",
    command: "npm test",
    cwd: "/repo",
    status: "inProgress",
  };
  const completed = {
    ...started,
    status: "completed",
    aggregatedOutput: "ok",
    exitCode: 0,
  };

  applyCodexNotification(
    { method: "item/started", params: { item: started } },
    result,
    state,
  );
  applyCodexNotification(
    { method: "item/completed", params: { item: completed } },
    result,
    state,
  );
  applyCodexNotification(
    { method: "item/completed", params: { item: completed } },
    result,
    state,
  );

  assert.equal(result.messages.length, 2);
  const call = result.messages[0];
  const toolResult = result.messages[1];
  assert.equal(call.role, "assistant");
  assert.deepEqual(call.content[0], {
    type: "toolCall",
    id: "cmd-1",
    name: "bash",
    arguments: { command: "npm test", cwd: "/repo" },
  });
  assert.equal(toolResult.role, "toolResult");
  assert.equal(toolResult.toolName, "bash");
  assert.deepEqual(toolResult.content, [{ type: "text", text: "ok" }]);
  assert.equal(toolResult.isError, false);
});

test("Codex token totals replace the live usage display", () => {
  const result = createEmptyResult("worker", "Implement", "codex");
  const state = createCodexTranslationState();
  applyCodexNotification(
    {
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: {
            totalTokens: 24,
            inputTokens: 15,
            cachedInputTokens: 4,
            outputTokens: 9,
          },
          last: { totalTokens: 19 },
        },
      },
    },
    result,
    state,
  );
  assert.deepEqual(result.usage, {
    input: 15,
    output: 9,
    cacheRead: 4,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 19,
    turns: 0,
  });
});

test("Codex turn completion settles success and failure", () => {
  const success = createEmptyResult("worker", "Implement", "codex");
  applyCodexNotification(
    {
      method: "turn/completed",
      params: { turn: { id: "turn", status: "completed", error: null } },
    },
    success,
    createCodexTranslationState(),
  );
  assert.equal(success.exitCode, 0);
  assert.equal(success.stopReason, "stop");

  const failure = createEmptyResult("worker", "Implement", "codex");
  applyCodexNotification(
    {
      method: "turn/completed",
      params: {
        turn: {
          id: "turn",
          status: "failed",
          error: { message: "model unavailable" },
        },
      },
    },
    failure,
    createCodexTranslationState(),
  );
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.stopReason, "error");
  assert.equal(failure.errorMessage, "model unavailable");
});

test("untrusted Codex lifecycle disables layered integrations before starting", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  let killed = false;
  Object.defineProperty(child, "killed", { get: () => killed });
  child.kill = (() => {
    killed = true;
    queueMicrotask(() => child.emit("close", 0));
    return true;
  }) as ChildProcess["kill"];

  const requests: Array<Record<string, unknown>> = [];
  let inputBuffer = "";
  stdin.on("data", (chunk) => {
    inputBuffer += chunk.toString();
    const lines = inputBuffer.split("\n");
    inputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      requests.push(message);
      if (message.method === "initialize") {
        stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      } else if (message.method === "config/read") {
        stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              config: {
                mcp_servers: { user: {} },
                apps: { calendar: {} },
              },
              layers: [
                {
                  name: { type: "project" },
                  config: {
                    mcp_servers: { project: {} },
                    apps: { github: {} },
                  },
                },
              ],
              origins: {},
            },
          })}\n`,
        );
      } else if (message.method === "thread/start") {
        stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              thread: { id: "thread-1" },
              model: "gpt-test",
            },
          })}\n`,
        );
      } else if (message.method === "turn/start") {
        stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: { turn: { id: "turn-1" } },
          })}\n`,
        );
        queueMicrotask(() => {
          stdout.write(
            `${JSON.stringify({
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  id: "answer",
                  text: "Done.",
                },
              },
            })}\n`,
          );
          stdout.write(
            `${JSON.stringify({
              method: "turn/completed",
              params: {
                turn: { id: "turn-1", status: "completed", error: null },
              },
            })}\n`,
          );
        });
      }
    }
  });

  const result = createEmptyResult("worker", "Implement", "codex");
  const completed = await runCodexAgent(
    {
      task: task({
        projectTrusted: false,
        config: { appendSystemPrompt: false },
      }),
      result,
      // A host callback failure must not strand the app-server turn.
      emit: () => {
        throw new Error("renderer unavailable");
      },
    },
    (() => child) as unknown as typeof spawn,
    "/fake/codex",
  );

  assert.equal(completed.exitCode, 0);
  assert.equal(Object.hasOwn(completed, "sessionId"), false);
  assert.equal(completed.model, "gpt-test");
  assert.equal(completed.usage.turns, 1);
  assert.match(completed.stderr, /progress callback failed/);
  const answer = completed.messages.at(-1);
  assert.equal(answer?.role, "assistant");
  assert.deepEqual(answer?.content, [{ type: "text", text: "Done." }]);
  assert.deepEqual(
    requests
      .map((request) => request.method)
      .filter((method) => method !== undefined),
    ["initialize", "initialized", "config/read", "thread/start", "turn/start"],
  );
  const configRead = requests.find(
    (request) => request.method === "config/read",
  );
  assert.deepEqual(configRead?.params, {
    cwd: "/tmp/a.project",
    includeLayers: false,
  });
  const threadStart = requests.find(
    (request) => request.method === "thread/start",
  );
  assert.deepEqual(threadStart?.params, {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    baseInstructions: "You are the worker.",
    ephemeral: true,
    config: {
      features: {
        multi_agent: false,
        multi_agent_v2: false,
        hooks: false,
        plugins: false,
        apps: false,
      },
      mcp_servers: {
        user: { enabled: false },
      },
      apps: {
        calendar: { enabled: false },
      },
    },
  });
  assert.equal(killed, true);
});

test("Codex backend interrupts an in-flight turn when cancelled", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  let killed = false;
  Object.defineProperty(child, "killed", { get: () => killed });
  child.kill = (() => {
    killed = true;
    queueMicrotask(() => child.emit("close", 0));
    return true;
  }) as ChildProcess["kill"];

  const controller = new AbortController();
  let sawInterrupt = false;
  let inputBuffer = "";
  stdin.on("data", (chunk) => {
    inputBuffer += chunk.toString();
    const lines = inputBuffer.split("\n");
    inputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "initialize") {
        stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      } else if (message.method === "thread/start") {
        stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: { thread: { id: "thread-1" }, model: "gpt-test" },
          })}\n`,
        );
      } else if (message.method === "turn/start") {
        stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: { turn: { id: "turn-1" } },
          })}\n`,
        );
        setImmediate(() => controller.abort());
      } else if (message.method === "turn/interrupt") {
        sawInterrupt = true;
        stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        stdout.write(
          `${JSON.stringify({
            method: "turn/completed",
            params: {
              turn: { id: "turn-1", status: "interrupted", error: null },
            },
          })}\n`,
        );
      }
    }
  });

  const result = createEmptyResult("worker", "Implement", "codex");
  const cancelled = await runCodexAgent(
    {
      task: task(),
      result,
      emit: () => {},
      signal: controller.signal,
    },
    (() => child) as unknown as typeof spawn,
    "/fake/codex",
  );

  assert.equal(sawInterrupt, true);
  assert.equal(cancelled.exitCode, 1);
  assert.equal(cancelled.stopReason, "aborted");
  assert.equal(cancelled.errorMessage, "Subagent was aborted");
  assert.equal(killed, true);
});
