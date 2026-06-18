# Package Agent Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically load `agents/` directories from installed Pi packages into `pi-subagent`.

**Architecture:** Add a package-agent layer builder in `extensions/subagent/agents.ts` using Pi's `SettingsManager` and `DefaultPackageManager` public APIs. Extend agent sources with `package`, insert package layers between bundled defaults and user/project overrides, and render package agents in `/agents` with `[t]` to match Pi's installed-package skill autocomplete style.

**Tech Stack:** TypeScript, Node.js built-in test runner, `@earendil-works/pi-coding-agent`, `tsx` test loader.

## Global Constraints

- Agent precedence from lowest to highest: bundled defaults, installed package agents, user agents, project agents.
- `/agents` labels: `[p]` project, `[u]` user, `[t]` installed package.
- Do not copy or symlink package agents into `~/.pi/agent/agents/`.
- Do not add `agents` as a first-class Pi core package resource type.
- Keep existing agent Markdown format unchanged.

---

## File Structure

- `extensions/subagent/types.ts`
  - Extend `AgentSource` to include `"package"`.
- `extensions/subagent/agents.ts`
  - Add package-root helpers and include package layers in `buildAgentConfigLayers()`.
  - Keep parsing, diagnostics, and layer merging in the existing agent-loading module.
- `extensions/subagent/agents.test.ts`
  - Add tests for package layer ordering, package loading, override precedence, duplicate package precedence, and invalid package diagnostics.
- `extensions/subagent/agents-command.ts`
  - Render package agents with `[t]` in `/agents` descriptions.
- `extensions/subagent/agents-command.test.ts`
  - Create focused tests for `/agents` source labels if no command test file exists.

---

### Task 1: Add package agent source and `/agents` label

**Files:**
- Modify: `extensions/subagent/types.ts`
- Modify: `extensions/subagent/agents-command.ts`
- Create: `extensions/subagent/agents-command.test.ts`

**Interfaces:**
- Consumes: existing `AgentConfig.source` field.
- Produces: `AgentSource = "default" | "package" | "user" | "project"`; `/agents` descriptions render `[t]` for package agents.

- [ ] **Step 1: Write failing source-label tests**

Create `extensions/subagent/agents-command.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getAgentSelectItems } from "./agents-command.ts";
import type { AgentConfig } from "./types.ts";

function agent(name: string, source: AgentConfig["source"]): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `${name} prompt`,
    ...(source ? { source } : {}),
  };
}

test("getAgentSelectItems labels project agents with [p]", () => {
  const items = getAgentSelectItems(new Map([["project", agent("project", "project")]]));

  assert.equal(items[0]?.description, "[p] project description");
});

test("getAgentSelectItems labels user agents with [u]", () => {
  const items = getAgentSelectItems(new Map([["user", agent("user", "user")]]));

  assert.equal(items[0]?.description, "[u] user description");
});

test("getAgentSelectItems labels package agents with [t]", () => {
  const items = getAgentSelectItems(new Map([["pkg", agent("pkg", "package")]]));

  assert.equal(items[0]?.description, "[t] pkg description");
});

test("getAgentSelectItems labels default agents with [d]", () => {
  const items = getAgentSelectItems(new Map([["default", agent("default", "default")]]));

  assert.equal(items[0]?.description, "[d] default description");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --test extensions/subagent/agents-command.test.ts
```

Expected: FAIL with a TypeScript/type or assertion failure because `"package"` is not assignable to `AgentSource` or package agents do not render `[t]`.

- [ ] **Step 3: Extend `AgentSource`**

In `extensions/subagent/types.ts`, change:

```ts
export type AgentSource = "default" | "user" | "project";
```

to:

```ts
export type AgentSource = "default" | "package" | "user" | "project";
```

- [ ] **Step 4: Render package agents as `[t]`**

In `extensions/subagent/agents-command.ts`, replace `formatAgentListDescription` with:

```ts
function formatAgentListDescription(agent: AgentConfig): string {
  const prefix =
    agent.source === "project"
      ? "[p]"
      : agent.source === "user"
        ? "[u]"
        : agent.source === "package"
          ? "[t]"
          : "[d]";
  return `${prefix} ${agent.description}`;
}
```

- [ ] **Step 5: Run source-label tests**

Run:

```bash
npx tsx --test extensions/subagent/agents-command.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/subagent/types.ts extensions/subagent/agents-command.ts extensions/subagent/agents-command.test.ts
git commit -m "feat(subagent): label package agents in agents command"
```

---

### Task 2: Build package agent layers from installed package roots

**Files:**
- Modify: `extensions/subagent/agents.ts`
- Modify: `extensions/subagent/agents.test.ts`

**Interfaces:**
- Consumes: `AgentLayer { dir: string; source: AgentSource }` and `AgentSource` from Task 1.
- Produces:
  - `PackageAgentPackage` type with `{ source: string; scope: "user" | "project"; installedPath?: string }`
  - `buildPackageAgentLayers(packages: PackageAgentPackage[]): AgentLayer[]`
  - `getInstalledPackageAgentLayers(cwd: string, agentDir?: string): AgentLayer[]`
  - `buildAgentConfigLayers(..., packageLayers?: AgentLayer[]): AgentLayer[]` including packages between default and user.

- [ ] **Step 1: Write failing tests for package layer helpers**

Add these imports to `extensions/subagent/agents.test.ts`:

```ts
import {
  buildPackageAgentLayers,
  getInstalledPackageAgentLayers,
} from "./agents.ts";
```

If there is already an import block from `./agents.ts`, add the names to that block instead of creating a duplicate.

Add these tests near the existing `buildAgentConfigLayers` tests:

```ts
test("buildPackageAgentLayers maps installed package roots to package agent layers", () => {
  const layers = buildPackageAgentLayers([
    {
      source: "git:github.com/example/one",
      scope: "user",
      installedPath: "/tmp/pi-packages/one",
    },
    {
      source: "git:github.com/example/missing",
      scope: "user",
    },
    {
      source: "npm:two",
      scope: "project",
      installedPath: "/tmp/pi-packages/two",
    },
  ]);

  assert.deepEqual(layers, [
    { dir: path.join("/tmp/pi-packages/one", "agents"), source: "package" },
    { dir: path.join("/tmp/pi-packages/two", "agents"), source: "package" },
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx tsx --test extensions/subagent/agents.test.ts
```

Expected: FAIL because `buildPackageAgentLayers` and `getInstalledPackageAgentLayers` are not exported, or `buildAgentConfigLayers` does not accept package layers.

- [ ] **Step 3: Add Pi package-manager imports**

In `extensions/subagent/agents.ts`, update the Pi import to include `DefaultPackageManager` and `SettingsManager`:

```ts
import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
```

- [ ] **Step 4: Add package layer helper types and functions**

In `extensions/subagent/agents.ts`, after `AgentLayer`, add:

```ts
export interface PackageAgentPackage {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

export function buildPackageAgentLayers(
  packages: PackageAgentPackage[],
): AgentLayer[] {
  return packages
    .filter((pkg) => typeof pkg.installedPath === "string")
    .map((pkg) => ({
      dir: path.join(pkg.installedPath as string, "agents"),
      source: "package" as const,
    }));
}

export function getInstalledPackageAgentLayers(
  cwd: string,
  agentDir = getAgentDir(),
): AgentLayer[] {
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: true,
  });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });

  return buildPackageAgentLayers(packageManager.listConfiguredPackages());
}
```

- [ ] **Step 5: Insert package layers into `buildAgentConfigLayers`**

Change the `buildAgentConfigLayers` signature and return value in `extensions/subagent/agents.ts` to:

```ts
export function buildAgentConfigLayers(
  projectCwd: string,
  agentDir: string,
  moduleUrl: string,
  configCwd = projectCwd,
  packageLayers: AgentLayer[] = getInstalledPackageAgentLayers(configCwd, agentDir),
): AgentLayer[] {
  return [
    { dir: getDefaultAgentsDir(moduleUrl), source: "default" },
    ...packageLayers,
    { dir: path.join(agentDir, "agents"), source: "user" },
    { dir: path.join(configCwd, ".pi", "agents"), source: "project" },
  ];
}
```

- [ ] **Step 6: Run package layer tests**

Run:

```bash
npx tsx --test extensions/subagent/agents.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/subagent/agents.ts extensions/subagent/agents.test.ts
git commit -m "feat(subagent): discover installed package agent layers"
```

---

### Task 3: Verify package agent loading and precedence

**Files:**
- Modify: `extensions/subagent/agents.test.ts`

**Interfaces:**
- Consumes: `loadLayeredAgentConfigsWithDiagnostics(layers: AgentLayer[]): AgentConfigLoadResult`, `buildAgentConfigLayers(...)`, and `source: "package"` from Tasks 1-2.
- Produces: regression coverage proving package agents load and override in the approved order.

- [ ] **Step 1: Write failing/coverage tests for package loading precedence**

Add this helper near the existing temp-dir helpers in `extensions/subagent/agents.test.ts` if an equivalent helper does not already exist:

```ts
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
```

Add these tests:

```ts
test("loadLayeredAgentConfigsWithDiagnostics loads package agents between default and user agents", async () => {
  const dir = await makeTempDir();
  const defaultDir = path.join(dir, "default", "agents");
  const packageDir = path.join(dir, "pkg", "agents");
  const userDir = path.join(dir, "user", "agents");
  const projectDir = path.join(dir, "project", ".pi", "agents");

  await writeAgent(defaultDir, "shared", "default shared", "Default prompt");
  await writeAgent(packageDir, "shared", "package shared", "Package prompt");
  await writeAgent(packageDir, "package-only", "package only", "Package-only prompt");
  await writeAgent(userDir, "shared", "user shared", "User prompt");
  await writeAgent(projectDir, "project-only", "project only", "Project prompt");

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
  assert.equal(result.configs.get("package-only")?.systemPrompt, "Package-only prompt");
  assert.equal(result.configs.get("project-only")?.source, "project");
});

test("later package agent layers override earlier package agent layers", async () => {
  const dir = await makeTempDir();
  const packageOneDir = path.join(dir, "pkg-one", "agents");
  const packageTwoDir = path.join(dir, "pkg-two", "agents");

  await writeAgent(packageOneDir, "duplicate", "first package", "First prompt");
  await writeAgent(packageTwoDir, "duplicate", "second package", "Second prompt");

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
  assert.equal(result.invalidFiles[0]?.reason, "missing required description frontmatter");
  assert.equal(result.invalidFiles[0]?.filePath, path.join(packageDir, "broken.md"));
});
```

- [ ] **Step 2: Run tests**

Run:

```bash
npx tsx --test extensions/subagent/agents.test.ts
```

Expected: PASS. If a helper name such as `makeTempDir` differs in the existing file, use the existing temp-dir helper and keep the assertions unchanged.

- [ ] **Step 3: Commit**

```bash
git add extensions/subagent/agents.test.ts
git commit -m "test(subagent): cover package agent precedence"
```

---

### Task 4: Wire startup discovery and run full verification

**Files:**
- Modify: `extensions/subagent/index.ts` if needed only to keep call sites compiling after Task 2.
- Modify: `README.md`

**Interfaces:**
- Consumes: `buildAgentConfigLayers(projectCwd, agentDir, moduleUrl, configCwd)` default package discovery from Task 2.
- Produces: documented package agent discovery behavior.

- [ ] **Step 1: Confirm `index.ts` uses the default package-aware layer builder**

Open `extensions/subagent/index.ts` and confirm the existing call remains:

```ts
const agentConfigLoadResult = loadLayeredAgentConfigsWithDiagnostics(
  buildAgentConfigLayers(
    projectCwd,
    configuredAgentDir,
    import.meta.url,
    configCwd,
  ),
);
```

Do not pass an explicit fifth argument in production code; omitting it lets `buildAgentConfigLayers()` discover installed package agents from settings.

- [ ] **Step 2: Document package agent discovery**

In `README.md`, replace the Agents discovery paragraph and table with this content:

```md
This package ships with default agents in the `agents/` directory. It also loads agents from installed Pi packages that contain an `agents/` directory, such as packages installed with `pi install https://github.com/goofansu/pi-stuff`. You can add or override agents at the user or project level by creating Markdown files with the same format. Higher-priority agents override lower-priority ones with the same name.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/agents/` |
| 2 | user | `~/.pi/agent/agents/` |
| 3 | package | installed package `agents/` directories, for example `~/.pi/agent/git/github.com/goofansu/pi-stuff/agents/` |
| 4 | bundled | `agents/` |
```

- [ ] **Step 3: Run all subagent tests**

Run:

```bash
npx tsx --test extensions/subagent/*.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run lint check**

Run:

```bash
npm run lint:check
```

Expected: PASS.

- [ ] **Step 6: Manual smoke test package discovery**

Run:

```bash
node --import tsx -e 'import { buildAgentConfigLayers, loadLayeredAgentConfigs } from "./extensions/subagent/agents.ts"; const layers = buildAgentConfigLayers(process.cwd(), process.env.HOME + "/.pi/agent", new URL("./extensions/subagent/index.ts", import.meta.url).href); console.log(layers); const configs = loadLayeredAgentConfigs(layers); console.log([...configs.keys()].sort());'
```

Expected: output includes at least one package layer ending in `/agents` when installed Pi packages with agents exist, and the printed agent names include package agents such as `code-explorer`, `code-reviewer`, `general-purpose`, or `librarian` when `goofansu/pi-stuff` is installed.

- [ ] **Step 7: Commit docs/wiring changes**

```bash
git add extensions/subagent/index.ts README.md
git commit -m "docs(subagent): document package agent discovery"
```

If `extensions/subagent/index.ts` had no changes, run:

```bash
git add README.md
git commit -m "docs(subagent): document package agent discovery"
```

---

## Final Verification

- [ ] Run full test suite:

```bash
npm test
```

Expected: PASS.

- [ ] Run typecheck:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] Run lint check:

```bash
npm run lint:check
```

Expected: PASS.

- [ ] Inspect git status:

```bash
git status --short
```

Expected: no uncommitted changes.

## Self-Review Notes

- Spec coverage: package discovery, precedence, `[t]` labels, diagnostics, docs, and non-goals are covered by Tasks 1-4.
- No placeholders: all test and implementation snippets are concrete.
- Type consistency: `AgentSource`, `AgentLayer`, `PackageAgentPackage`, `buildPackageAgentLayers()`, and `getInstalledPackageAgentLayers()` are named consistently across tasks.
