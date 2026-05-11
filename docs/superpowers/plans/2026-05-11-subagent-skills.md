# Subagent Skills Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `skills` field to agent frontmatter that resolves skill names to file paths and passes them as `--skill <path>` flags to the child pi process.

**Architecture:** Parse `skills` from agent frontmatter in `agents.ts`, validate at startup in `index.ts`, resolve to paths and pass as CLI flags in `runner.ts`. Uses pi's exported `loadSkills()` for resolution — no reimplementation.

**Tech Stack:** TypeScript, node:test, `@earendil-works/pi-coding-agent` (`loadSkills`, `getAgentDir`)

---

### Task 1: Add `skills` to `AgentConfig` type

**Files:**
- Modify: `extensions/subagent/types.ts`

- [ ] **Step 1: Add the optional `skills` field**

```ts
export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string;
  skills?: string[];
  appendSystemPrompt?: boolean;
  systemPrompt: string;
  source?: AgentSource;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no existing code references `skills` yet)

- [ ] **Step 3: Commit**

```bash
git add extensions/subagent/types.ts
git commit -m "feat: add skills field to AgentConfig type"
```

---

### Task 2: Parse `skills` from agent frontmatter

**Files:**
- Modify: `extensions/subagent/agents.ts`
- Test: `extensions/subagent/agents.test.ts`

- [ ] **Step 1: Write test for parsing skills from frontmatter**

Add to `agents.test.ts`:

```ts
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
```

- [ ] **Step 2: Write test for missing skills field**

Add to `agents.test.ts`:

```ts
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
```

- [ ] **Step 3: Write test for single skill**

Add to `agents.test.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test extensions/subagent/agents.test.ts`
Expected: 3 new tests FAIL (skills is not parsed yet)

- [ ] **Step 5: Implement skills parsing in `parseAgentConfig`**

In `agents.ts`, update the frontmatter type and parsing:

```ts
export function parseAgentConfig(
  filePath: string,
  source?: AgentSource,
): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<{
    description?: string;
    model?: string;
    tools?: string;
    skills?: string;
    appendSystemPrompt?: boolean;
  }>(content);
  const description = frontmatter.description?.trim();
  const systemPrompt = body.trim();
  if (!description) {
    throw new AgentConfigValidationError(
      "missing required description frontmatter",
      filePath,
    );
  }
  if (!systemPrompt) {
    throw new AgentConfigValidationError(
      "missing required prompt body",
      filePath,
    );
  }

  const skills = frontmatter.skills
    ? frontmatter.skills.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  return {
    name: path.basename(filePath, path.extname(filePath)),
    description,
    model: frontmatter.model,
    tools: frontmatter.tools,
    skills,
    appendSystemPrompt: frontmatter.appendSystemPrompt === true,
    systemPrompt,
    ...(source ? { source } : {}),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test extensions/subagent/agents.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add extensions/subagent/agents.ts extensions/subagent/agents.test.ts
git commit -m "feat: parse skills from agent frontmatter"
```

---

### Task 3: Add `validateAgentSkills` function

**Files:**
- Modify: `extensions/subagent/agents.ts`
- Test: `extensions/subagent/agents.test.ts`

- [ ] **Step 1: Write test for validation with all skills found**

Add to `agents.test.ts`:

```ts
import { validateAgentSkills } from "./agents.js";
```

```ts
test("validateAgentSkills returns no warnings when all skills exist", async () => {
  const dir = await makeTempDir();
  const skillDir = path.join(dir, ".pi", "skills", "my-skill");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: my-skill\ndescription: A test skill\n---\n\nSkill content.\n",
  );

  const configs = new Map<string, AgentConfig>([
    ["worker", {
      name: "worker",
      description: "Worker",
      skills: ["my-skill"],
      systemPrompt: "Work.",
    }],
  ]);

  const warnings = validateAgentSkills(configs, dir);
  assert.deepEqual(warnings, []);
});
```

Note: import `AgentConfig` type at the top of the test file if not already available (it's imported via `types.js`).

- [ ] **Step 2: Write test for validation with missing skills**

```ts
test("validateAgentSkills returns warnings for missing skills", async () => {
  const dir = await makeTempDir();

  const configs = new Map<string, AgentConfig>([
    ["worker", {
      name: "worker",
      description: "Worker",
      skills: ["nonexistent"],
      systemPrompt: "Work.",
    }],
  ]);

  const warnings = validateAgentSkills(configs, dir);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Agent 'worker'/);
  assert.match(warnings[0], /nonexistent/);
});
```

- [ ] **Step 3: Write test that agents without skills produce no warnings**

```ts
test("validateAgentSkills skips agents without skills defined", async () => {
  const dir = await makeTempDir();

  const configs = new Map<string, AgentConfig>([
    ["scout", {
      name: "scout",
      description: "Scout",
      systemPrompt: "Explore.",
    }],
  ]);

  const warnings = validateAgentSkills(configs, dir);
  assert.deepEqual(warnings, []);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test extensions/subagent/agents.test.ts`
Expected: 3 new tests FAIL (`validateAgentSkills` doesn't exist yet)

- [ ] **Step 5: Implement `validateAgentSkills`**

Add to `agents.ts`:

```ts
import { loadSkills, getAgentDir } from "@earendil-works/pi-coding-agent";

export function validateAgentSkills(
  configs: Map<string, AgentConfig>,
  cwd: string,
): string[] {
  const { skills: discovered } = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: [],
    includeDefaults: true,
  });
  const availableNames = new Set(discovered.map((s) => s.name));
  const warnings: string[] = [];

  for (const [, config] of configs) {
    if (!config.skills) continue;
    const missing = config.skills.filter((name) => !availableNames.has(name));
    if (missing.length > 0) {
      warnings.push(`Agent '${config.name}': unknown skills: ${missing.join(", ")}`);
    }
  }

  return warnings;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test extensions/subagent/agents.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add extensions/subagent/agents.ts extensions/subagent/agents.test.ts
git commit -m "feat: add validateAgentSkills for startup warnings"
```

---

### Task 4: Add skill resolution and `--skill` flags to runner

**Files:**
- Modify: `extensions/subagent/runner.ts`
- Test: `extensions/subagent/runner.test.ts`

- [ ] **Step 1: Write test for `buildPiArgs` with skill paths**

Add to `runner.test.ts`:

```ts
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
```

- [ ] **Step 2: Write test for `buildPiArgs` with empty skill paths (exclusive mode, no skills)**

```ts
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
```

- [ ] **Step 3: Write test for `buildPiArgs` without skill paths (auto-discovery mode)**

```ts
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

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
  ]);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test extensions/subagent/runner.test.ts`
Expected: Tests FAIL (signature mismatch — `buildPiArgs` doesn't accept 4th param yet)

- [ ] **Step 5: Add `skillPaths` parameter to `buildPiArgs`**

Update `buildPiArgs` in `runner.ts`:

```ts
export function buildPiArgs(
  config: AgentConfig,
  resolvedModel: string | undefined,
  systemPromptPath: string | undefined,
  skillPaths?: string[],
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (resolvedModel) args.push("--model", resolvedModel);
  if (config.tools) {
    args.push("--tools", config.tools);
  }
  if (systemPromptPath) {
    args.push(
      config.appendSystemPrompt ? "--append-system-prompt" : "--system-prompt",
      systemPromptPath,
    );
  }
  if (skillPaths !== undefined) {
    args.push("--no-skills");
    for (const skillPath of skillPaths) {
      args.push("--skill", skillPath);
    }
  }
  return args;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test extensions/subagent/runner.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add extensions/subagent/runner.ts extensions/subagent/runner.test.ts
git commit -m "feat: add --skill flag support to buildPiArgs"
```

---

### Task 5: Add `resolveSkillPaths` and wire into `runSingleAgent`

**Files:**
- Modify: `extensions/subagent/runner.ts`
- Test: `extensions/subagent/runner.test.ts`

- [ ] **Step 1: Write test for `resolveSkillPaths` with valid skills**

Add to `runner.test.ts`:

```ts
import { resolveSkillPaths } from "./runner.js";
```

```ts
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
```

Add needed imports at the top of the test file:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "node:test";
```

Add temp dir helper (same pattern as `agents.test.ts`):

```ts
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
```

- [ ] **Step 2: Write test for `resolveSkillPaths` with missing skills**

```ts
test("resolveSkillPaths reports missing skill names", async () => {
  const dir = await makeTempDir();

  const result = resolveSkillPaths(["nonexistent"], dir);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.missing, ["nonexistent"]);
});
```

- [ ] **Step 3: Write test for `resolveSkillPaths` with mix of found and missing**

```ts
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test extensions/subagent/runner.test.ts`
Expected: 3 new tests FAIL (`resolveSkillPaths` doesn't exist)

- [ ] **Step 5: Implement `resolveSkillPaths`**

Add to `runner.ts`:

```ts
import { loadSkills, getAgentDir } from "@earendil-works/pi-coding-agent";

export function resolveSkillPaths(
  skillNames: string[],
  cwd: string,
): { resolved: Array<{ name: string; path: string }>; missing: string[] } {
  const { skills: discovered } = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: [],
    includeDefaults: true,
  });
  const skillMap = new Map(discovered.map((s) => [s.name, s.filePath]));

  const resolved: Array<{ name: string; path: string }> = [];
  const missing: string[] = [];

  for (const name of skillNames) {
    const filePath = skillMap.get(name);
    if (filePath) {
      resolved.push({ name, path: filePath });
    } else {
      missing.push(name);
    }
  }

  return { resolved, missing };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test extensions/subagent/runner.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Wire `resolveSkillPaths` into `runSingleAgent`**

In `runSingleAgent`, after resolving the model and before building args, add skill resolution:

```ts
    // Resolve skill paths if skills are configured
    let skillPaths: string[] | undefined;
    if (config.skills) {
      const cwd = process.cwd();
      const result = resolveSkillPaths(config.skills, cwd);
      if (result.missing.length > 0) {
        throw new Error(
          `Agent '${config.name}': unknown skills: ${result.missing.join(", ")}`,
        );
      }
      skillPaths = result.resolved.map((s) => s.path);
    }
```

Then update the `buildPiArgs` call to pass `skillPaths`:

```ts
    const args = buildPiArgs(config, resolvedModel, tmpPromptPath ?? undefined, skillPaths);
```

- [ ] **Step 8: Run all tests**

Run: `npx tsx --test extensions/subagent/runner.test.ts`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add extensions/subagent/runner.ts extensions/subagent/runner.test.ts
git commit -m "feat: resolve skill names and pass --skill flags to child pi"
```

---

### Task 6: Add startup validation in `index.ts`

**Files:**
- Modify: `extensions/subagent/index.ts`

- [ ] **Step 1: Import `validateAgentSkills`**

Add to imports in `index.ts`:

```ts
import {
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getDefaultAgentsDir,
  loadMergedAgentConfigsWithDiagnostics,
  validateAgentSkills,
} from "./agents.js";
```

- [ ] **Step 2: Add skill validation in the `session_start` handler**

Update the `session_start` handler to also validate skills:

```ts
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;

    if (agentConfigLoadResult.invalidFiles.length > 0) {
      const warning = formatInvalidAgentFilesWarning(
        agentConfigLoadResult.invalidFiles,
      );
      ctx.ui.notify(warning, "warning");
    }

    const skillWarnings = validateAgentSkills(agentConfigs, process.cwd());
    for (const warning of skillWarnings) {
      ctx.ui.notify(warning, "warning");
    }
  });
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `npx tsx --test extensions/subagent/*.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/subagent/index.ts
git commit -m "feat: validate agent skills at startup and warn on missing"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Run full test suite**

Run: `npx tsx --test extensions/subagent/*.test.ts`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run linter**

Run: `npm run lint:check`
Expected: PASS

- [ ] **Step 4: Manual smoke test — create a test agent with skills**

Create `.pi/agents/test-skilled.md`:

```markdown
---
description: Test agent with skills
skills: commit
---

You are a test agent with the commit skill loaded.
```

Start pi and run: `Use test-skilled to summarize the commit skill`

Verify the child pi output shows the skill was loaded (the agent should see the skill in its available skills list).

- [ ] **Step 5: Clean up test agent**

Remove `.pi/agents/test-skilled.md`.

- [ ] **Step 6: Final commit if any lint fixes were needed**

```bash
git add -A
git commit -m "chore: final cleanup for skills support"
```
