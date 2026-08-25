import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentDelivery, type PushedNotification } from "./delivery.ts";
import subagentExtension, {
  registerDeliveryEventHandlers,
  registerShutdownEventHandler,
  registerSubagentFeatures,
} from "./index.ts";
import { createEmptyResult, type SubagentOutcome } from "./run.ts";
import {
  type RunSubagentOptions,
  type StartedSubagent,
  startSubagent,
} from "./runner.ts";
import { createSubagentRuns, subagentRuns } from "./runs.ts";
import type { AgentConfig } from "./types.ts";

// ── Extension registration ───────────────────────────────────────────────────

test("the extension is not exposed inside a subagent Pi process", () => {
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

    const parentEvents: string[] = [];
    delete process.env.PI_SUBAGENT_DEPTH;
    subagentExtension({
      on(event: string) {
        parentEvents.push(event);
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(parentEvents, [
      "session_start",
      "message_start",
      "turn_end",
      "agent_settled",
      "session_shutdown",
    ]);
  } finally {
    if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = originalDepth;
  }
});

test("interrupt bookkeeping survives turns of any shape", () => {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> =
    {};
  subagentExtension({
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers[event] = handler;
    },
    registerCommand() {},
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() {},
    getThinkingLevel: () => "off",
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
    promptGuidelines?: string[];
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: undefined,
      ctx?: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }> }>;
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
function fakeStart(onOptions: (options: RunSubagentOptions) => void) {
  let settle: (() => void) | undefined;
  const start = (options: RunSubagentOptions): StartedSubagent => {
    onOptions(options);
    const result = createEmptyResult(options.config.name, "task", 0);
    return {
      id: "run-1",
      settled: new Promise((resolve) => {
        settle = () => {
          result.lifecycle = {
            phase: "completed",
            finishedAt: 10,
            exitCode: 0,
          };
          resolve(result);
        };
      }),
    };
  };
  return { start, settle: () => settle?.() };
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

  registerSubagentFeatures(
    pi,
    session,
    "/agent-dir",
    new Map([["worker", agentConfig("worker")]]),
    { start: started.start },
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

test("INV-2 boundary: a successful start is executing, never queued", async () => {
  const boundary = runtimeBoundary(["run-1"]);
  const id = await boundary.start();

  assert.equal(id, "run-1");
  assert.equal(boundary.active.length, 1, "the stand-in executor is running");
  assert.equal(boundary.runs.list()[0].status, "running");
});

interface BoundaryRun {
  report: Parameters<NonNullable<RunSubagentOptions["execute"]>>[0]["report"];
  signal?: AbortSignal;
  resolve(outcome: SubagentOutcome): void;
}

function runtimeBoundary(
  ids: string[],
  { pushThrows = false }: { pushThrows?: boolean } = {},
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
    push: (notification) => {
      pushed.push(notification);
      if (pushThrows) throw new Error("push failed");
    },
  });
  const active: BoundaryRun[] = [];
  let widgetFactory:
    | ((
        tui: { requestRender(): void },
        theme: {
          fg(_tone: string, text: string): string;
          bold(text: string): string;
        },
      ) => { render(width: number): string[] })
    | undefined;
  const execute: NonNullable<RunSubagentOptions["execute"]> = (run) =>
    new Promise((resolve) =>
      active.push({ report: run.report, signal: run.signal, resolve }),
    );

  registerSubagentFeatures(
    pi,
    { cwd: "/project", projectTrusted: true },
    "/agent-dir",
    new Map([["worker", agentConfig("worker")]]),
    {
      runs,
      delivery,
      start: (options) => startSubagent({ ...options, execute, runs }),
      widgetHost: {
        setWidget(_key, content) {
          widgetFactory = content as typeof widgetFactory;
        },
      },
    },
  );

  const events: Record<string, (event: unknown) => void> = {};
  const eventPi = {
    on(event: string, handler: (event: unknown) => void) {
      events[event] = handler;
    },
  } as unknown as ExtensionAPI;
  registerDeliveryEventHandlers(eventPi, delivery);
  registerShutdownEventHandler(eventPi, delivery);

  const start = async (): Promise<string> => {
    const result = await tools.agent_start.execute(
      "call",
      { agent: "worker", description: "task", prompt: "work" },
      undefined,
      undefined,
      {},
    );
    const id = result.content[0].text.match(/run (\S+)/)?.[1];
    assert.ok(id);
    return id.replace(/\.$/, "");
  };
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
    events,
    delivery,
    start,
    flush,
    renderWidget,
  };
}

test("INV-1 boundary: landed run ids are never reused", async () => {
  const boundary = runtimeBoundary(["dup", "dup", "fresh"]);
  const first = await boundary.start();
  boundary.active[0].resolve({ exitCode: 0 });
  await boundary.flush();
  boundary.events.message_start({
    message: {
      role: "custom",
      customType: "subagent-notification",
      details: { id: first },
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
  boundary.active[0].resolve({ exitCode: 0 });
  boundary.active[1].resolve({ exitCode: 1, errorMessage: "failed" });
  await boundary.flush();

  const before = await boundary.tools.agent_await.execute("await-1", {
    ids: [completed, failed],
  });
  await boundary.tools.agent_cancel.execute("cancel", {
    ids: [completed, failed],
  });
  const after = await boundary.tools.agent_await.execute("await-2", {
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
  boundary.active[0].resolve({ stopReason: "aborted" });
  await boundary.flush();

  const first = await boundary.tools.agent_await.execute("await-1", {
    ids: [id],
  });
  await boundary.tools.agent_cancel.execute("cancel-3", { ids: [id] });
  const second = await boundary.tools.agent_await.execute("await-2", {
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

  boundary.active[0].resolve({ stopReason: "aborted" });
  await boundary.flush();
  assert.equal(boundary.pushed.length, 0);
  const result = await boundary.tools.agent_result.execute("result", { id });
  assert.match(result.content[0].text, /No run with id/);
});

test("INV-9 boundary: lost notification retries once without changing result", async () => {
  const boundary = runtimeBoundary(["run-1"]);
  const id = await boundary.start();
  boundary.active[0].report.message({
    role: "assistant",
    content: [{ type: "text", text: "  answer\n" }],
  } as never);
  boundary.active[0].resolve({ exitCode: 0 });
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
      details: { id },
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
    content: [{ type: "text", text: "  exact answer\n" }],
  } as never);
  boundary.active[0].resolve({ exitCode: 0 });
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
    content: [{ type: "text", text: "answer" }],
  } as never);
  boundary.active[0].resolve({ exitCode: 0 });
  await boundary.flush();
  assert.match(boundary.renderWidget(), /completed/);

  await boundary.tools.agent_result.execute("result", { id });
  assert.equal(boundary.runs.list()[0].status, "completed");
  assert.match(boundary.renderWidget(), /completed/);
});

test("agent_start refuses an unknown agent", async () => {
  const { pi, tools } = collectTools();

  registerSubagentFeatures(
    pi,
    { cwd: "/project", projectTrusted: true },
    "/agent-dir",
    new Map(),
    {
      start: fakeStart(() => {}).start,
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

  registerSubagentFeatures(
    pi,
    { cwd: "/project", projectTrusted: true },
    "/agent-dir",
    new Map(),
    {
      start: fakeStart(() => {}).start,
    },
  );

  assert.deepEqual(Object.keys(tools).sort(), [
    "agent_await",
    "agent_cancel",
    "agent_result",
    "agent_start",
  ]);
});

test("the agents command is told where agents live", async () => {
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let customCalled = false;
  const notifications: string[] = [];
  const pi = {
    registerCommand(_name: string, options: unknown) {
      command = options as Parameters<ExtensionAPI["registerCommand"]>[1];
    },
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;

  registerSubagentFeatures(
    pi,
    { cwd: "/project", projectTrusted: true },
    "/agent-dir/agents",
    new Map(),
  );

  assert.ok(command);
  await command.handler("", {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      custom: async () => {
        customCalled = true;
      },
    },
  } as unknown as Parameters<typeof command.handler>[1]);

  assert.equal(customCalled, false);
  assert.deepEqual(notifications, [
    "No subagents are configured. Add a profile to /agent-dir/agents.",
  ]);
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
 * Drive the real extension entry point against a temporary checkout and agent
 * directory, so discovery, trust forwarding, and command registration are
 * exercised the way a session start does.
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
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = options.agentDir;
  try {
    let sessionStart:
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    let toolGuidelines: string[] = [];
    const notifications: string[] = [];
    const widgetKeys: string[] = [];

    subagentExtension({
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
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
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

function writeAgent(dir: string, name: string, model?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\ndescription: ${name} agent\n${model ? `model: ${model}\n` : ""}---\n\nWork.\n`,
    "utf-8",
  );
}

function writeUserAgent(agentDir: string, name: string, model?: string): void {
  writeAgent(path.join(agentDir, "agents"), name, model);
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

  registerSubagentFeatures(
    pi,
    { cwd: "/project", projectTrusted: true },
    "/agent-dir",
    new Map([["worker", agentConfig("worker")]]),
    { start: started.start },
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

function captureShutdownHandler(): ShutdownHandler {
  let shutdown: ShutdownHandler | undefined;
  subagentExtension({
    on(event: string, handler: ShutdownHandler) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() {},
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI);
  assert.ok(shutdown);
  return shutdown;
}

test("INV-8: session shutdown stops every running child and cleans up", async () => {
  const shutdown = captureShutdownHandler();

  // A report belongs to the conversation that asked for it, so replacement
  // reasons cancel exactly like quit and reload do.
  for (const reason of ["resume", "new", "fork", "reload", "quit"] as const) {
    let stops = 0;
    const result = createEmptyResult("explore", "look", 0);
    const handle = subagentRuns.track(result, () => stops++);
    try {
      await shutdown({ reason }, {});
      assert.equal(stops, 1, `reason "${reason}" should stop the run`);
    } finally {
      subagentRuns.release(handle.id);
    }
  }
});

test("a settled run is not asked to stop again on quit", async () => {
  const shutdown = captureShutdownHandler();

  let stops = 0;
  const result = createEmptyResult("explore", "look", 0);
  result.lifecycle = { phase: "completed", finishedAt: 10, exitCode: 0 };
  const handle = subagentRuns.track(result, () => stops++);
  try {
    await shutdown({ reason: "quit" }, {});
    assert.equal(stops, 0);
  } finally {
    subagentRuns.release(handle.id);
  }
});
