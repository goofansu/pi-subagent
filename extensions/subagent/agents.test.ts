import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getAgentsDir,
  loadAgentConfigs,
  loadAgentConfigsWithDiagnostics,
  parseAgentConfig,
} from "./agents.ts";
import { EFFORTS, resolveAppendSystemPrompt } from "./types.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-test-"),
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
    model: "custom",
    tools: "read,grep,find,ls,bash",
    appendSystemPrompt: true,
    systemPrompt: "You review code.",
  });
});

test("parseAgentConfig leaves an unset appendSystemPrompt absent", async () => {
  // The default belongs to resolveAppendSystemPrompt, so the parsed profile
  // records what the file says and nothing more.
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\n---\n\nYou review code.\n",
  );

  const config = parseAgentConfig(filePath);
  assert.equal(config.appendSystemPrompt, undefined);
  assert.equal(Object.hasOwn(config, "appendSystemPrompt"), false);
  assert.equal(resolveAppendSystemPrompt(config), true);
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
        description: "Runs a custom check.",
        systemPrompt: "Custom.",
      },
    ],
  ]);

  assert.deepEqual(formatAgentGuidelines(configs), [
    "subagent explore: Fast codebase exploration.",
    "subagent custom: Runs a custom check.",
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

test("getAgentsDir reads agents from user scope only", () => {
  // No project directory is involved at all: a repository cannot contribute a
  // system prompt, a model, a tool list, or a description that reaches the
  // calling model's tool guidelines.
  assert.equal(getAgentsDir("/tmp/user-agent"), "/tmp/user-agent/agents");
});

test("loadAgentConfigs returns nothing for a missing agents directory", async () => {
  const missing = path.join(await makeTempDir(), "missing");

  assert.equal(loadAgentConfigs(missing).size, 0);
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

test("parseAgentConfig names the field when frontmatter is not a string", async () => {
  // YAML types the value, so nothing stops an author writing a list or a map.
  // The diagnostic has to name the field, not read `raw?.trim is not a
  // function` out of a crash.
  const dir = await makeTempDir();
  for (const [frontmatter, expected] of [
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
});

test("parseAgentConfig accepts a comma-separated tools list", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "tools: read, grep");

  assert.equal(parseAgentConfig(filePath).tools, "read, grep");
});

test("parseAgentConfig reads effort as its own field", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(
    dir,
    "model: openai-codex/gpt-5.6-sol\neffort: high",
  );

  const config = parseAgentConfig(filePath);
  assert.equal(config.model, "openai-codex/gpt-5.6-sol");
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
  // No provider stripping, no suffix splitting. Whatever pi accepts is between
  // the author and pi.
  for (const model of [
    "claude-opus-4-5",
    "openai-codex/gpt-5.5",
    "openrouter/google/gemma-4-31b-it:free",
    "bedrock/us.anthropic.claude-opus-4-5-v1:0",
    "arn:aws:bedrock:us-east-1:1234:application-inference-profile/mine",
    "sonnet:high",
  ]) {
    const filePath = await writeAgentWithFrontmatter(dir, `model: ${model}`);
    assert.equal(parseAgentConfig(filePath).model, model, model);
  }
});
