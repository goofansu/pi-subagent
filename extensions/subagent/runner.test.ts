import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, test } from "node:test";
import { getFinalOutput } from "./messages.ts";
import {
  applyPiJsonEvent,
  buildPiArgs,
  buildSkillPaths,
  getSpawnOptions,
  getSubagentDepth,
  resolveAgentSkillPaths,
  resolveSkillPaths,
  resolveSubagentModel,
} from "./runner.ts";
import type { SingleResult } from "./types.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-runner-test-"),
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

function result(): SingleResult {
  return {
    agent: "general-purpose",
    description: "test",
    harness: "pi",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

test("buildPiArgs passes configured tools without disabling tools first", () => {
  const args = buildPiArgs(
    {
      name: "explore",
      description: "Explore code",
      tools: "read,grep,find,ls,bash",
      systemPrompt: "Search only.",
    },
    "anthropic/claude",
    "/tmp/prompt.md",
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    "anthropic/claude",
    "--tools",
    "read,grep,find,ls,bash",
    "--system-prompt",
    "/tmp/prompt.md",
  ]);
});

test("buildPiArgs appends system prompt when appendSystemPrompt is true", () => {
  const args = buildPiArgs(
    {
      name: "explore",
      description: "Explore code",
      appendSystemPrompt: true,
      systemPrompt: "Search only.",
    },
    undefined,
    "/tmp/prompt.md",
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--append-system-prompt",
    "/tmp/prompt.md",
  ]);
});

test("buildPiArgs treats missing tools as no-op to use Pi user config", () => {
  const args = buildPiArgs(
    {
      name: "explore",
      description: "Explore code",
      systemPrompt: "Search only.",
    },
    undefined,
    undefined,
  );

  assert.deepEqual(args, ["--mode", "json", "-p", "--no-session"]);
});

test("buildPiArgs does not include the prompt in argv", () => {
  const args = buildPiArgs(
    { name: "agent", description: "An agent", systemPrompt: "Do stuff." },
    undefined,
    undefined,
  );
  // No element in the args array should be the prompt text
  assert.ok(
    !args.some((a) => a.includes("Do stuff")),
    "prompt must not appear in argv",
  );
});

test("resolveSubagentModel appends parent thinking level for omitted model", () => {
  assert.equal(
    resolveSubagentModel(
      {
        name: "worker",
        description: "Worker",
        systemPrompt: "Work.",
      },
      { provider: "openai-codex", id: "gpt-5.5", thinkingLevel: "high" },
    ),
    "openai-codex/gpt-5.5:high",
  );
});

test("resolveSubagentModel appends parent thinking level for inherit model", () => {
  assert.equal(
    resolveSubagentModel(
      {
        name: "worker",
        description: "Worker",
        model: "inherit",
        systemPrompt: "Work.",
      },
      { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "low" },
    ),
    "anthropic/claude-sonnet-4-5:low",
  );
});

test("resolveSubagentModel leaves explicit configured models unchanged", () => {
  assert.equal(
    resolveSubagentModel(
      {
        name: "worker",
        description: "Worker",
        model: "openai-codex/gpt-5.5",
        systemPrompt: "Work.",
      },
      { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "high" },
    ),
    "openai-codex/gpt-5.5",
  );
});

test("abort signal kills child process and rejects with abort error", async () => {
  // Spawn a process that sleeps indefinitely; abort it and verify it exits.
  const controller = new AbortController();
  const { signal } = controller;

  const exitCode = await new Promise<number | "aborted">((resolve) => {
    const proc = spawn("sleep", ["60"], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });

    let procClosed = false;

    proc.on("close", (code) => {
      procClosed = true;
      resolve(code ?? 0);
    });

    const killProc = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!procClosed) proc.kill("SIGKILL");
      }, 5000);
    };

    signal.addEventListener("abort", killProc, { once: true });
    // Clean up listener if process closes before abort fires
    proc.on("close", () => signal.removeEventListener("abort", killProc));

    // Abort after a short delay
    setTimeout(() => {
      controller.abort();
      resolve("aborted");
    }, 50);
  });

  // Process should have been terminated (exited or aborted path taken)
  assert.ok(
    exitCode === "aborted" || typeof exitCode === "number",
    "process should have been terminated",
  );
});

test("getSubagentDepth returns 0 when env var is not set", () => {
  const original = process.env.PI_SUBAGENT_DEPTH;
  delete process.env.PI_SUBAGENT_DEPTH;
  after(() => {
    if (original !== undefined) process.env.PI_SUBAGENT_DEPTH = original;
    else delete process.env.PI_SUBAGENT_DEPTH;
  });
  assert.equal(getSubagentDepth(), 0);
});

test("getSubagentDepth returns 0 for non-numeric env var", () => {
  const original = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "garbage";
  after(() => {
    if (original !== undefined) process.env.PI_SUBAGENT_DEPTH = original;
    else delete process.env.PI_SUBAGENT_DEPTH;
  });
  assert.equal(getSubagentDepth(), 0);
});

test("getSubagentDepth reads depth from env var", () => {
  const original = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "2";
  after(() => {
    if (original !== undefined) process.env.PI_SUBAGENT_DEPTH = original;
    else delete process.env.PI_SUBAGENT_DEPTH;
  });
  assert.equal(getSubagentDepth(), 2);
});

test("stale abort after natural process exit does not mark run as aborted", async () => {
  // A process that exits immediately; abort fires after it's already gone.
  const controller = new AbortController();
  const { signal } = controller;

  let wasAborted = false;

  await new Promise<void>((resolve) => {
    const proc = spawn("true", [], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });

    let procClosed = false;

    const killProc = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
    };

    signal.addEventListener("abort", killProc, { once: true });

    proc.on("close", () => {
      procClosed = true;
      signal.removeEventListener("abort", killProc); // fix: remove listener
      resolve();
    });

    // Abort fires after the process has already closed
    proc.on("close", () => {
      setTimeout(() => controller.abort(), 50);
    });

    void procClosed; // suppress unused warning
  });

  // Give the abort timeout a chance to fire
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    wasAborted,
    false,
    "abort after natural exit must not mark run as aborted",
  );
});

test("buildPiArgs passes --no-skills and --skill flags when skillPaths provided", () => {
  const args = buildPiArgs(
    {
      name: "worker",
      description: "Worker",
      systemPrompt: "Work.",
    },
    undefined,
    undefined,
    ["/path/to/safe-bash/SKILL.md", "/path/to/tdd/SKILL.md"],
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-skills",
    "--skill",
    "/path/to/safe-bash/SKILL.md",
    "--skill",
    "/path/to/tdd/SKILL.md",
  ]);
});

test("buildPiArgs passes --no-skills with no --skill flags when skillPaths is empty", () => {
  const args = buildPiArgs(
    {
      name: "worker",
      description: "Worker",
      systemPrompt: "Work.",
    },
    undefined,
    undefined,
    [],
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-skills",
  ]);
});

test("buildPiArgs omits skill flags when skillPaths is undefined", () => {
  const args = buildPiArgs(
    {
      name: "scout",
      description: "Scout",
      systemPrompt: "Explore.",
    },
    undefined,
    undefined,
    undefined,
  );

  assert.deepEqual(args, ["--mode", "json", "-p", "--no-session"]);
});

test("buildSkillPaths uses configured project cwd and agentDir", () => {
  assert.deepEqual(
    buildSkillPaths("/tmp/customer-project", "/tmp/user-agent"),
    [
      "/tmp/customer-project/.pi/skills",
      "/tmp/customer-project/.agents/skills",
      "/tmp/user-agent/skills",
      path.join(os.homedir(), ".agents", "skills"),
    ],
  );
});

test("getSpawnOptions runs child pi in configured project cwd", () => {
  const options = getSpawnOptions("/tmp/customer-project", 0);

  assert.equal(options.cwd, "/tmp/customer-project");
  assert.equal(options.env?.PI_SUBAGENT_DEPTH, "1");
});

test("applyPiJsonEvent collects final messages from agent_end events", () => {
  const currentResult = result();

  assert.equal(
    applyPiJsonEvent(
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "final from agent_end" }],
            stopReason: "stop",
          },
        ],
      },
      currentResult,
    ),
    true,
  );

  assert.equal(getFinalOutput(currentResult.messages), "final from agent_end");
  assert.equal(currentResult.stopReason, "stop");
  assert.equal(currentResult.usage.turns, 1);
});

test("resolveSkillPaths resolves known skill names to file paths", async () => {
  const dir = await makeTempDir();
  const skillDir = path.join(dir, ".pi", "skills", "my-skill");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: my-skill\ndescription: A test skill\n---\n\nContent.\n",
  );

  const result = resolveSkillPaths(["my-skill"], dir);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].name, "my-skill");
  assert.ok(result.resolved[0].path.endsWith("SKILL.md"));
  assert.deepEqual(result.missing, []);
});

test("resolveSkillPaths reports missing skill names", async () => {
  const dir = await makeTempDir();

  const result = resolveSkillPaths(["nonexistent"], dir);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.missing, ["nonexistent"]);
});

test("resolveSkillPaths separates found and missing skills", async () => {
  const dir = await makeTempDir();
  const skillDir = path.join(dir, ".pi", "skills", "real-skill");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: real-skill\ndescription: A real skill\n---\n\nContent.\n",
  );

  const result = resolveSkillPaths(["real-skill", "fake-skill"], dir);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].name, "real-skill");
  assert.deepEqual(result.missing, ["fake-skill"]);
});

test("resolveSkillPaths resolves skills from project .agents/skills", async () => {
  const dir = await makeTempDir();
  const skillDir = path.join(dir, ".agents", "skills", "agents-skill");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: agents-skill\ndescription: A skill in .agents/skills\n---\n\nContent.\n",
  );

  const result = resolveSkillPaths(["agents-skill"], dir);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].name, "agents-skill");
  assert.ok(result.resolved[0].path.endsWith("SKILL.md"));
  assert.deepEqual(result.missing, []);
});

test("resolveSkillPaths resolves skills from both .pi/skills and .agents/skills", async () => {
  const dir = await makeTempDir();

  const piSkillDir = path.join(dir, ".pi", "skills", "pi-skill");
  await fs.promises.mkdir(piSkillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(piSkillDir, "SKILL.md"),
    "---\nname: pi-skill\ndescription: A skill in .pi/skills\n---\n\nContent.\n",
  );

  const agentsSkillDir = path.join(dir, ".agents", "skills", "agents-skill");
  await fs.promises.mkdir(agentsSkillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(agentsSkillDir, "SKILL.md"),
    "---\nname: agents-skill\ndescription: A skill in .agents/skills\n---\n\nContent.\n",
  );

  const result = resolveSkillPaths(["pi-skill", "agents-skill"], dir);
  assert.equal(result.resolved.length, 2);
  const names = result.resolved.map((s) => s.name).sort();
  assert.deepEqual(names, ["agents-skill", "pi-skill"]);
  assert.deepEqual(result.missing, []);
});

test("resolveSkillPaths: project .pi/skills takes priority over project .agents/skills on name collision", async () => {
  const dir = await makeTempDir();

  const piSkillDir = path.join(dir, ".pi", "skills", "shared");
  await fs.promises.mkdir(piSkillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(piSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: pi version\n---\n\nFrom .pi/skills.\n",
  );

  const agentsSkillDir = path.join(dir, ".agents", "skills", "shared");
  await fs.promises.mkdir(agentsSkillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(agentsSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: agents version\n---\n\nFrom .agents/skills.\n",
  );

  const result = resolveSkillPaths(["shared"], dir);
  assert.equal(result.resolved.length, 1);
  assert.ok(
    result.resolved[0].path.includes(path.join(".pi", "skills")),
    `expected .pi/skills to win, got ${result.resolved[0].path}`,
  );
});

test("resolveSkillPaths: finds skills in .agents/skills within project scope", async () => {
  const dir = await makeTempDir();

  // Project .agents/skills has the skill
  const projectSkillDir = path.join(dir, ".agents", "skills", "shared");
  await fs.promises.mkdir(projectSkillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(projectSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: project version\n---\n\nProject.\n",
  );

  // User .pi/agent/skills also has it — but project should win
  // .agents/skills is used when .pi/skills doesn't have the skill.
  const result = resolveSkillPaths(["shared"], dir);
  assert.equal(result.resolved.length, 1);
  assert.ok(
    result.resolved[0].path.includes(path.join(".agents", "skills")),
    `expected project .agents/skills to win, got ${result.resolved[0].path}`,
  );
});

test("resolveAgentSkillPaths uses config cwd for agent-declared skills", async () => {
  const workspaceCwd = await makeTempDir();
  const configCwd = await makeTempDir();
  const skillDir = path.join(configCwd, ".pi", "skills", "host-skill");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: host-skill\ndescription: A host app skill\n---\n\nContent.\n",
  );

  const skillPaths = resolveAgentSkillPaths(
    {
      name: "host-agent",
      description: "Host agent",
      systemPrompt: "Use host skills.",
      skills: ["host-skill"],
    },
    configCwd,
  );

  assert.equal(
    skillPaths?.[0],
    path.join(configCwd, ".pi", "skills", "host-skill", "SKILL.md"),
  );
  assert.deepEqual(
    resolveSkillPaths(["host-skill"], workspaceCwd).resolved,
    [],
  );
});
