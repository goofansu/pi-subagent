import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  buildAgentConfigLayers,
  buildPackageAgentLayers,
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getDefaultAgentsDir,
  loadAgentConfigs,
  loadAgentConfigsWithDiagnostics,
  loadLayeredAgentConfigs,
  loadLayeredAgentConfigsWithDiagnostics,
  loadMergedAgentConfigs,
  loadMergedAgentConfigsWithDiagnostics,
  parseAgentConfig,
  validateAgentSkills,
} from "./agents.ts";
import type { AgentConfig } from "./types.ts";

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
    "---\ndescription: Reviews code\nmodel: inherit\ntools: read,grep,find,ls,bash\nappendSystemPrompt: true\n---\n\nYou review code.\n",
  );

  assert.deepEqual(parseAgentConfig(filePath), {
    name: "reviewer",
    description: "Reviews code",
    model: "inherit",
    tools: "read,grep,find,ls,bash",
    appendSystemPrompt: true,
    systemPrompt: "You review code.",
  });
});

test("parseAgentConfig defaults appendSystemPrompt to false", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\n---\n\nYou review code.\n",
  );

  assert.equal(parseAgentConfig(filePath).appendSystemPrompt, false);
});

test("bundled general-purpose agent appends system prompt", () => {
  const filePath = path.join(process.cwd(), "agents", "general-purpose.md");

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

test("buildPackageAgentLayers maps installed package roots with agents directories to package agent layers", async () => {
  const dir = await makeTempDir();
  const packageOne = path.join(dir, "one");
  const packageTwo = path.join(dir, "two");
  const packageWithoutAgents = path.join(dir, "without-agents");
  await fs.promises.mkdir(path.join(packageOne, "agents"), { recursive: true });
  await fs.promises.mkdir(path.join(packageTwo, "agents"), { recursive: true });
  await fs.promises.mkdir(packageWithoutAgents, { recursive: true });

  const layers = buildPackageAgentLayers([
    {
      source: "git:github.com/example/one",
      scope: "user",
      installedPath: packageOne,
    },
    {
      source: "git:github.com/example/missing",
      scope: "user",
    },
    {
      source: "npm:without-agents",
      scope: "user",
      installedPath: packageWithoutAgents,
    },
    {
      source: "npm:two",
      scope: "project",
      installedPath: packageTwo,
    },
  ]);

  assert.deepEqual(layers, [
    { dir: path.join(packageOne, "agents"), source: "package" },
    { dir: path.join(packageTwo, "agents"), source: "package" },
  ]);
});

test("buildAgentConfigLayers inserts package layers between default and user layers", () => {
  const layers = buildAgentConfigLayers(
    "/tmp/customer-project",
    "/tmp/user-agent",
    "file:///tmp/pi-subagent/extensions/subagent/index.ts",
    "/tmp/config-project",
    [
      { dir: "/tmp/pkg-one/agents", source: "package" },
      { dir: "/tmp/pkg-two/agents", source: "package" },
    ],
  );

  assert.deepEqual(layers, [
    { dir: "/tmp/pi-subagent/agents", source: "default" },
    { dir: "/tmp/pkg-one/agents", source: "package" },
    { dir: "/tmp/pkg-two/agents", source: "package" },
    { dir: "/tmp/user-agent/agents", source: "user" },
    { dir: "/tmp/config-project/.pi/agents", source: "project" },
  ]);
});

test("buildAgentConfigLayers excludes package layer matching the default agents directory", () => {
  const moduleUrl = "file:///tmp/pi-subagent/extensions/subagent/index.ts";
  const defaultDir = getDefaultAgentsDir(moduleUrl);

  const layers = buildAgentConfigLayers(
    "/tmp/customer-project",
    "/tmp/user-agent",
    moduleUrl,
    "/tmp/config-project",
    [
      { dir: "/tmp/pkg-one/agents", source: "package" },
      { dir: defaultDir, source: "package" },
    ],
  );

  assert.deepEqual(layers, [
    { dir: defaultDir, source: "default" },
    { dir: "/tmp/pkg-one/agents", source: "package" },
    { dir: "/tmp/user-agent/agents", source: "user" },
    { dir: "/tmp/config-project/.pi/agents", source: "project" },
  ]);
});

test("buildAgentConfigLayers anchors project and user agents to configured directories", () => {
  const moduleUrl = new URL("./index.js", import.meta.url).href;

  assert.deepEqual(
    buildAgentConfigLayers(
      "/tmp/customer-project",
      "/tmp/user-agent",
      moduleUrl,
    ),
    [
      { dir: getDefaultAgentsDir(moduleUrl), source: "default" },
      { dir: "/tmp/user-agent/agents", source: "user" },
      { dir: "/tmp/customer-project/.pi/agents", source: "project" },
    ],
  );
});

test("buildAgentConfigLayers can load project agents from config cwd", () => {
  const moduleUrl = new URL("./index.js", import.meta.url).href;

  assert.deepEqual(
    buildAgentConfigLayers(
      "/tmp/customer-project",
      "/tmp/user-agent",
      moduleUrl,
      "/tmp/host-project",
    ),
    [
      { dir: getDefaultAgentsDir(moduleUrl), source: "default" },
      { dir: "/tmp/user-agent/agents", source: "user" },
      { dir: "/tmp/host-project/.pi/agents", source: "project" },
    ],
  );
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

test("loadLayeredAgentConfigsWithDiagnostics loads package agents between default and user agents", async () => {
  const dir = await makeTempDir();
  const defaultDir = path.join(dir, "default", "agents");
  const packageDir = path.join(dir, "pkg", "agents");
  const userDir = path.join(dir, "user", "agents");
  const projectDir = path.join(dir, "project", ".pi", "agents");

  await writeAgent(defaultDir, "shared", "default shared", "Default prompt");
  await writeAgent(packageDir, "shared", "package shared", "Package prompt");
  await writeAgent(
    packageDir,
    "package-only",
    "package only",
    "Package-only prompt",
  );
  await writeAgent(userDir, "shared", "user shared", "User prompt");
  await writeAgent(
    projectDir,
    "project-only",
    "project only",
    "Project prompt",
  );

  const result = loadLayeredAgentConfigsWithDiagnostics([
    { dir: defaultDir, source: "default" },
    { dir: packageDir, source: "package" },
    { dir: userDir, source: "user" },
    { dir: projectDir, source: "project" },
  ]);

  assert.equal(result.invalidFiles.length, 0);
  assert.equal(result.configs.get("shared")?.source, "user");
  assert.equal(result.configs.get("shared")?.description, "user shared");
  assert.equal(result.configs.get("package-only")?.source, "package");
  assert.equal(
    result.configs.get("package-only")?.systemPrompt,
    "Package-only prompt",
  );
  assert.equal(result.configs.get("project-only")?.source, "project");
});

test("later package agent layers override earlier package agent layers", async () => {
  const dir = await makeTempDir();
  const packageOneDir = path.join(dir, "pkg-one", "agents");
  const packageTwoDir = path.join(dir, "pkg-two", "agents");

  await writeAgent(packageOneDir, "duplicate", "first package", "First prompt");
  await writeAgent(
    packageTwoDir,
    "duplicate",
    "second package",
    "Second prompt",
  );

  const result = loadLayeredAgentConfigsWithDiagnostics([
    { dir: packageOneDir, source: "package" },
    { dir: packageTwoDir, source: "package" },
  ]);

  assert.equal(result.invalidFiles.length, 0);
  assert.equal(result.configs.get("duplicate")?.source, "package");
  assert.equal(result.configs.get("duplicate")?.description, "second package");
  assert.equal(result.configs.get("duplicate")?.systemPrompt, "Second prompt");
});

test("invalid package agent files are reported through diagnostics", async () => {
  const dir = await makeTempDir();
  const packageDir = path.join(dir, "pkg", "agents");
  await fs.promises.mkdir(packageDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(packageDir, "broken.md"),
    "---\nmodel: inherit\n---\n\nMissing a description.\n",
  );

  const result = loadLayeredAgentConfigsWithDiagnostics([
    { dir: packageDir, source: "package" },
  ]);

  assert.equal(result.configs.size, 0);
  assert.equal(result.invalidFiles.length, 1);
  assert.equal(
    result.invalidFiles[0]?.reason,
    "missing required description frontmatter",
  );
  assert.equal(
    result.invalidFiles[0]?.filePath,
    path.join(packageDir, "broken.md"),
  );
});

test("loadLayeredAgentConfigs merges three layers with correct priority", async () => {
  const bundledDir = await makeTempDir();
  const userDir = await makeTempDir();
  const projectDir = await makeTempDir();

  await fs.promises.writeFile(
    path.join(bundledDir, "general-purpose.md"),
    "---\ndescription: Bundled general\n---\n\nBundled general prompt\n",
  );
  await fs.promises.writeFile(
    path.join(bundledDir, "code-reviewer.md"),
    "---\ndescription: Bundled reviewer\n---\n\nBundled reviewer prompt\n",
  );
  await fs.promises.writeFile(
    path.join(userDir, "code-reviewer.md"),
    "---\ndescription: User reviewer\n---\n\nUser reviewer prompt\n",
  );
  await fs.promises.writeFile(
    path.join(userDir, "user-only.md"),
    "---\ndescription: User only\n---\n\nUser only prompt\n",
  );
  await fs.promises.writeFile(
    path.join(projectDir, "code-reviewer.md"),
    "---\ndescription: Project reviewer\n---\n\nProject reviewer prompt\n",
  );
  await fs.promises.writeFile(
    path.join(projectDir, "project-only.md"),
    "---\ndescription: Project only\n---\n\nProject only prompt\n",
  );

  const configs = loadLayeredAgentConfigs([
    { dir: bundledDir, source: "default" },
    { dir: userDir, source: "user" },
    { dir: projectDir, source: "project" },
  ]);

  assert.equal(configs.size, 4);
  // Project wins over user and bundled
  assert.equal(configs.get("code-reviewer")?.description, "Project reviewer");
  assert.equal(configs.get("code-reviewer")?.source, "project");
  // Bundled agent survives when not overridden
  assert.equal(configs.get("general-purpose")?.source, "default");
  // User-only agent survives
  assert.equal(configs.get("user-only")?.source, "user");
  // Project-only agent present
  assert.equal(configs.get("project-only")?.source, "project");
});

test("loadLayeredAgentConfigsWithDiagnostics aggregates invalid files across all layers", async () => {
  const bundledDir = await makeTempDir();
  const userDir = await makeTempDir();
  const projectDir = await makeTempDir();

  await fs.promises.writeFile(
    path.join(bundledDir, "valid.md"),
    "---\ndescription: Valid\n---\n\nValid prompt\n",
  );
  await fs.promises.writeFile(path.join(bundledDir, "bad-base.md"), "Prompt\n");
  await fs.promises.writeFile(
    path.join(userDir, "bad-user.md"),
    "---\ndescription: Bad user\n---\n\n",
  );
  await fs.promises.writeFile(
    path.join(projectDir, "bad-project.md"),
    "No frontmatter\n",
  );

  const result = loadLayeredAgentConfigsWithDiagnostics([
    { dir: bundledDir, source: "default" },
    { dir: userDir, source: "user" },
    { dir: projectDir, source: "project" },
  ]);

  assert.equal(result.configs.size, 1);
  assert.deepEqual(
    result.invalidFiles.map((invalid) => path.basename(invalid.filePath)),
    ["bad-base.md", "bad-user.md", "bad-project.md"],
  );
});

test("loadLayeredAgentConfigs tolerates missing directories in any layer", async () => {
  const bundledDir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(bundledDir, "general-purpose.md"),
    "---\ndescription: General\n---\n\nGeneral prompt\n",
  );

  const missingUser = path.join(await makeTempDir(), "missing-user");
  const missingProject = path.join(await makeTempDir(), "missing-project");

  const configs = loadLayeredAgentConfigs([
    { dir: bundledDir, source: "default" },
    { dir: missingUser, source: "user" },
    { dir: missingProject, source: "project" },
  ]);

  assert.equal(configs.size, 1);
  assert.equal(configs.get("general-purpose")?.description, "General");
});

test("parseAgentConfig parses skills from frontmatter", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "worker.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Worker agent\nskills: safe-bash, tdd\n---\n\nYou implement code.\n",
  );

  const config = parseAgentConfig(filePath);
  assert.deepEqual(config.skills, ["safe-bash", "tdd"]);
});

test("parseAgentConfig omits skills when not in frontmatter", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "scout.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Scout agent\n---\n\nYou explore code.\n",
  );

  const config = parseAgentConfig(filePath);
  assert.equal(config.skills, undefined);
});

test("parseAgentConfig handles a single skill without commas", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "focused.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Focused agent\nskills: safe-bash\n---\n\nYou do one thing.\n",
  );

  const config = parseAgentConfig(filePath);
  assert.deepEqual(config.skills, ["safe-bash"]);
});

test("validateAgentSkills returns no warnings when all skills exist", async () => {
  const dir = await makeTempDir();
  const skillDir = path.join(dir, ".pi", "skills", "my-skill");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: my-skill\ndescription: A test skill\n---\n\nSkill content.\n",
  );

  const configs = new Map<string, AgentConfig>([
    [
      "worker",
      {
        name: "worker",
        description: "Worker",
        skills: ["my-skill"],
        systemPrompt: "Work.",
      },
    ],
  ]);

  const warnings = validateAgentSkills(configs, dir);
  assert.deepEqual(warnings, []);
});

test("validateAgentSkills returns warnings for missing skills", async () => {
  const dir = await makeTempDir();

  const configs = new Map<string, AgentConfig>([
    [
      "worker",
      {
        name: "worker",
        description: "Worker",
        skills: ["nonexistent"],
        systemPrompt: "Work.",
      },
    ],
  ]);

  const warnings = validateAgentSkills(configs, dir);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Agent 'worker'/);
  assert.match(warnings[0], /nonexistent/);
});

test("validateAgentSkills skips agents without skills defined", async () => {
  const dir = await makeTempDir();

  const configs = new Map<string, AgentConfig>([
    [
      "scout",
      {
        name: "scout",
        description: "Scout",
        systemPrompt: "Explore.",
      },
    ],
  ]);

  const warnings = validateAgentSkills(configs, dir);
  assert.deepEqual(warnings, []);
});
