import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PushedReport } from "./delivery.ts";
import subagentExtension, { registerSubagentFeatures } from "./index.ts";
import { createEmptyResult } from "./run.ts";
import type { RunSubagentOptions, StartedSubagent } from "./runner.ts";
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
    assert.deepEqual(parentEvents, ["session_start"]);
  } finally {
    if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = originalDepth;
  }
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
  push?: (report: PushedReport) => void;
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
          result.status = "completed";
          result.exitCode = 0;
          resolve(result);
        };
      }),
    };
  };
  return { start, settle: () => settle?.() };
}

test("agent_start uses the trust decision captured at session start", async () => {
  for (const sessionTrust of [true, false]) {
    let executeTrustChecks = 0;
    let forwardedTrust: boolean | undefined;
    const { pi, tools } = collectTools();
    const started = fakeStart((options) => {
      forwardedTrust = options.projectTrusted;
    });

    registerSubagentFeatures(
      pi,
      "/project",
      "/agent-dir",
      new Map([["worker", agentConfig("worker")]]),
      sessionTrust,
      { start: started.start },
    );

    await tools.agent_start.execute(
      "call-1",
      { agent: "worker", description: "task", prompt: "work" },
      new AbortController().signal,
      undefined,
      {
        isProjectTrusted() {
          executeTrustChecks++;
          return !sessionTrust;
        },
      },
    );
    started.settle();

    assert.equal(forwardedTrust, sessionTrust);
    assert.equal(executeTrustChecks, 0);
  }
});

test("agent_start returns a run id instead of the answer", async () => {
  const { pi, tools } = collectTools();
  const started = fakeStart(() => {});

  registerSubagentFeatures(
    pi,
    "/project",
    "/agent-dir",
    new Map([["worker", agentConfig("worker")]]),
    true,
    { start: started.start },
  );

  const result = await tools.agent_start.execute(
    "call-1",
    { agent: "worker", description: "task", prompt: "work" },
    undefined,
    undefined,
    {},
  );
  started.settle();

  assert.match(result.content[0].text, /Started worker as run run-1/);
  assert.doesNotMatch(result.content[0].text, /finished/);
});

test("agent_start refuses an unknown agent", async () => {
  const { pi, tools } = collectTools();

  registerSubagentFeatures(pi, "/project", "/agent-dir", new Map(), true, {
    start: fakeStart(() => {}).start,
  });

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

  registerSubagentFeatures(pi, "/project", "/agent-dir", new Map(), true, {
    start: fakeStart(() => {}).start,
  });

  assert.deepEqual(Object.keys(tools).sort(), [
    "agent_cancel",
    "agent_result",
    "agent_start",
    "agent_wait",
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
    "/project",
    "/agent-dir/agents",
    new Map(),
    true,
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
    "/project",
    "/agent-dir",
    new Map([["worker", agentConfig("worker")]]),
    true,
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
  assert.equal(sent[0].customType, "subagent-report");
  // followUp so it never cuts into a turn in progress; triggerTurn so an idle
  // session still acts on it instead of leaving it unread.
  assert.equal(sent[0].options?.deliverAs, "followUp");
  assert.equal(sent[0].options?.triggerTurn, true);
});
