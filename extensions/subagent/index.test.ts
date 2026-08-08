import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentBackend } from "./backend.ts";
import { createBackendRegistry, createEmptyResult } from "./backend.ts";
import subagentExtension, {
  findUnavailableHarnessWarnings,
  registerSubagentFeatures,
} from "./index.ts";
import type { RunSubagentOptions } from "./runner.ts";
import type { AgentConfig, Harness } from "./types.ts";

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

test("subagent executions use the trust captured at session start", async () => {
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
