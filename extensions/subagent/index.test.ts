import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentBackend } from "./backend.ts";
import { createBackendRegistry, createEmptyResult } from "./backend.ts";
import subagentExtension, {
  findUnavailableHarnessWarnings,
  registerSubagentFeatures,
} from "./index.ts";
import type { ProjectConfigPolicy } from "./project-config-policy.ts";
import type { RunSubagentOptions } from "./runner.ts";
import type { AgentConfig, Harness } from "./types.ts";

function policyFor(allowProjectConfig: boolean): ProjectConfigPolicy {
  return {
    piProjectTrusted: allowProjectConfig,
    allowProjectConfig,
    reason: allowProjectConfig
      ? "trust-required-and-approved"
      : "vacuous-trust",
  };
}

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

test("subagent executions use the permission captured at session start", async () => {
  for (const sessionPermission of [true, false]) {
    let registeredTool: unknown;
    let executeTrustChecks = 0;
    let forwardedPermission: boolean | undefined;
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
      forwardedPermission = options.allowProjectConfig;
      const result = createEmptyResult("worker", "task", "pi", 0);
      result.status = "completed";
      result.exitCode = 0;
      return result;
    };

    registerSubagentFeatures(
      pi,
      "/project",
      "/agent-dir",
      new Map([["worker", agentConfig("worker")]]),
      policyFor(sessionPermission),
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
          return !sessionPermission;
        },
      },
    );

    assert.equal(forwardedPermission, sessionPermission);
    assert.equal(executeTrustChecks, 0);
  }
});

test("the agents command receives the permission captured at session start", async () => {
  for (const sessionPermission of [true, false]) {
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
      "/agent-dir",
      new Map(),
      policyFor(sessionPermission),
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

    assert.equal(customCalled, !sessionPermission);
    assert.deepEqual(
      notifications,
      sessionPermission ? ["No subagents are configured."] : [],
    );
  }
});

// ── Session-start project configuration policy ───────────────────────────────

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
 * directory, so the policy, discovery, and command registration are exercised
 * the way a session start does.
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

function writeProjectAgent(cwd: string, name: string): void {
  mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".pi", "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\n---\n\nWork.\n`,
    "utf-8",
  );
}

test("vacuous pi trust excludes project agents", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeProjectAgent(cwd, "proj");

  const session = await startSession({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.deepEqual(session.agentNames, []);
  assert.deepEqual(session.notifications, []);
});

test("a host that cannot report trust fails closed", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeProjectAgent(cwd, "proj");
  // Even a saved approval cannot substitute for a host that never said.
  writeFileSync(
    path.join(agentDir, "trust.json"),
    JSON.stringify({ [cwd]: true }),
    "utf-8",
  );

  const session = await startSession({ cwd, agentDir });

  assert.deepEqual(session.agentNames, []);
});

test("a saved approval makes .pi/agents usable on its own", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeProjectAgent(cwd, "proj");
  writeFileSync(
    path.join(agentDir, "trust.json"),
    JSON.stringify({ [cwd]: true }),
    "utf-8",
  );

  const session = await startSession({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.deepEqual(session.agentNames, ["proj"]);
});

test("an unreadable trust store warns once and denies project agents", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeProjectAgent(cwd, "proj");
  writeFileSync(path.join(agentDir, "trust.json"), "{ not json", "utf-8");

  const session = await startSession({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.deepEqual(session.agentNames, []);
  assert.equal(session.notifications.length, 1);
  assert.match(session.notifications[0], /trust store/i);
  assert.ok(!session.notifications[0].includes(agentDir));
});

test("configuration added after session start does not upgrade the permission", async () => {
  const { cwd, agentDir } = makeCheckout();
  writeProjectAgent(cwd, "proj");

  const session = await startSession({
    cwd,
    agentDir,
    piProjectTrusted: true,
    // A trust-requiring resource appears mid-session; a recheck would read it
    // as approval nobody gave.
    beforeAgentsCommand: () => {
      writeFileSync(path.join(cwd, ".pi", "settings.json"), "{}", "utf-8");
    },
  });

  const agentsCommand = await session.runAgentsCommand();

  // Permission is still denied, so /agents opens the explanatory empty state
  // rather than reporting that nothing is configured.
  assert.equal(agentsCommand.customOpened, true);
  assert.deepEqual(agentsCommand.notifications, []);
});

// ── Harness availability diagnostics ─────────────────────────────────────────

function backend(name: Harness, available: boolean): SubagentBackend {
  return {
    name,
    isAvailable: async () => available,
    run: async (ctx) => ctx.result,
  };
}

function agentConfig(name: string, harness?: Harness): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: "Work.",
    ...(harness ? { harness } : {}),
  };
}

test("findUnavailableHarnessWarnings stays quiet when every harness is available", async () => {
  const warnings = await findUnavailableHarnessWarnings(
    new Map([
      ["a", agentConfig("a")],
      ["b", agentConfig("b", "claude")],
    ]),
    createBackendRegistry([backend("pi", true), backend("claude", true)]),
  );

  assert.deepEqual(warnings, []);
});

test("findUnavailableHarnessWarnings names the agents blocked by a missing harness", async () => {
  const warnings = await findUnavailableHarnessWarnings(
    new Map([
      ["reviewer", agentConfig("reviewer", "claude")],
      ["implementer", agentConfig("implementer", "claude")],
      ["scout", agentConfig("scout")],
    ]),
    createBackendRegistry([backend("pi", true), backend("claude", false)]),
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Harness 'claude' is not available/);
  assert.match(warnings[0], /reviewer, implementer/);
  assert.ok(
    !warnings[0].includes("scout"),
    "an agent on an available harness must not be reported",
  );
  // The warning has to say how to fix it, not just that it is broken.
  assert.match(warnings[0], /@anthropic-ai\/claude-agent-sdk/);
});

test("findUnavailableHarnessWarnings reports a harness with no registered backend", async () => {
  const warnings = await findUnavailableHarnessWarnings(
    new Map([["worker", agentConfig("worker", "claude")]]),
    createBackendRegistry([backend("pi", true)]),
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Harness 'claude' is not available/);
});

test("findUnavailableHarnessWarnings tells Codex agents how to restore the CLI", async () => {
  const warnings = await findUnavailableHarnessWarnings(
    new Map([["worker", agentConfig("worker", "codex")]]),
    createBackendRegistry([backend("pi", true), backend("codex", false)]),
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Harness 'codex' is not available/);
  assert.match(warnings[0], /Install or update the Codex CLI/);
  assert.match(warnings[0], /on PATH/);
  assert.match(warnings[0], /app server/);
  assert.match(warnings[0], /multi_agent_v2/);
});
