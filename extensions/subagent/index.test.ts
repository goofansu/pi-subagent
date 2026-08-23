import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentExtension, { registerSubagentFeatures } from "./index.ts";
import { createEmptyResult } from "./run.ts";
import type { RunSubagentOptions } from "./runner.ts";
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

test("subagent executions use the trust decision captured at session start", async () => {
  for (const sessionTrust of [true, false]) {
    let registeredTool: unknown;
    let executeTrustChecks = 0;
    let forwardedTrust: boolean | undefined;
    const pi = {
      registerCommand() {},
      registerTool(tool: unknown) {
        registeredTool = tool;
      },
      getThinkingLevel() {
        return "off";
      },
    } as unknown as ExtensionAPI;
    const runner = async (options: RunSubagentOptions) => {
      forwardedTrust = options.projectTrusted;
      const result = createEmptyResult("worker", "task", 0);
      result.status = "completed";
      result.exitCode = 0;
      return result;
    };

    registerSubagentFeatures(
      pi,
      "/project",
      "/agent-dir",
      new Map([["worker", agentConfig("worker")]]),
      sessionTrust,
      runner,
    );

    const tool = registeredTool as {
      execute(
        toolCallId: string,
        params: { agent: string; description: string; prompt: string },
        signal: AbortSignal,
        onUpdate: undefined,
        ctx: unknown,
      ): Promise<unknown>;
    };
    await tool.execute(
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

    assert.equal(forwardedTrust, sessionTrust);
    assert.equal(executeTrustChecks, 0);
  }
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
      registerTool(tool: { promptGuidelines?: string[] }) {
        toolGuidelines = tool.promptGuidelines ?? [];
      },
      getThinkingLevel: () => "off",
    } as unknown as ExtensionAPI);

    assert.ok(sessionStart);
    await sessionStart(
      {},
      {
        cwd: options.cwd,
        ...(options.piProjectTrusted === undefined
          ? {}
          : { isProjectTrusted: () => options.piProjectTrusted }),
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      },
    );

    return {
      notifications,
      agentNames: toolGuidelines.flatMap(
        (line) => line.match(/^subagent ([\w-]+)[.:]/)?.slice(1, 2) ?? [],
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

function writeAgent(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\ndescription: ${name} agent\n---\n\nWork.\n`,
    "utf-8",
  );
}

function writeUserAgent(agentDir: string, name: string): void {
  writeAgent(path.join(agentDir, "agents"), name);
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
