import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ControlAdmission, createControlGate } from "./control-source.ts";
import { createSubagentDelivery, type PushedNotification } from "./delivery.ts";
import type { ChildProcessSpawn } from "./harnesses/codex/app-server.ts";
import { createCodexHarness } from "./harnesses/codex/harness.ts";
import {
  createHarnessRegistry,
  type Harness,
  type HarnessAdapter,
} from "./harnesses/contract.ts";
import subagentExtension, {
  createSubagentRuntime,
  registerSubagentFeatureTools,
} from "./index.ts";
import { buildNotificationMessage } from "./notification-message.ts";
import { withPiChildExtensionLoad } from "./pi-child-extension-load.ts";
import { createEmptyResult, type RunEnding, type SubagentRun } from "./run.ts";
import { createSubagentRuns } from "./runs.ts";
import {
  createSubagentManager,
  type StartedManagedSubagent,
  type StartManagedSubagentOptions,
} from "./subagents.ts";
import type { AgentConfig, RenderableTheme } from "./types.ts";

initTheme(undefined, false);

// ── Extension registration ───────────────────────────────────────────────────

test("the extension is not exposed inside a subagent Pi process", async () => {
  const originalDepth = process.env.PI_SUBAGENT_DEPTH;
  try {
    const nestedEvents: string[] = [];
    process.env.PI_SUBAGENT_DEPTH = "1";
    subagentExtension({
      on(event: string) {
        nestedEvents.push(event);
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(nestedEvents, []);

    const parentHost = () => {
      const handlers: Record<string, (event: unknown, ctx: unknown) => void> =
        {};
      const events: string[] = [];
      const tools: string[] = [];
      return {
        handlers,
        events,
        tools,
        pi: {
          on(event: string, handler: (event: unknown, ctx: unknown) => void) {
            events.push(event);
            handlers[event] = handler;
          },
          registerTool(tool: { name: string }) {
            tools.push(tool.name);
          },
          registerMessageRenderer() {},
          registerCommand() {},
          getThinkingLevel: () => "off",
          sendMessage() {},
          sendUserMessage() {},
        } as unknown as ExtensionAPI,
      };
    };
    const firstParent = parentHost();
    const secondParent = parentHost();
    delete process.env.PI_SUBAGENT_DEPTH;
    subagentExtension(firstParent.pi);
    const reloadedExtension = (
      await import(`./index.ts?parent-reattach=${Date.now()}`)
    ).default;
    reloadedExtension(secondParent.pi);
    const expected = [
      "session_start",
      "session_shutdown",
      "message_start",
      "turn_end",
      "agent_settled",
    ];
    assert.deepEqual(firstParent.events, expected);
    assert.deepEqual(secondParent.events, expected);

    const context = {
      cwd: "/project",
      modelRegistry: { getAll: () => [] },
      isProjectTrusted: () => false,
      ui: { notify() {}, setWidget() {} },
    };
    firstParent.handlers.session_start({}, context);
    secondParent.handlers.session_start({}, context);
    const expectedTools = [
      "agent_start",
      "agent_resume",
      "agent_wait",
      "agent_result",
      "agent_cancel",
      "agent_steer",
    ];
    assert.deepEqual(firstParent.tools, expectedTools);
    assert.deepEqual(secondParent.tools, expectedTools);
  } finally {
    if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = originalDepth;
  }
});

test("an in-process Pi child extension load stays inert without process depth", async () => {
  const originalDepth = process.env.PI_SUBAGENT_DEPTH;
  try {
    delete process.env.PI_SUBAGENT_DEPTH;
    const childEvents: string[] = [];

    await withPiChildExtensionLoad(async () => {
      await Promise.resolve();
      const childLoadedExtension = (
        await import(`./index.ts?child-binding=${Date.now()}`)
      ).default;
      childLoadedExtension({
        on(event: string) {
          childEvents.push(event);
        },
      } as unknown as ExtensionAPI);
    });

    assert.deepEqual(childEvents, []);
  } finally {
    if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = originalDepth;
  }
});

test("interrupt bookkeeping survives turns of any shape", () => {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> =
    {};
  createSubagentRuntime({ agentsDir: "/agents" }).attach({
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI);

  // The abort path reads the turn's ending; a turn with no message at all
  // must not take the handler down with it.
  assert.doesNotThrow(() => handlers.turn_end({}, {}));
  assert.doesNotThrow(() =>
    handlers.turn_end({ message: { stopReason: "aborted" } }, {}),
  );
  assert.doesNotThrow(() => handlers.agent_settled({}, {}));
});

interface SentMessage {
  customType: string;
  content: string;
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

interface RegisteredTools {
  [name: string]: {
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: undefined,
      ctx?: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }>;
    renderResult?(
      result: {
        content: string | Array<{ type: string; text?: string }>;
        details?: unknown;
      },
      options: { expanded: boolean; isPartial: boolean },
      theme: RenderableTheme,
      context: unknown,
    ): Component;
  };
}

/** Collect every tool the extension registers, keyed by name. */
function collectTools(): {
  pi: ExtensionAPI;
  tools: RegisteredTools;
  sent: SentMessage[];
  push?: (report: PushedNotification) => void;
} {
  const tools: RegisteredTools = {};
  const sent: SentMessage[] = [];
  const pi = {
    registerCommand() {},
    registerTool(tool: { name: string }) {
      tools[tool.name] = tool as unknown as RegisteredTools[string];
    },
    registerMessageRenderer() {},
    getThinkingLevel: () => "off",
    sendMessage(
      message: { customType: string; content: string },
      options?: { deliverAs?: string; triggerTurn?: boolean },
    ) {
      sent.push({ ...message, options });
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, sent };
}

/** A stand-in for a started run that settles when the test says so. */
function fakeStart(onOptions: (options: StartManagedSubagentOptions) => void) {
  let settle: (() => void) | undefined;
  const start = (
    options: StartManagedSubagentOptions,
  ): StartedManagedSubagent => {
    onOptions(options);
    const result = createEmptyResult(
      options.config.name,
      "task",
      0,
      "pi",
      "subagent-1",
    );
    return {
      subagentId: "subagent-1",
      runId: "run-1",
      settled: new Promise((resolve) => {
        settle = () => {
          result.lifecycle = {
            phase: "completed",
            finishedAt: 10,
          };
          resolve(result);
        };
      }),
    };
  };
  return {
    start,
    resume: () => ({ outcome: "unknown subagent" as const }),
    settle: () => settle?.(),
  };
}

test("agent_start reads the live session's trust and cwd at execute time", async () => {
  let executeTrustChecks = 0;
  let forwardedTrust: boolean | undefined;
  let forwardedCwd: string | undefined;
  const { pi, tools } = collectTools();
  const started = fakeStart((options) => {
    forwardedTrust = options.projectTrusted;
    forwardedCwd = options.cwd;
  });
  const session = { cwd: "/project", projectTrusted: false };

  const runs = createSubagentRuns();
  registerSubagentFeatureTools(
    pi,
    session,
    new Map([["worker", agentConfig("worker")]]),
    {
      subagents: { start: started.start, resume: started.resume },
      delivery: createSubagentDelivery({ runs, push: () => {} }),
    },
  );

  const execute = () =>
    tools.agent_start.execute(
      "call-1",
      { agent: "worker", description: "task", prompt: "work" },
      new AbortController().signal,
      undefined,
      {
        // The execute-time ctx must never be consulted for trust; the session
        // context is the one source, so lying here must change nothing.
        isProjectTrusted() {
          executeTrustChecks++;
          return !session.projectTrusted;
        },
      },
    );

  await execute();
  started.settle();
  assert.equal(forwardedTrust, false);
  assert.equal(forwardedCwd, "/project");

  // A later session_start refills the context; the tools registered by the
  // first session must follow it rather than keep what they were born with.
  session.projectTrusted = true;
  session.cwd = "/elsewhere";
  await execute();
  started.settle();

  assert.equal(forwardedTrust, true);
  assert.equal(forwardedCwd, "/elsewhere");
  assert.equal(executeTrustChecks, 0);
});

test("agent_start returns distinct Subagent and first-Run identities immediately", async () => {
  const boundary = runtimeBoundary(["run-1"]);

  const response = await boundary.tools.agent_start.execute(
    "call",
    { agent: "worker", description: "task", prompt: "work" },
    undefined,
    undefined,
    {},
  );
  const text = response.content[0].text;
  const subagentId = text.match(/subagent id (subagent-\S+)/)?.[1];
  const runId = text.match(/run id (run-\S+)/)?.[1];

  assert.ok(subagentId);
  assert.equal(runId, "run-1");
  assert.notEqual(subagentId, runId);
  assert.match(
    text,
    /Use run id run-1 for agent_wait, agent_result, agent_cancel, and agent_steer/,
  );
  assert.equal(boundary.active.length, 1, "the stand-in executor is running");
  assert.equal(boundary.runs.list()[0].status, "running");
});

interface BoundaryRun {
  controls: SubagentRun["controls"];
  report: SubagentRun["report"];
  signal?: AbortSignal;
  task: { description: string; prompt: string };
  resolve(ending: RunEnding): void;
}

function runtimeBoundary(
  ids: string[],
  {
    pushThrows = false,
    subagentIds,
    resumable = false,
    steerable = false,
    resultBudget,
    times,
  }: {
    pushThrows?: boolean;
    subagentIds?: string[];
    resumable?: boolean;
    steerable?: boolean;
    resultBudget?: number;
    times?: number[];
  } = {},
) {
  const { pi, tools } = collectTools();
  const runs = createSubagentRuns({ now: () => 0 }, () => {
    const id = ids.shift();
    assert.ok(id, "ran out of boundary-test ids");
    return id;
  });
  const pushed: PushedNotification[] = [];
  const delivery = createSubagentDelivery({
    runs,
    ...(resultBudget === undefined ? {} : { resultBudget }),
    push: (notification) => {
      pushed.push(notification);
      if (pushThrows) throw new Error("push failed");
    },
  });
  const active: BoundaryRun[] = [];
  const adapterCloses: number[] = [];
  let widgetFactory:
    | ((
        tui: { requestRender(): void },
        theme: {
          fg(_tone: string, text: string): string;
          bold(text: string): string;
        },
      ) => { render(width: number): string[] })
    | undefined;
  const harness: Harness = {
    name: "pi",
    validate: () => [],
    prepare: () => {
      const index = adapterCloses.push(0) - 1;
      let closed = false;
      let semanticMarker: string | undefined;
      const prepareRun: HarnessAdapter["prepareRun"] = (task) => ({
        execute: (run) => {
          const marker = task.prompt.match(/^remember: (.+)$/)?.[1];
          if (marker) semanticMarker = marker;
          if (task.prompt === "recall marker") {
            run.report.message({
              role: "assistant",
              parts: [
                {
                  type: "text",
                  text: `private marker: ${semanticMarker ?? "missing"}`,
                },
              ],
            });
          }
          return new Promise((resolve) =>
            active.push({
              report: run.report,
              signal: run.signal,
              controls: run.controls,
              task,
              resolve,
            }),
          );
        },
        supportedControls: steerable ? ["steer"] : [],
      });
      return {
        model: undefined,
        prepareRun,
        admitResume: (task) =>
          resumable
            ? { outcome: "admitted", run: prepareRun(task) }
            : { outcome: "unsupported" },
        close: async () => {
          if (closed) return;
          closed = true;
          adapterCloses[index]++;
        },
      };
    },
  };

  const events: Record<string, (event: unknown, ctx?: unknown) => void> = {};
  const eventPi = {
    ...pi,
    on(event: string, handler: (event: unknown, ctx?: unknown) => void) {
      events[event] = handler;
    },
  } as unknown as ExtensionAPI;
  const agentsDir = mkdtempSync(path.join(tmpdir(), "subagent-boundary-"));
  writeAgent(agentsDir, "worker");
  const harnesses = createHarnessRegistry([harness]);
  let subagentSequence = 0;
  const runtime = createSubagentRuntime({
    agentsDir,
    runs,
    delivery,
    harnesses,
    subagents: createSubagentManager({
      harnesses,
      runs,
      ...(times
        ? {
            now: () =>
              times.shift() ?? assert.fail("unexpected manager clock read"),
          }
        : {}),
      generateSubagentId: () => {
        if (!subagentIds) return `subagent-${++subagentSequence}`;
        const id = subagentIds.shift();
        assert.ok(id, "ran out of boundary-test Subagent ids");
        return id;
      },
    }),
  });
  runtime.attach(eventPi);
  const beginSession = () =>
    events.session_start?.(
      {},
      {
        cwd: "/project",
        modelRegistry: { getAll: () => [] },
        ui: {
          notify() {},
          setWidget(_key: string, content: unknown) {
            widgetFactory = content as typeof widgetFactory;
          },
        },
      },
    );
  beginSession();

  const startIdentities = async (): Promise<{
    subagentId: string;
    runId: string;
  }> => {
    const result = await tools.agent_start.execute(
      "call",
      { agent: "worker", description: "task", prompt: "work" },
      undefined,
      undefined,
      {},
    );
    const text = result.content[0].text;
    const subagentId = text.match(/subagent id (\S+)/)?.[1];
    const runId = text.match(/run id (\S+)/)?.[1];
    assert.ok(subagentId);
    assert.ok(runId);
    return { subagentId, runId };
  };
  const start = async (): Promise<string> => (await startIdentities()).runId;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const renderWidget = (): string => {
    assert.ok(widgetFactory, "runs widget is installed");
    const component = widgetFactory(
      { requestRender() {} },
      {
        fg: (_tone, text) => text,
        bold: (text) => text,
      },
    );
    return component.render(100).join("\n");
  };

  return {
    tools,
    runs,
    pushed,
    active,
    adapterCloses,
    events,
    beginSession,
    delivery,
    start,
    startIdentities,
    flush,
    renderWidget,
  };
}

test("agent_resume starts a distinct Run with retained private Harness context", async () => {
  const boundary = runtimeBoundary(["run-first", "run-second", "run-third"], {
    resumable: true,
    times: [100, 200, 300, 400, 500, 600],
  });
  const first = await boundary.tools.agent_start.execute(
    "start",
    {
      agent: "worker",
      description: "establish context",
      prompt: "remember: heliotrope",
    },
    undefined,
    undefined,
    {},
  );
  const subagentId = first.content[0].text.match(/subagent id (\S+)/)?.[1];
  assert.ok(subagentId);

  boundary.active[0].report.message({
    role: "assistant",
    parts: [{ type: "text", text: "marker stored" }],
    usage: { input: 7, output: 1, turns: 1 },
  });
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  const firstResultBefore = structuredClone(
    boundary.delivery.result("run-first"),
  );

  const resumed = await boundary.tools.agent_resume.execute("resume", {
    id: subagentId,
    description: "use retained context",
    prompt: "recall marker",
  });

  assert.match(resumed.content[0].text, /run id run-second/);
  assert.match(resumed.content[0].text, /returns immediately/i);
  assert.equal(boundary.active.length, 2);
  assert.deepEqual(
    boundary.adapterCloses,
    [0],
    "resume reuses the one adapter prepared from fixed creation policy",
  );
  assert.deepEqual(boundary.active[1].task, {
    description: "use retained context",
    prompt: "recall marker",
  });
  assert.notStrictEqual(boundary.active[1].report, boundary.active[0].report);
  assert.notStrictEqual(boundary.active[1].signal, boundary.active[0].signal);
  assert.notStrictEqual(
    boundary.active[1].controls,
    boundary.active[0].controls,
  );
  boundary.active[1].resolve({ ending: "answered" });
  await boundary.flush();

  assert.equal(boundary.pushed.length, 2);
  assert.deepEqual(
    boundary.delivery.result("run-first"),
    firstResultBefore,
    "the first Result remains byte-for-byte unchanged",
  );
  const secondResult = boundary.delivery.result("run-second");
  assert.equal(secondResult?.subagentId, subagentId);
  assert.equal(secondResult?.output, "private marker: heliotrope");
  assert.doesNotMatch(secondResult?.output ?? "", /marker stored/);
  assert.match(boundary.pushed[0].text, /7 in \/ 1 out · 1 turn/);
  assert.doesNotMatch(boundary.pushed[1].text, /7 in|1 out/);
  assert.match(boundary.pushed[1].text, /1 turn/);

  const afterCompletedResume = await boundary.tools.agent_resume.execute(
    "resume-after-completed-resume",
    {
      id: subagentId,
      description: "third goal",
      prompt: "continue after completion",
    },
  );
  assert.match(afterCompletedResume.content[0].text, /run id run-third/);
  assert.equal(boundary.active.length, 3);
});

test("registered agent_resume renders actionable collapsed and complete expanded success", async () => {
  const boundary = runtimeBoundary(["run-first", "run-second"], {
    resumable: true,
  });
  const started = await boundary.startIdentities();
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();

  const resumed = await boundary.tools.agent_resume.execute("resume", {
    id: started.subagentId,
    description: "continue",
    prompt: "do the next thing",
  });
  const renderResult = boundary.tools.agent_resume.renderResult;
  assert.ok(renderResult);

  const render = (expanded: boolean) =>
    renderResult(
      resumed,
      { expanded, isPartial: false },
      {
        fg: (_tone, text) => text,
        bg: (_tone, text) => text,
        bold: (text) => text,
      },
      {},
    )
      .render(160)
      .map((line) => stripVTControlCharacters(line).trimEnd())
      .join("\n");

  const collapsed = render(false);
  assert.match(
    collapsed,
    new RegExp(
      `^Resumed subagent ${started.subagentId} · run run-second \\(.*to expand\\)$`,
    ),
  );
  assert.doesNotMatch(collapsed, /:$/);

  const expanded = render(true);
  assert.match(expanded, new RegExp(`subagent ${started.subagentId}`));
  assert.match(expanded, /run id run-second/);
  assert.match(
    expanded,
    /agent_wait, agent_result, agent_cancel, and agent_steer/,
  );
  assert.match(expanded, /notification\s+will arrive when this Run finishes/);
});

test("public tools retain one ephemeral Codex session across independent Results", async () => {
  interface CodexFixtureChild extends EventEmitter {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    signals: string[];
    kill(signal: string): boolean;
    finish(code: number | null): void;
  }

  const providerThreadId = "provider-thread-secret";
  const providerTurnIds = ["provider-turn-first", "provider-turn-second"];
  const providerRequests: Record<string, unknown>[] = [];
  const children: CodexFixtureChild[] = [];
  const order: string[] = [];
  let retainedMarker: string | undefined;
  let turnNumber = 0;
  const sendProvider = (child: CodexFixtureChild, value: unknown): void => {
    child.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const spawn: ChildProcessSpawn = (_command, args, options) => {
    assert.equal(children.length, 0, "one Subagent owns one App Server");
    assert.deepEqual(args, ["app-server"]);
    assert.equal(options.cwd, "/fixed/project");
    assert.equal(options.env?.PI_SUBAGENT_DEPTH, "1");
    assert.equal(options.env?.PATH, process.env.PATH);

    const child = new EventEmitter() as CodexFixtureChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.signals = [];
    let finished = false;
    child.finish = (code) => {
      if (finished) return;
      finished = true;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", code, null));
    };
    child.kill = (signal) => {
      child.signals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.finish(0));
      return true;
    };
    child.stdin.setEncoding("utf8");
    child.stdin.on("finish", () => child.finish(0));
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        providerRequests.push(request);
        order.push(`1:${String(request.method)}`);
        if (request.method === "initialize") {
          sendProvider(child, {
            id: request.id,
            result: {
              userAgent: "fixture",
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "test",
            },
          });
        } else if (request.method === "thread/start") {
          sendProvider(child, {
            id: request.id,
            result: { thread: { id: providerThreadId, turns: [] } },
          });
        } else if (request.method === "turn/start") {
          turnNumber++;
          const turnId = providerTurnIds[turnNumber - 1];
          assert.ok(turnId, "unexpected extra Codex Turn");
          const params = request.params as Record<string, unknown>;
          const input = params.input as Array<Record<string, unknown>>;
          const prompt = input[0]?.text;
          assert.equal(typeof prompt, "string");
          if (turnNumber === 1) {
            retainedMarker = String(prompt).match(/remember (\w+)/)?.[1];
          } else {
            assert.equal(prompt, "recall the marker");
          }
          sendProvider(child, {
            id: request.id,
            result: { turn: { id: turnId, status: "inProgress" } },
          });
          const answer =
            turnNumber === 1
              ? "first public answer"
              : `retained marker: ${retainedMarker ?? "missing"}`;
          sendProvider(child, {
            method: "item/completed",
            params: {
              threadId: providerThreadId,
              turnId,
              item: {
                type: "agentMessage",
                id: `provider-item-${turnNumber}`,
                text: answer,
                phase: "final_answer",
              },
              completedAtMs: 1,
            },
          });
          sendProvider(child, {
            method: "turn/completed",
            params: {
              threadId: providerThreadId,
              turn: {
                id: turnId,
                items: [],
                status: "completed",
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
    children.push(child);
    order.push("spawn-1");
    return child as unknown as ChildProcess;
  };

  const { pi, tools } = collectTools();
  const events: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
  const eventPi = {
    ...pi,
    on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) {
      events[event] = handler;
    },
  } as unknown as ExtensionAPI;
  const agentsDir = mkdtempSync(path.join(tmpdir(), "codex-public-tools-"));
  writeAgent(agentsDir, "codex-worker", undefined, "codex");
  const runIds = ["run-codex-first", "run-codex-second"];
  const runs = createSubagentRuns({ now: () => 0 }, () => {
    const id = runIds.shift();
    assert.ok(id);
    return id;
  });
  const pushed: PushedNotification[] = [];
  const delivery = createSubagentDelivery({
    runs,
    push: (notification) => pushed.push(notification),
  });
  const harnesses = createHarnessRegistry([
    createCodexHarness({ spawn, killEscalationMs: 20 }),
  ]);
  const subagents = createSubagentManager({
    harnesses,
    runs,
    generateSubagentId: () => "subagent-codex",
  });
  createSubagentRuntime({
    agentsDir,
    runs,
    delivery,
    harnesses,
    subagents,
  }).attach(eventPi);
  events.session_start?.(
    {},
    {
      cwd: "/fixed/project",
      modelRegistry: { getAll: () => [] },
      ui: { notify() {}, setWidget() {} },
    },
  );

  const start = await tools.agent_start.execute(
    "start-codex",
    {
      agent: "codex-worker",
      description: "establish context",
      prompt: "remember violet",
    },
    undefined,
    undefined,
    {},
  );
  assert.match(start.content[0].text, /subagent id subagent-codex/);
  assert.match(start.content[0].text, /run id run-codex-first/);
  const firstWait = await tools.agent_wait.execute("wait-first", {
    ids: ["run-codex-first"],
  });
  assert.match(firstWait.content[0].text, /completed/);
  const first = await tools.agent_result.execute("result-first", {
    id: "run-codex-first",
  });
  assert.match(first.content[0].text, /first public answer/);
  const firstStored = structuredClone(delivery.result("run-codex-first"));

  const resume = await tools.agent_resume.execute("resume-codex", {
    id: "subagent-codex",
    description: "recall context",
    prompt: "recall the marker",
  });
  assert.match(resume.content[0].text, /run id run-codex-second/);
  const secondWait = await tools.agent_wait.execute("wait-second", {
    ids: ["run-codex-second"],
  });
  assert.match(secondWait.content[0].text, /completed/);
  const second = await tools.agent_result.execute("result-second", {
    id: "run-codex-second",
  });
  assert.match(second.content[0].text, /retained marker: violet/);
  assert.doesNotMatch(second.content[0].text, /first public answer/);
  assert.deepEqual(delivery.result("run-codex-first"), firstStored);
  assert.deepEqual(
    pushed.map(({ id, subagentId, status }) => ({ id, subagentId, status })),
    [
      {
        id: "run-codex-first",
        subagentId: "subagent-codex",
        status: "completed",
      },
      {
        id: "run-codex-second",
        subagentId: "subagent-codex",
        status: "completed",
      },
    ],
  );
  assert.deepEqual(order, [
    "spawn-1",
    "1:initialize",
    "1:initialized",
    "1:thread/start",
    "1:turn/start",
    "1:turn/start",
  ]);
  assert.deepEqual(providerRequests[2]?.params, {
    cwd: "/fixed/project",
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  const publicState = JSON.stringify({ first, second, pushed });
  assert.doesNotMatch(
    publicState,
    /provider-thread-secret|provider-turn|provider-item|attached-provider/,
  );
  assert.equal(children.length, 1);
  assert.equal(children[0]?.stdin.writableEnded, false);
  assert.equal(children[0]?.listenerCount("close"), 1);
  assert.equal(children[0]?.stdout.listenerCount("data"), 1);

  children[0]?.emit(
    "error",
    new Error(
      "idle loss provider-thread-secret provider-turn-second provider-item-2",
    ),
  );
  const requestsBeforeLossObservation = structuredClone(providerRequests);
  const notificationsBeforeLossObservation = structuredClone(pushed);
  const firstBeforeLossObservation = structuredClone(
    delivery.result("run-codex-first"),
  );
  const secondBeforeLossObservation = structuredClone(
    delivery.result("run-codex-second"),
  );
  const afterLoss = await tools.agent_resume.execute("resume-lost", {
    id: "subagent-codex",
    description: "must not replace context",
    prompt: "must not start",
  });
  assert.match(afterLoss.content[0].text, /Conversation was lost/);
  assert.match(afterLoss.content[0].text, /Start a new Subagent/);
  assert.match(
    afterLoss.content[0].text,
    /No Run or provider work was started/,
  );
  assert.doesNotMatch(
    afterLoss.content[0].text,
    /provider-thread-secret|provider-turn|provider-item|thread|Turn|item|request|session|process|correlation/,
  );
  assert.equal(children.length, 1);
  assert.deepEqual(providerRequests, requestsBeforeLossObservation);
  assert.deepEqual(pushed, notificationsBeforeLossObservation);
  assert.deepEqual(
    delivery.result("run-codex-first"),
    firstBeforeLossObservation,
  );
  assert.deepEqual(
    delivery.result("run-codex-second"),
    secondBeforeLossObservation,
  );

  await events.session_shutdown?.({ reason: "new" });
  for (const child of children) {
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stdin.listenerCount("error"), 0);
  }
  assert.equal(delivery.result("run-codex-first"), undefined);
  assert.equal(delivery.result("run-codex-second"), undefined);
  const afterShutdown = await tools.agent_resume.execute("resume-closed", {
    id: "subagent-codex",
    description: "closed",
    prompt: "must not attach",
  });
  assert.match(afterShutdown.content[0].text, /unknown Subagent/);
  assert.equal(children.length, 1);
});

test("agent_resume has one synchronous winner and never queues behind settlement", async () => {
  const boundary = runtimeBoundary(["run-first", "run-winner"], {
    resumable: true,
  });
  const started = await boundary.startIdentities();

  const active = await boundary.tools.agent_resume.execute("active", {
    id: started.subagentId,
    description: "too early",
    prompt: "must not queue",
  });
  assert.match(active.content[0].text, /already has an active Run/);
  assert.match(active.content[0].text, /not queued/);
  assert.equal(boundary.active.length, 1);

  boundary.active[0].resolve({ ending: "answered" });
  const settling = await boundary.tools.agent_resume.execute("settling", {
    id: started.subagentId,
    description: "still too early",
    prompt: "must not queue",
  });
  assert.match(settling.content[0].text, /already has an active Run/);
  assert.equal(boundary.active.length, 1);

  await boundary.flush();
  const winnerPromise = boundary.tools.agent_resume.execute("winner", {
    id: started.subagentId,
    description: "winner",
    prompt: "start now",
  });
  const loserPromise = boundary.tools.agent_resume.execute("loser", {
    id: started.subagentId,
    description: "loser",
    prompt: "must not queue",
  });
  const [winner, loser] = await Promise.all([winnerPromise, loserPromise]);

  assert.match(winner.content[0].text, /run id run-winner/);
  assert.match(loser.content[0].text, /already has an active Run/);
  assert.equal(boundary.active.length, 2, "only the winning Run was prepared");
  assert.deepEqual(boundary.active[1].task, {
    description: "winner",
    prompt: "start now",
  });
});

test("a dispatch failure releases atomic Resume admission without preparing twice", async () => {
  let runSequence = 0;
  let failDispatch = true;
  let initialPreparations = 0;
  let resumeAdmissions = 0;
  const prepared = {
    supportedControls: [] as const,
    execute: async () => ({ ending: "answered" as const }),
  };
  const harness: Harness = {
    name: "atomic",
    validate: () => [],
    prepare: () => ({
      model: undefined,
      prepareRun: () => {
        initialPreparations++;
        return prepared;
      },
      admitResume: () => {
        resumeAdmissions++;
        return { outcome: "admitted", run: prepared };
      },
      close: async () => {},
    }),
  };
  const runs = createSubagentRuns({ now: () => 0 }, () => {
    runSequence++;
    if (runSequence === 2 && failDispatch) throw new Error("dispatch failed");
    return `run-${runSequence}`;
  });
  const manager = createSubagentManager({
    harnesses: createHarnessRegistry([harness]),
    runs,
    generateSubagentId: () => "subagent-atomic",
    now: () => 0,
  });
  const first = manager.start({
    config: {
      name: "atomic-worker",
      description: "atomic worker",
      harness: "atomic",
      fields: {},
      systemPrompt: "work",
    },
    description: "first",
    prompt: "first",
  });
  await first.settled;

  assert.throws(
    () =>
      manager.resume({
        subagentId: first.subagentId,
        description: "failed dispatch",
        prompt: "failed dispatch",
      }),
    /dispatch failed/,
  );
  failDispatch = false;
  const resumed = manager.resume({
    subagentId: first.subagentId,
    description: "retry",
    prompt: "retry",
  });
  assert.equal(resumed.outcome, "started");
  if (resumed.outcome !== "started") assert.fail("resume stayed blocked");
  await resumed.settled;
  assert.equal(initialPreparations, 1, "dispatch did not repeat preparation");
  assert.equal(resumeAdmissions, 2, "each caller received one admission");
  await manager.shutdown();
});

test("agent_resume distinguishes unsupported and unknown Subagent identities", async () => {
  const unsupported = runtimeBoundary(["run-pi"]);
  const pi = await unsupported.startIdentities();
  unsupported.active[0].resolve({ ending: "answered" });
  await unsupported.flush();

  const unsupportedResult = await unsupported.tools.agent_resume.execute(
    "unsupported",
    {
      id: pi.subagentId,
      description: "next",
      prompt: "continue",
    },
  );
  assert.match(unsupportedResult.content[0].text, /does not support resume/);
  assert.match(unsupportedResult.content[0].text, /No Run or provider work/);
  assert.equal(unsupported.active.length, 1);

  const resumable = runtimeBoundary(["run-controlled"], { resumable: true });
  const controlled = await resumable.startIdentities();
  for (const id of ["subagent-missing", controlled.runId]) {
    const result = await resumable.tools.agent_resume.execute("unknown", {
      id,
      description: "next",
      prompt: "continue",
    });
    assert.match(result.content[0].text, /unknown Subagent/);
    assert.match(result.content[0].text, /not a Run id/);
  }
  assert.equal(resumable.active.length, 1);

  await resumable.events.session_shutdown({ reason: "new" });
  resumable.beginSession();
  const stale = await resumable.tools.agent_resume.execute("stale", {
    id: controlled.subagentId,
    description: "next Session",
    prompt: "must not continue",
  });
  assert.match(stale.content[0].text, /unknown Subagent/);
  assert.equal(resumable.active.length, 1);
});

test("cancel settlement, pending Controls, and notification landing stay Run-scoped across resume", async () => {
  const boundary = runtimeBoundary(["run-first", "run-second", "run-third"], {
    resumable: true,
    steerable: true,
  });
  const started = await boundary.startIdentities();

  const staleControl = await boundary.tools.agent_steer.execute("steer-old", {
    id: started.runId,
    message: "discard me",
  });
  assert.match(staleControl.content[0].text, /Steering accepted/);
  await boundary.tools.agent_cancel.execute("cancel-old", {
    ids: [started.runId],
  });
  assert.equal(boundary.active[0].signal?.aborted, true);

  const beforeCancelSettles = await boundary.tools.agent_resume.execute(
    "resume-early",
    {
      id: started.subagentId,
      description: "too early",
      prompt: "must not queue",
    },
  );
  assert.match(beforeCancelSettles.content[0].text, /active Run/);

  boundary.active[0].resolve({ ending: "cancelled" });
  await boundary.flush();
  const resumed = await boundary.tools.agent_resume.execute("resume-second", {
    id: started.subagentId,
    description: "fresh run",
    prompt: "fresh prompt",
  });
  assert.match(resumed.content[0].text, /run id run-second/);
  boundary.active[0].controls.subscribe(
    () => assert.fail("the cancelled Run retained pending guidance"),
    () => {},
  );

  let resumedControl: ControlAdmission | undefined;
  boundary.active[1].controls.subscribe((admission) => {
    resumedControl = admission;
  });
  await boundary.tools.agent_steer.execute("steer-new", {
    id: "run-second",
    message: "fresh guidance",
  });
  assert.deepEqual(resumedControl?.control, {
    type: "steer",
    text: "fresh guidance",
  });
  resumedControl?.acknowledge();

  assert.equal(boundary.pushed.length, 1);
  assert.deepEqual(
    boundary.runs.list().map(({ id, status }) => ({ id, status })),
    [
      { id: "run-first", status: "cancelled" },
      { id: "run-second", status: "running" },
    ],
    "resume before notification landing neither releases nor merges the old Run",
  );
  boundary.events.message_start({
    message: {
      role: "custom",
      customType: "subagent-notification",
      details: {
        id: "run-first",
        subagentId: started.subagentId,
        agent: "worker",
        status: "cancelled",
      },
    },
  });
  assert.deepEqual(
    boundary.runs.list().map(({ id }) => id),
    ["run-second"],
  );

  await boundary.tools.agent_cancel.execute("cancel-second", {
    ids: ["run-second"],
  });
  boundary.active[1].resolve({ ending: "cancelled" });
  await boundary.flush();
  const afterCancellation = await boundary.tools.agent_resume.execute(
    "resume-third",
    {
      id: started.subagentId,
      description: "after cancellation",
      prompt: "new goal",
    },
  );
  assert.match(afterCancellation.content[0].text, /run id run-third/);
  assert.equal(boundary.active.length, 3);
});

test("a failed resumed Run returns its open Subagent to idle", async () => {
  const boundary = runtimeBoundary(["run-first", "run-failed", "run-after"], {
    resumable: true,
  });
  const started = await boundary.startIdentities();
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  await boundary.tools.agent_resume.execute("resume-failed", {
    id: started.subagentId,
    description: "failure",
    prompt: "fail",
  });
  boundary.active[1].resolve({
    ending: "failed",
    errorMessage: "controlled failure",
  });
  await boundary.flush();

  const afterFailure = await boundary.tools.agent_resume.execute(
    "resume-after-failure",
    {
      id: started.subagentId,
      description: "recovery",
      prompt: "continue honestly",
    },
  );
  assert.match(afterFailure.content[0].text, /run id run-after/);
  assert.equal(boundary.active.length, 3);
});

test("shutdown wins resume admission synchronously and late settlement cannot reopen the Subagent", async () => {
  const idleBoundary = runtimeBoundary(["run-idle"], { resumable: true });
  const idle = await idleBoundary.startIdentities();
  idleBoundary.active[0].resolve({ ending: "answered" });
  await idleBoundary.flush();

  const shutdown = idleBoundary.events.session_shutdown({ reason: "new" });
  const afterShutdownStarted = await idleBoundary.tools.agent_resume.execute(
    "resume-after-shutdown",
    {
      id: idle.subagentId,
      description: "closed",
      prompt: "must not start",
    },
  );
  assert.match(afterShutdownStarted.content[0].text, /unknown Subagent/);
  assert.equal(idleBoundary.active.length, 1);
  await shutdown;

  const activeBoundary = runtimeBoundary(["run-first", "run-resumed"], {
    resumable: true,
  });
  const active = await activeBoundary.startIdentities();
  activeBoundary.active[0].resolve({ ending: "answered" });
  await activeBoundary.flush();
  await activeBoundary.tools.agent_resume.execute("resume-wins", {
    id: active.subagentId,
    description: "active at shutdown",
    prompt: "work",
  });
  assert.equal(activeBoundary.active[1].signal?.aborted, false);

  await activeBoundary.events.session_shutdown({ reason: "new" });
  assert.equal(activeBoundary.active[1].signal?.aborted, true);
  activeBoundary.active[1].resolve({ ending: "cancelled" });
  await activeBoundary.flush();
  const afterLateSettlement = await activeBoundary.tools.agent_resume.execute(
    "late-settlement",
    {
      id: active.subagentId,
      description: "must stay closed",
      prompt: "must not start",
    },
  );
  assert.match(afterLateSettlement.content[0].text, /unknown Subagent/);
  assert.equal(activeBoundary.active.length, 2);
});

test("resuming neither pins old Result output nor changes per-Run eviction order", async () => {
  const boundary = runtimeBoundary(["run-first", "run-second"], {
    resumable: true,
    resultBudget: 10,
  });
  const started = await boundary.startIdentities();
  boundary.active[0].report.message({
    role: "assistant",
    parts: [{ type: "text", text: "first" }],
  });
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  assert.equal(boundary.delivery.result("run-first")?.output, "first");
  await boundary.tools.agent_result.execute("read-first", { id: "run-first" });

  await boundary.tools.agent_resume.execute("resume", {
    id: started.subagentId,
    description: "second",
    prompt: "second",
  });
  assert.equal(
    boundary.delivery.result("run-first")?.output,
    "first",
    "admission itself does not consume or evict the old Result",
  );
  boundary.active[1].report.message({
    role: "assistant",
    parts: [{ type: "text", text: "second" }],
  });
  boundary.active[1].resolve({ ending: "answered" });
  await boundary.flush();

  assert.deepEqual(boundary.delivery.result("run-first"), {
    id: "run-first",
    subagentId: started.subagentId,
    agent: "worker",
    status: "completed",
    output: "",
    evicted: true,
  });
  assert.equal(boundary.delivery.result("run-second")?.output, "second");
});

test("first-Run settlement retains an idle Subagent and orients Result and notification", async () => {
  const boundary = runtimeBoundary([
    "run-completed",
    "run-failed",
    "run-cancelled",
  ]);
  const starts = await Promise.all([
    boundary.startIdentities(),
    boundary.startIdentities(),
    boundary.startIdentities(),
  ]);
  boundary.active[0].report.message({
    role: "assistant",
    parts: [{ type: "text", text: "answer" }],
  });
  boundary.active[0].resolve({ ending: "answered" });
  boundary.active[1].resolve({ ending: "failed", errorMessage: "broken" });
  boundary.active[2].resolve({ ending: "cancelled" });
  await boundary.flush();

  assert.deepEqual(boundary.adapterCloses, [0, 0, 0]);
  assert.equal(boundary.pushed.length, 3);
  for (const [index, started] of starts.entries()) {
    assert.equal(boundary.pushed[index].subagentId, started.subagentId);
    assert.equal(boundary.pushed[index].id, started.runId);
    assert.match(boundary.pushed[index].text, new RegExp(started.subagentId));
    assert.match(boundary.pushed[index].text, new RegExp(started.runId));
    assert.equal(
      boundary.delivery.result(started.runId)?.subagentId,
      started.subagentId,
    );
  }

  const presented = await boundary.tools.agent_result.execute("result", {
    id: starts[0].runId,
  });
  assert.match(presented.content[0].text, /subagent subagent-1/);
  assert.match(presented.content[0].text, /run run-completed/);
});

test("Run-scoped tools never redirect a Subagent id and landing retains its adapter", async () => {
  const boundary = runtimeBoundary(["run-1"]);
  const started = await boundary.startIdentities();

  const wait = await boundary.tools.agent_wait.execute("wait", {
    ids: [started.subagentId],
    timeout_seconds: 0,
  });
  const result = await boundary.tools.agent_result.execute("result", {
    id: started.subagentId,
  });
  const cancel = await boundary.tools.agent_cancel.execute("cancel", {
    ids: [started.subagentId],
  });
  const steer = await boundary.tools.agent_steer.execute("steer", {
    id: started.subagentId,
    message: "guidance",
  });

  assert.match(wait.content[0].text, /Unknown run ids: subagent-1/);
  assert.match(result.content[0].text, /No run with id subagent-1/);
  assert.match(cancel.content[0].text, /Unknown run ids: subagent-1/);
  assert.match(steer.content[0].text, /unknown run/);
  assert.equal(boundary.active[0].signal?.aborted, false);

  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  boundary.events.message_start({
    message: {
      role: "custom",
      customType: "subagent-notification",
      details: {
        id: started.runId,
        subagentId: started.subagentId,
        agent: "worker",
        status: "completed",
      },
    },
  });

  assert.equal(boundary.runs.list().length, 0);
  assert.deepEqual(boundary.adapterCloses, [0]);
});

test("Subagent ids and landed Run ids are never reused within a Session", async () => {
  const boundary = runtimeBoundary(["run-dup", "run-dup", "run-fresh"], {
    subagentIds: ["subagent-dup", "subagent-dup", "subagent-fresh"],
  });
  const first = await boundary.startIdentities();
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  boundary.events.message_start({
    message: {
      role: "custom",
      customType: "subagent-notification",
      details: {
        id: first.runId,
        subagentId: first.subagentId,
        agent: "worker",
        status: "completed",
      },
    },
  });

  const second = await boundary.startIdentities();
  assert.deepEqual(first, {
    subagentId: "subagent-dup",
    runId: "run-dup",
  });
  assert.deepEqual(second, {
    subagentId: "subagent-fresh",
    runId: "run-fresh",
  });
});

test("INV-1 boundary: landed run ids are never reused", async () => {
  const boundary = runtimeBoundary(["dup", "dup", "fresh"]);
  const first = await boundary.start();
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  boundary.events.message_start({
    message: {
      role: "custom",
      customType: "subagent-notification",
      details: {
        id: first,
        subagentId: "subagent-1",
        agent: "worker",
        status: "completed",
      },
    },
  });

  const second = await boundary.start();
  assert.equal(first, "dup");
  assert.equal(second, "fresh");
});

test("INV-3 boundary: completed and failed states are final", async () => {
  const boundary = runtimeBoundary(["completed", "failed"]);
  const completed = await boundary.start();
  const failed = await boundary.start();
  boundary.active[0].resolve({ ending: "answered" });
  boundary.active[1].resolve({ ending: "failed", errorMessage: "failed" });
  await boundary.flush();

  const before = await boundary.tools.agent_wait.execute("wait-1", {
    ids: [completed, failed],
  });
  await boundary.tools.agent_cancel.execute("cancel", {
    ids: [completed, failed],
  });
  const after = await boundary.tools.agent_wait.execute("wait-2", {
    ids: [completed, failed],
  });

  assert.match(before.content[0].text, /completed/);
  assert.match(before.content[0].text, /failed/);
  assert.equal(after.content[0].text, before.content[0].text);
});

test("INV-3/INV-6 boundary: cancellation is repeatable and terminal", async () => {
  const boundary = runtimeBoundary(["run-1"]);
  const id = await boundary.start();

  await boundary.tools.agent_cancel.execute("cancel-1", { ids: [id] });
  await boundary.tools.agent_cancel.execute("cancel-2", { ids: [id] });
  boundary.active[0].resolve({ ending: "cancelled" });
  await boundary.flush();

  const first = await boundary.tools.agent_wait.execute("wait-1", {
    ids: [id],
  });
  await boundary.tools.agent_cancel.execute("cancel-3", { ids: [id] });
  const second = await boundary.tools.agent_wait.execute("wait-2", {
    ids: [id],
  });
  assert.match(first.content[0].text, /cancelled/);
  assert.equal(second.content[0].text, first.content[0].text);
});

test("INV-8 boundary: session shutdown cancels and forgets a tool-started run", async () => {
  const boundary = runtimeBoundary(["run-1"]);
  const id = await boundary.start();

  boundary.events.session_shutdown({ reason: "new" });
  assert.equal(boundary.active[0].signal?.aborted, true);
  assert.equal(boundary.runs.list().length, 0);

  boundary.active[0].resolve({ ending: "cancelled" });
  await boundary.flush();
  assert.equal(boundary.pushed.length, 0);
  const result = await boundary.tools.agent_result.execute("result", { id });
  assert.match(result.content[0].text, /No run with id/);
});

test("shutdown closes idle and active Subagents before late settlement can notify", async () => {
  const boundary = runtimeBoundary(["run-idle", "run-active"]);
  const idle = await boundary.startIdentities();
  const active = await boundary.startIdentities();
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  assert.deepEqual(boundary.adapterCloses, [0, 0]);

  await boundary.events.session_shutdown({ reason: "new" });
  assert.equal(boundary.active[1].signal?.aborted, true);
  assert.deepEqual(boundary.adapterCloses, [1, 1]);
  assert.equal(boundary.runs.list().length, 0);
  assert.equal(boundary.delivery.result(idle.runId), undefined);

  boundary.active[1].resolve({ ending: "cancelled" });
  await boundary.flush();
  assert.deepEqual(boundary.adapterCloses, [1, 1]);
  assert.equal(boundary.pushed.length, 1, "only the pre-shutdown Run notified");
  assert.equal(boundary.delivery.result(active.runId), undefined);
});

test("Session cleanup forgets both local identity sets", async () => {
  const boundary = runtimeBoundary(["run-1", "run-1"], {
    subagentIds: ["subagent-1", "subagent-1"],
  });
  const first = await boundary.startIdentities();
  await boundary.events.session_shutdown({ reason: "new" });
  boundary.active[0].resolve({ ending: "cancelled" });
  await boundary.flush();

  boundary.beginSession();
  const second = await boundary.startIdentities();
  assert.deepEqual(second, first);
});

test("INV-9 boundary: lost notification retries once without changing result", async () => {
  const boundary = runtimeBoundary(["run-1"]);
  const id = await boundary.start();
  boundary.active[0].report.message({
    role: "assistant",
    parts: [{ type: "text", text: "  answer\n" }],
  });
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();

  assert.equal(boundary.pushed.length, 1);
  boundary.events.turn_end({ message: { stopReason: "aborted" } });
  boundary.events.agent_settled({});
  assert.equal(boundary.pushed.length, 2);
  assert.equal(boundary.pushed[1].text, boundary.pushed[0].text);

  const landed = {
    message: {
      role: "custom",
      customType: "subagent-notification",
      details: {
        id,
        subagentId: "subagent-1",
        agent: "worker",
        status: "completed",
      },
    },
  };
  boundary.events.message_start(landed);
  boundary.events.message_start(landed);
  boundary.events.agent_settled({});
  assert.equal(boundary.pushed.length, 2);

  const result = await boundary.tools.agent_result.execute("result", { id });
  assert.match(result.content[0].text, / {2}answer\n$/);
});

test("INV-9 boundary: a failed notification push preserves the exact result", async () => {
  const boundary = runtimeBoundary(["run-1"], { pushThrows: true });
  const id = await boundary.start();
  boundary.active[0].report.message({
    role: "assistant",
    parts: [{ type: "text", text: "  exact answer\n" }],
  });
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();

  const result = await boundary.tools.agent_result.execute("result", { id });
  assert.match(result.content[0].text, / {2}exact answer\n$/);
});

test("INV-10 boundary: widget and result presentation never determine state", async () => {
  const boundary = runtimeBoundary(["run-1"]);
  const id = await boundary.start();
  assert.match(boundary.renderWidget(), /running/);

  boundary.active[0].report.message({
    role: "assistant",
    parts: [{ type: "text", text: "answer" }],
  });
  boundary.active[0].resolve({ ending: "answered" });
  await boundary.flush();
  assert.match(boundary.renderWidget(), /completed/);

  await boundary.tools.agent_result.execute("result", { id });
  assert.equal(boundary.runs.list()[0].status, "completed");
  assert.match(boundary.renderWidget(), /completed/);
});

test("agent_start refuses an unknown agent", async () => {
  const { pi, tools } = collectTools();
  const runs = createSubagentRuns();

  registerSubagentFeatureTools(
    pi,
    { cwd: "/project", projectTrusted: true },
    new Map(),
    {
      subagents: fakeStart(() => {}),
      delivery: createSubagentDelivery({ runs, push: () => {} }),
    },
  );

  await assert.rejects(
    () =>
      tools.agent_start.execute(
        "call-1",
        { agent: "ghost", description: "task", prompt: "work" },
        undefined,
        undefined,
        {},
      ),
    /Unknown agent: "ghost"/,
  );
});

test("the orchestration primitives are registered", () => {
  const { pi, tools } = collectTools();
  const runs = createSubagentRuns();

  registerSubagentFeatureTools(
    pi,
    { cwd: "/project", projectTrusted: true },
    new Map(),
    {
      subagents: fakeStart(() => {}),
      delivery: createSubagentDelivery({ runs, push: () => {} }),
    },
  );

  assert.deepEqual(Object.keys(tools).sort(), [
    "agent_cancel",
    "agent_result",
    "agent_resume",
    "agent_start",
    "agent_steer",
    "agent_wait",
  ]);
  assert.equal(tools.agent_wait.label, "Wait for subagents");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, tool.promptSnippet]),
    ),
    {
      agent_cancel: "Stop subagents whose work is no longer needed",
      agent_result: "Fetch a finished subagent's full output by run id",
      agent_resume:
        "Resume an idle stable subagent and return its new run id immediately",
      agent_start:
        "Create a stable subagent and return its identity and first run id immediately",
      agent_steer: "Send one guidance message to an active subagent run",
      agent_wait:
        "Block until named runs finish and return lifecycle state only, never output",
    },
  );
  assert.doesNotMatch(tools.agent_wait.description ?? "", /agent_await/);
  assert.match(
    tools.agent_resume.description ?? "",
    /Subagent id returned by agent_start, not a Run id/,
  );
  assert.match(
    tools.agent_resume.description ?? "",
    /Returns the new Run id immediately, not the answer/,
  );
  assert.match(
    (tools.agent_resume.promptGuidelines ?? []).join("\n"),
    /agent_resume takes the stable Subagent id.*agent_wait.*take Run ids/,
  );
  assert.match(
    tools.agent_cancel.description ?? "",
    /never pass a stable Subagent id/,
  );
  assert.match(
    (tools.agent_wait.promptGuidelines ?? []).join("\n"),
    /agent_wait/,
  );
  assert.doesNotMatch(
    (tools.agent_wait.promptGuidelines ?? []).join("\n"),
    /agent_await/,
  );
  assert.equal(tools.agent_await, undefined);
});

test("agent_steer reports local admission and crosses the public tool seam exactly", async () => {
  const { pi, tools } = collectTools();
  const runs = createSubagentRuns();
  const gate = createControlGate(["steer"]);
  const result = createEmptyResult("explore", "task", 0);
  const handle = runs.track(result, () => {}, gate);
  const delivery = createSubagentDelivery({ runs, push: () => {} });
  delivery.register(
    handle.id,
    result.agent,
    new Promise(() => {}),
    result.subagentId,
  );
  registerSubagentFeatureTools(
    pi,
    { cwd: "/project", projectTrusted: true },
    new Map(),
    {
      subagents: fakeStart(() => {}),
      delivery,
    },
  );
  let admission: ControlAdmission | undefined;
  gate.controls.subscribe((next) => {
    admission = next;
  });
  const message = "  correct the scope exactly  ";

  const response = await tools.agent_steer.execute("steer", {
    id: handle.id,
    message,
  });

  assert.match(response.content[0].text, /synchronously admitted/);
  assert.match(response.content[0].text, /does not mean the Harness dequeued/);
  assert.match(response.content[0].text, /Do not resend/);
  assert.deepEqual(admission?.control, { type: "steer", text: message });
  admission?.acknowledge();
  assert.match(tools.agent_steer.description ?? "", /local bounded mailbox/);
  assert.match(tools.agent_steer.description ?? "", /Do not retry repeatedly/);
});

// ── Session-start discovery ──────────────────────────────────────────────────

interface SessionStartRun {
  notifications: string[];
  agentNames: string[];
  /** Widget keys the extension set during the session, in order. */
  widgetKeys: string[];
  runAgentsCommand(): Promise<{
    notifications: string[];
    customOpened: boolean;
  }>;
}

/**
 * Drive a fresh composed runtime against a temporary checkout and agent
 * directory, so discovery, trust forwarding, and command registration are
 * exercised through the session-start boundary.
 */
async function startSession(options: {
  cwd: string;
  agentDir: string;
  /** Omitted models a host that cannot report trust at all. */
  piProjectTrusted?: boolean;
  beforeAgentsCommand?: () => void;
  sessionReason?: "startup" | "resume";
  models?: Array<{ provider: string; id: string }>;
}): Promise<SessionStartRun> {
  let sessionStart:
    | ((event: unknown, ctx: unknown) => Promise<void>)
    | undefined;
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let toolGuidelines: string[] = [];
  const notifications: string[] = [];
  const widgetKeys: string[] = [];

  const runtime = createSubagentRuntime({
    agentsDir: path.join(options.agentDir, "agents"),
  });
  runtime.attach({
    on(
      event: string,
      handler: (event: unknown, ctx: unknown) => Promise<void>,
    ) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(_name: string, commandOptions: unknown) {
      command = commandOptions as Parameters<
        ExtensionAPI["registerCommand"]
      >[1];
    },
    registerTool(tool: { name: string; promptGuidelines?: string[] }) {
      if (tool.name === "agent_start") {
        toolGuidelines = tool.promptGuidelines ?? [];
      }
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI);

  assert.ok(sessionStart);
  await sessionStart(
    { reason: options.sessionReason ?? "startup" },
    {
      cwd: options.cwd,
      modelRegistry: {
        getAll: () => options.models ?? [],
      },
      ...(options.piProjectTrusted === undefined
        ? {}
        : { isProjectTrusted: () => options.piProjectTrusted }),
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setWidget(key: string) {
          widgetKeys.push(key);
        },
      },
    },
  );

  return {
    notifications,
    widgetKeys,
    agentNames: toolGuidelines.flatMap(
      (line) => line.match(/^agent_start ([\w-]+)[.:]/)?.slice(1, 2) ?? [],
    ),
    async runAgentsCommand() {
      options.beforeAgentsCommand?.();
      assert.ok(command);
      const commandNotifications: string[] = [];
      let customOpened = false;
      await command.handler("", {
        ui: {
          notify(message: string) {
            commandNotifications.push(message);
          },
          custom: async () => {
            customOpened = true;
          },
        },
      } as unknown as Parameters<typeof command.handler>[1]);
      return { notifications: commandNotifications, customOpened };
    },
  };
}

function makeCheckout(): { cwd: string; agentDir: string } {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "subagent-index-")),
  );
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

function writeAgent(
  dir: string,
  name: string,
  model?: string,
  harness?: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\ndescription: ${name} agent\n${harness ? `harness: ${harness}\n` : ""}${model ? `model: ${model}\n` : ""}---\n\nWork.\n`,
    "utf-8",
  );
}

function writeUserAgent(
  agentDir: string,
  name: string,
  model?: string,
  harness?: string,
): void {
  writeAgent(path.join(agentDir, "agents"), name, model, harness);
}

function writeProjectAgent(cwd: string, name: string): void {
  writeAgent(path.join(cwd, ".pi", "agents"), name);
}

test("agents come from the user directory", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeUserAgent(agentDir, "helper");

  const session = await startSession({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.deepEqual(session.agentNames, ["helper"]);
  assert.deepEqual(session.notifications, []);
});

test("a project directory cannot contribute an agent, trusted or not", async () => {
  // A profile carries a system prompt, a model, and a tool list, and its
  // description is injected into the calling model's tool guidelines. Reading
  // one from a working directory would let a checkout shape what the delegating
  // session does and says, so no trust state enables it.
  for (const piProjectTrusted of [true, false, undefined]) {
    const { cwd, agentDir } = makeCheckout();
    writeProjectAgent(cwd, "proj");
    writeUserAgent(agentDir, "helper");

    const session = await startSession({
      cwd,
      agentDir,
      ...(piProjectTrusted === undefined ? {} : { piProjectTrusted }),
    });

    assert.deepEqual(
      session.agentNames,
      ["helper"],
      `trusted=${piProjectTrusted}`,
    );
  }
});

test("model diagnostics run when a session is resumed", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeUserAgent(agentDir, "known", "anthropic/claude-known");
  writeUserAgent(agentDir, "missing", "anthropic/claude-missing");
  writeUserAgent(agentDir, "inherited");

  const session = await startSession({
    cwd,
    agentDir,
    sessionReason: "resume",
    models: [{ provider: "anthropic", id: "claude-known" }],
  });

  assert.deepEqual(session.agentNames, ["inherited", "known"]);
  assert.equal(session.notifications.length, 1);
  assert.match(session.notifications[0], /- missing: model/);
  assert.match(
    session.notifications[0],
    /model 'anthropic\/claude-missing' was not found/,
  );
});

test("Claude model diagnostics run at session start", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeUserAgent(agentDir, "alias", "sonnet", "claude");
  writeUserAgent(agentDir, "full", "claude-sonnet-4-6", "claude");
  writeUserAgent(agentDir, "typo", "sontet", "claude");

  const session = await startSession({ cwd, agentDir });

  // Only family aliases are valid; a full ID is diagnosed like a typo.
  assert.deepEqual(session.agentNames, ["alias"]);
  assert.equal(session.notifications.length, 1);
  assert.match(
    session.notifications[0],
    /- full: invalid Claude model 'claude-sonnet-4-6'/,
  );
  assert.match(
    session.notifications[0],
    /- typo: invalid Claude model 'sontet'/,
  );
});

test("an agents command with nothing to list says where to add a profile", async () => {
  const { cwd, agentDir } = makeCheckout();

  const session = await startSession({ cwd, agentDir });
  const agentsCommand = await session.runAgentsCommand();

  assert.equal(agentsCommand.customOpened, false);
  assert.equal(agentsCommand.notifications.length, 1);
  assert.match(
    agentsCommand.notifications[0],
    /No subagents are configured\. Add a profile to /,
  );
  assert.ok(
    agentsCommand.notifications[0].includes(path.join(agentDir, "agents")),
  );
});

function agentConfig(name: string): AgentConfig {
  return { name, description: `${name} agent`, systemPrompt: "Work." };
}

test("a delivered report reaches the model and lets it respond", async () => {
  const { pi, tools, sent } = collectTools();
  const started = fakeStart(() => {});

  const runs = createSubagentRuns();
  registerSubagentFeatureTools(
    pi,
    { cwd: "/project", projectTrusted: true },
    new Map([["worker", agentConfig("worker")]]),
    {
      subagents: { start: started.start, resume: started.resume },
      delivery: createSubagentDelivery({
        runs,
        push: (notification) =>
          pi.sendMessage(buildNotificationMessage(notification), {
            deliverAs: "followUp",
            triggerTurn: true,
          }),
      }),
    },
  );

  await tools.agent_start.execute(
    "call-1",
    { agent: "worker", description: "task", prompt: "work" },
    undefined,
    undefined,
    {},
  );
  started.settle();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "subagent-notification");
  // followUp so it never cuts into a turn in progress; triggerTurn so an idle
  // session still acts on it instead of leaving it unread.
  assert.equal(sent[0].options?.deliverAs, "followUp");
  assert.equal(sent[0].options?.triggerTurn, true);
});

// ── Process lifecycle ────────────────────────────────────────────────────────

type ShutdownHandler = (
  event: { reason: string },
  ctx: unknown,
) => void | Promise<void>;

function captureRuntime(): {
  runtime: ReturnType<typeof createSubagentRuntime>;
  shutdown: ShutdownHandler;
} {
  let shutdown: ShutdownHandler | undefined;
  const runtime = createSubagentRuntime({ agentsDir: "/agents" });
  runtime.attach({
    on(event: string, handler: ShutdownHandler) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI);
  assert.ok(shutdown);
  return { runtime, shutdown };
}

test("INV-8: session shutdown stops every running child and cleans up", async () => {
  const { runtime, shutdown } = captureRuntime();

  // A report belongs to the conversation that asked for it, so replacement
  // reasons cancel exactly like quit and reload do.
  for (const reason of ["resume", "new", "fork", "reload", "quit"] as const) {
    let stops = 0;
    const result = createEmptyResult("explore", "look", 0);
    const handle = runtime.runs.track(result, () => stops++);
    try {
      await shutdown({ reason }, {});
      assert.equal(stops, 1, `reason "${reason}" should stop the run`);
    } finally {
      runtime.runs.release(handle.id);
    }
  }
});

test("a settled run is not asked to stop again on quit", async () => {
  const { runtime, shutdown } = captureRuntime();

  let stops = 0;
  const result = createEmptyResult("explore", "look", 0);
  result.lifecycle = { phase: "completed", finishedAt: 10 };
  const handle = runtime.runs.track(result, () => stops++);
  try {
    await shutdown({ reason: "quit" }, {});
    assert.equal(stops, 0);
  } finally {
    runtime.runs.release(handle.id);
  }
});
