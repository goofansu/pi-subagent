import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  buildAgentConfigLayers,
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  loadAgentConfigs,
  loadAgentConfigsWithDiagnostics,
  loadLayeredAgentConfigs,
  loadLayeredAgentConfigsWithDiagnostics,
  parseAgentConfig,
} from "./agents.ts";
import { EFFORTS } from "./types.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

async function writeAgent(
  dir: string,
  name: string,
  description: string,
  prompt: string,
): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${name}.md`),
    `---\ndescription: ${description}\n---\n\n${prompt}\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

test("parseAgentConfig reads name, frontmatter, and system prompt", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\nmodel: custom\ntools: read,grep,find,ls,bash\nappendSystemPrompt: true\n---\n\nYou review code.\n",
  );

  assert.deepEqual(parseAgentConfig(filePath), {
    name: "reviewer",
    description: "Reviews code",
    harness: "pi",
    model: "custom",
    tools: "read,grep,find,ls,bash",
    appendSystemPrompt: true,
    systemPrompt: "You review code.",
  });
});

test("parseAgentConfig defaults appendSystemPrompt to true", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\n---\n\nYou review code.\n",
  );

  assert.equal(parseAgentConfig(filePath).appendSystemPrompt, true);
});

test("parseAgentConfig preserves explicit appendSystemPrompt false", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\nappendSystemPrompt: false\n---\n\nYou review code.\n",
  );

  assert.equal(parseAgentConfig(filePath).appendSystemPrompt, false);
});

test("example general-purpose project agent uses the append default", () => {
  const filePath = path.join(
    process.cwd(),
    ".pi",
    "agents",
    "general-purpose.md",
  );

  assert.equal(parseAgentConfig(filePath).appendSystemPrompt, true);
});

test("loadAgentConfigs returns markdown agents keyed by name", async () => {
  const dir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(dir, "one.md"),
    "---\ndescription: First\n---\n\nOne prompt\n",
  );
  await fs.promises.writeFile(path.join(dir, "ignored.txt"), "not an agent");
  await fs.promises.writeFile(
    path.join(dir, "two.md"),
    "---\ndescription: Second\n---\n\nTwo prompt\n",
  );

  const configs = loadAgentConfigs(dir);

  assert.equal(configs.size, 2);
  assert.equal(configs.get("one")?.description, "First");
  assert.equal(configs.get("one")?.source, undefined);
  assert.equal(configs.get("one")?.systemPrompt, "One prompt");
  assert.equal(configs.get("two")?.description, "Second");
  assert.equal(configs.get("two")?.systemPrompt, "Two prompt");
});

test("parseAgentConfig rejects agents without required description", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "missing-description.md");
  await fs.promises.writeFile(filePath, "Prompt only\n");

  assert.throws(
    () => parseAgentConfig(filePath),
    /missing required description/,
  );
});

test("parseAgentConfig rejects agents without required prompt body", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "missing-prompt.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Missing prompt\n---\n\n   \n",
  );

  assert.throws(() => parseAgentConfig(filePath), /missing required prompt/);
});

test("loadAgentConfigs skips invalid agent files", async () => {
  const dir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(dir, "valid.md"),
    "---\ndescription: Valid\n---\n\nValid prompt\n",
  );
  await fs.promises.writeFile(path.join(dir, "invalid.md"), "Invalid prompt\n");

  const configs = loadAgentConfigs(dir);

  assert.equal(configs.size, 1);
  assert.equal(configs.has("valid"), true);
  assert.equal(configs.has("invalid"), false);
});

test("loadAgentConfigsWithDiagnostics reports invalid agent files", async () => {
  const dir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(dir, "valid.md"),
    "---\ndescription: Valid\n---\n\nValid prompt\n",
  );
  await fs.promises.writeFile(path.join(dir, "no-description.md"), "Prompt\n");
  await fs.promises.writeFile(
    path.join(dir, "no-prompt.md"),
    "---\ndescription: No prompt\n---\n\n",
  );

  const result = loadAgentConfigsWithDiagnostics(dir);

  assert.equal(result.configs.size, 1);
  assert.deepEqual(
    result.invalidFiles.map((invalid) => ({
      file: path.basename(invalid.filePath),
      reason: invalid.reason,
    })),
    [
      {
        file: "no-description.md",
        reason: "missing required description frontmatter",
      },
      { file: "no-prompt.md", reason: "missing required prompt body" },
    ],
  );
});

test("loadAgentConfigs returns an empty map when directory is missing", () => {
  const configs = loadAgentConfigs(
    path.join(os.tmpdir(), "missing-pi-subagent-agents"),
  );

  assert.equal(configs.size, 0);
});

test("formatAgentGuidelines renders available agents as tool-specific guidelines", () => {
  const configs = new Map([
    [
      "explore",
      {
        name: "explore",
        description: "Fast codebase exploration.",
        systemPrompt: "Explore.",
      },
    ],
    [
      "custom",
      {
        name: "custom",
        description: "",
        systemPrompt: "Custom.",
      },
    ],
  ]);

  assert.deepEqual(formatAgentGuidelines(configs), [
    "subagent explore: Fast codebase exploration.",
    "subagent custom.",
  ]);
});

test("formatAgentGuidelines handles no configured agents", () => {
  assert.deepEqual(formatAgentGuidelines(new Map()), [
    "subagent has no configured agents.",
  ]);
});

test("formatInvalidAgentFilesWarning renders invalid files for UI notification", () => {
  assert.equal(
    formatInvalidAgentFilesWarning([
      {
        filePath: path.join("agents", "missing-description.md"),
        reason: "missing required description frontmatter",
      },
      {
        filePath: path.join("agents", "missing-prompt.md"),
        reason: "missing required prompt body",
      },
    ]),
    "Invalid subagent files were skipped:\n- agents/missing-description.md: missing required description frontmatter\n- agents/missing-prompt.md: missing required prompt body",
  );
});

test("buildAgentConfigLayers anchors project and user agents to configured directories", () => {
  assert.deepEqual(
    buildAgentConfigLayers("/tmp/customer-project", "/tmp/user-agent", true),
    [
      { dir: "/tmp/user-agent/agents", source: "user" },
      { dir: "/tmp/customer-project/.pi/agents", source: "project" },
    ],
  );
});

test("buildAgentConfigLayers excludes project agents when the project is untrusted", () => {
  assert.deepEqual(
    buildAgentConfigLayers("/tmp/customer-project", "/tmp/user-agent", false),
    [{ dir: "/tmp/user-agent/agents", source: "user" }],
  );
});

test("loadLayeredAgentConfigs lets project agents override user agents", async () => {
  const dir = await makeTempDir();
  const userDir = path.join(dir, "user", "agents");
  const projectDir = path.join(dir, "project", ".pi", "agents");

  await writeAgent(userDir, "shared", "user shared", "User prompt");
  await writeAgent(userDir, "user-only", "user only", "User-only prompt");
  await writeAgent(projectDir, "shared", "project shared", "Project prompt");
  await writeAgent(
    projectDir,
    "project-only",
    "project only",
    "Project prompt",
  );

  const configs = loadLayeredAgentConfigs([
    { dir: userDir, source: "user" },
    { dir: projectDir, source: "project" },
  ]);

  assert.equal(configs.size, 3);
  assert.equal(configs.get("shared")?.description, "project shared");
  assert.equal(configs.get("shared")?.source, "project");
  assert.equal(configs.get("user-only")?.source, "user");
  assert.equal(configs.get("project-only")?.source, "project");
});

test("loadLayeredAgentConfigsWithDiagnostics aggregates invalid user and project files", async () => {
  const userDir = await makeTempDir();
  const projectDir = await makeTempDir();

  await fs.promises.writeFile(
    path.join(userDir, "bad-user.md"),
    "---\ndescription: Bad user\n---\n\n",
  );
  await fs.promises.writeFile(
    path.join(projectDir, "bad-project.md"),
    "No frontmatter\n",
  );

  const result = loadLayeredAgentConfigsWithDiagnostics([
    { dir: userDir, source: "user" },
    { dir: projectDir, source: "project" },
  ]);

  assert.equal(result.configs.size, 0);
  assert.deepEqual(
    result.invalidFiles.map((invalid) => path.basename(invalid.filePath)),
    ["bad-user.md", "bad-project.md"],
  );
});

test("loadLayeredAgentConfigs tolerates missing directories in any layer", async () => {
  const missingUser = path.join(await makeTempDir(), "missing-user");
  const missingProject = path.join(await makeTempDir(), "missing-project");

  const configs = loadLayeredAgentConfigs([
    { dir: missingUser, source: "user" },
    { dir: missingProject, source: "project" },
  ]);

  assert.equal(configs.size, 0);
});

async function writeAgentWithFrontmatter(
  dir: string,
  frontmatter: string,
): Promise<string> {
  const filePath = path.join(dir, "worker.md");
  await fs.promises.writeFile(
    filePath,
    `---\ndescription: Does work\n${frontmatter}\n---\n\nWork.\n`,
  );
  return filePath;
}

test("parseAgentConfig defaults an agent without a harness to pi", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "");

  assert.equal(parseAgentConfig(filePath).harness, "pi");
});

test("parseAgentConfig rejects the removed inherit model value", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "model: inherit");

  assert.throws(
    () => parseAgentConfig(filePath),
    /model 'inherit' is not supported; omit model instead/,
  );
});

test("parseAgentConfig accepts the codex harness", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "harness: codex");

  assert.equal(parseAgentConfig(filePath).harness, "codex");
});

test("parseAgentConfig rejects an unknown harness", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "harness: gemini");

  assert.throws(
    () => parseAgentConfig(filePath),
    /unknown harness 'gemini'; expected one of pi, claude, codex/,
  );
});

test("parseAgentConfig names the field when frontmatter is not a string", async () => {
  // YAML types the value, so nothing stops an author writing a list or a map.
  // The diagnostic has to name the field, not read `raw?.trim is not a
  // function` out of a crash.
  const dir = await makeTempDir();
  for (const [frontmatter, expected] of [
    ["harness: []", /harness must be a string, not a list/],
    ["model: {a: 1}", /model must be a string, not a map/],
    ["tools: 12", /tools must be a string, not a number/],
    ["model: []", /model must be a string, not a list/],
    [
      "appendSystemPrompt: yes please",
      /appendSystemPrompt must be true or false, not a string/,
    ],
  ] as const) {
    const filePath = await writeAgentWithFrontmatter(dir, frontmatter);
    assert.throws(() => parseAgentConfig(filePath), expected, frontmatter);
  }
});

test("parseAgentConfig names description when it is not a string", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "worker.md");
  await fs.promises.writeFile(filePath, "---\ndescription: []\n---\n\nWork.\n");

  assert.throws(
    () => parseAgentConfig(filePath),
    /description must be a string, not a list/,
  );
});

test("parseAgentConfig treats an empty optional string field as absent", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "model:");

  const config = parseAgentConfig(filePath);
  assert.equal(config.model, undefined);
  assert.equal(config.appendSystemPrompt, true);
});

test("loadAgentConfigsWithDiagnostics loads a codex agent", async () => {
  const dir = await makeTempDir();
  await writeAgentWithFrontmatter(dir, "harness: codex");

  const { configs, invalidFiles } = loadAgentConfigsWithDiagnostics(dir);
  assert.equal(configs.get("worker")?.harness, "codex");
  assert.deepEqual(invalidFiles, []);
});

test("parseAgentConfig rejects tools on the claude harness", async () => {
  // Accepting it would read as a restriction while silently not being one — an
  // author would believe they had built a read-only agent.
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(
    dir,
    "harness: claude\ntools: Read, Grep",
  );

  assert.throws(
    () => parseAgentConfig(filePath),
    /tools is only supported on harness 'pi'/,
  );
});

test("parseAgentConfig rejects tools on the codex harness", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(
    dir,
    "harness: codex\ntools: read, grep",
  );

  assert.throws(
    () => parseAgentConfig(filePath),
    /tools is only supported on harness 'pi'/,
  );
});

test("parseAgentConfig still accepts tools on the pi harness", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "tools: read, grep");

  assert.equal(parseAgentConfig(filePath).tools, "read, grep");
});

test("parseAgentConfig reads effort as its own field", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(
    dir,
    "harness: claude\nmodel: claude-opus-4-5\neffort: high",
  );

  const config = parseAgentConfig(filePath);
  assert.equal(config.model, "claude-opus-4-5");
  assert.equal(config.effort, "high");
});

test("parseAgentConfig accepts every effort in the scale", async () => {
  const dir = await makeTempDir();
  for (const effort of EFFORTS) {
    const filePath = await writeAgentWithFrontmatter(dir, `effort: ${effort}`);
    assert.equal(parseAgentConfig(filePath).effort, effort);
  }
});

test("parseAgentConfig rejects an unknown effort", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "effort: turbo");

  // The validation a model suffix could never do: `effort` is a closed scale, so
  // a typo is an error rather than something indistinguishable from an id.
  assert.throws(
    () => parseAgentConfig(filePath),
    /unknown effort 'turbo'; expected one of off, minimal, low, medium, high, xhigh, max/,
  );
});

test("parseAgentConfig passes a model through exactly as written", async () => {
  const dir = await makeTempDir();
  // No provider stripping, no suffix splitting. Whatever the harness accepts is
  // between the author and the harness.
  for (const model of [
    "claude-opus-4-5",
    "openai-codex/gpt-5.5",
    "openrouter/google/gemma-4-31b-it:free",
    "bedrock/us.anthropic.claude-opus-4-5-v1:0",
    "arn:aws:bedrock:us-east-1:1234:application-inference-profile/mine",
  ]) {
    const filePath = await writeAgentWithFrontmatter(dir, `model: ${model}`);
    assert.equal(parseAgentConfig(filePath).model, model, model);
  }
});

test("parseAgentConfig rejects an effort suffix on the model", async () => {
  const dir = await makeTempDir();
  for (const model of ["sonnet:high", "inherit:high"]) {
    const filePath = await writeAgentWithFrontmatter(dir, `model: ${model}`);
    // The model is handed to the harness verbatim, so a `:high` it carries would
    // reach it as part of the id. One place to say effort, and this is not it.
    assert.throws(
      () => parseAgentConfig(filePath),
      /model is passed to the harness as written; set 'effort: high' instead of the ':high' suffix/,
      model,
    );
  }
});
