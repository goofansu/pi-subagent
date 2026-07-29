import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { SubagentBackend } from "./backend.ts";
import { createBackendRegistry } from "./backend.ts";
import {
  createSubagentExtension,
  findUnavailableHarnessWarnings,
} from "./index.ts";
import type { AgentConfig, Harness } from "./types.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-index-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

test("createSubagentExtension loads project agents from configCwd", async () => {
  const workspaceCwd = await makeTempDir();
  const configCwd = await makeTempDir();
  const agentDir = await makeTempDir();
  const projectAgentsDir = path.join(configCwd, ".pi", "agents");
  await fs.promises.mkdir(projectAgentsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(projectAgentsDir, "host-only.md"),
    "---\ndescription: Host configured agent\n---\n\nSay hello from the host app.\n",
  );

  let registeredTool: { name: string; promptGuidelines?: string[] } | undefined;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: { name: string; promptGuidelines?: string[] }) {
      registeredTool = tool;
    },
    getThinkingLevel() {
      return "medium";
    },
  };

  createSubagentExtension({ cwd: workspaceCwd, agentDir, configCwd })(pi);

  assert.equal(registeredTool?.name, "subagent");
  assert.ok(
    registeredTool?.promptGuidelines?.some((line) =>
      line.includes("host-only"),
    ),
    "expected host-only agent from configCwd to be listed in tool guidelines",
  );
});

test("createSubagentExtension defaults configCwd to cwd", async () => {
  const workspaceCwd = await makeTempDir();
  const agentDir = await makeTempDir();
  const projectAgentsDir = path.join(workspaceCwd, ".pi", "agents");
  await fs.promises.mkdir(projectAgentsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(projectAgentsDir, "workspace-agent.md"),
    "---\ndescription: Workspace configured agent\n---\n\nSay hello from the workspace.\n",
  );

  let registeredTool: { name: string; promptGuidelines?: string[] } | undefined;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: { name: string; promptGuidelines?: string[] }) {
      registeredTool = tool;
    },
    getThinkingLevel() {
      return "medium";
    },
  };

  createSubagentExtension({ cwd: workspaceCwd, agentDir })(pi);

  assert.equal(registeredTool?.name, "subagent");
  assert.ok(
    registeredTool?.promptGuidelines?.some((line) =>
      line.includes("workspace-agent"),
    ),
    "expected project agent from cwd to be listed when configCwd is omitted",
  );
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
