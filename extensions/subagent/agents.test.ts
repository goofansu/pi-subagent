import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  loadAgentConfigs,
  loadMergedAgentConfigs,
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
  await fs.promises.writeFile(path.join(dir, "two.md"), "Two prompt\n");

  const configs = loadAgentConfigs(dir);

  assert.equal(configs.size, 2);
  assert.equal(configs.get("one")?.description, "First");
  assert.equal(configs.get("one")?.systemPrompt, "One prompt");
  assert.equal(configs.get("two")?.description, "");
  assert.equal(configs.get("two")?.systemPrompt, "Two prompt");
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
  assert.equal(configs.get("code-reviewer")?.model, "custom");
  assert.equal(configs.get("code-reviewer")?.systemPrompt, "User prompt");
  assert.equal(configs.get("general-purpose")?.systemPrompt, "General prompt");
  assert.equal(configs.get("specialist")?.systemPrompt, "Specialist prompt");
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
