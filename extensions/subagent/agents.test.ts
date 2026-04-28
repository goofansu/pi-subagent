import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getDefaultAgentsDir,
  loadAgentConfigs,
  loadAgentConfigsWithDiagnostics,
  loadMergedAgentConfigs,
  loadMergedAgentConfigsWithDiagnostics,
  parseAgentConfig,
} from "./agents.js";

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
    "---\ndescription: Reviews code\nmodel: inherit\ntools: read,grep,find,ls,bash\n---\n\nYou review code.\n",
  );

  assert.deepEqual(parseAgentConfig(filePath), {
    name: "reviewer",
    description: "Reviews code",
    model: "inherit",
    tools: "read,grep,find,ls,bash",
    systemPrompt: "You review code.",
  });
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
  assert.equal(configs.get("one")?.source, "default");
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

test("loadMergedAgentConfigs lets override agents replace bundled agents", async () => {
  const bundledDir = await makeTempDir();
  const userDir = await makeTempDir();

  await fs.promises.writeFile(
    path.join(bundledDir, "code-reviewer.md"),
    "---\ndescription: Bundled reviewer\n---\n\nBundled prompt\n",
  );
  await fs.promises.writeFile(
    path.join(bundledDir, "general-purpose.md"),
    "---\ndescription: General\n---\n\nGeneral prompt\n",
  );
  await fs.promises.writeFile(
    path.join(userDir, "code-reviewer.md"),
    "---\ndescription: User reviewer\nmodel: custom\n---\n\nUser prompt\n",
  );
  await fs.promises.writeFile(
    path.join(userDir, "specialist.md"),
    "---\ndescription: Specialist\n---\n\nSpecialist prompt\n",
  );

  const configs = loadMergedAgentConfigs(bundledDir, userDir);

  assert.equal(configs.size, 3);
  assert.equal(configs.get("code-reviewer")?.description, "User reviewer");
  assert.equal(configs.get("code-reviewer")?.source, "user");
  assert.equal(configs.get("code-reviewer")?.model, "custom");
  assert.equal(configs.get("code-reviewer")?.systemPrompt, "User prompt");
  assert.equal(configs.get("general-purpose")?.source, "default");
  assert.equal(configs.get("general-purpose")?.systemPrompt, "General prompt");
  assert.equal(configs.get("specialist")?.source, "user");
  assert.equal(configs.get("specialist")?.systemPrompt, "Specialist prompt");
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

test("getDefaultAgentsDir decodes percent-encoded paths", () => {
  const url = "file:///home/user/my%20project/extensions/subagent/index.js";
  const dir = getDefaultAgentsDir(url);
  assert.ok(!dir.includes("%20"), "path must not contain URL encoding");
  assert.ok(dir.includes("my project"), "path must decode spaces");
});

test("loadMergedAgentConfigs tolerates a missing override directory", async () => {
  const bundledDir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(bundledDir, "general-purpose.md"),
    "---\ndescription: General\n---\n\nGeneral prompt\n",
  );

  const missingOverrideDir = path.join(await makeTempDir(), "missing");
  const configs = loadMergedAgentConfigs(bundledDir, missingOverrideDir);

  assert.equal(configs.size, 1);
  assert.equal(configs.get("general-purpose")?.description, "General");
});

test("loadMergedAgentConfigsWithDiagnostics combines invalid bundled and override files", async () => {
  const bundledDir = await makeTempDir();
  const userDir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(bundledDir, "valid.md"),
    "---\ndescription: Valid\n---\n\nValid prompt\n",
  );
  await fs.promises.writeFile(path.join(bundledDir, "bad-base.md"), "Prompt\n");
  await fs.promises.writeFile(
    path.join(userDir, "bad-user.md"),
    "---\ndescription: Bad user\n---\n\n",
  );

  const result = loadMergedAgentConfigsWithDiagnostics(bundledDir, userDir);

  assert.equal(result.configs.size, 1);
  assert.deepEqual(
    result.invalidFiles.map((invalid) => path.basename(invalid.filePath)),
    ["bad-base.md", "bad-user.md"],
  );
});
