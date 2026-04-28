# User Agent Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load user-defined subagents from Pi's agent directory and let them override bundled `pi-subagent` agents with the same name.

**Architecture:** Keep agent parsing/loading in `extensions/subagent/agents.ts`. Add a merge helper that loads bundled agents first and user agents second so Map insertion by name gives user agents precedence. Wire `extensions/subagent/index.ts` to use `getAgentDir()/agents` as the override directory.

**Tech Stack:** TypeScript, Node.js built-in test runner, `@mariozechner/pi-coding-agent`.

---

## File Structure

- `extensions/subagent/agents.test.ts`: add behavior tests for merged bundled/user agent loading.
- `extensions/subagent/agents.ts`: add `loadMergedAgentConfigs(baseDir, overrideDir)`.
- `extensions/subagent/index.ts`: import `getAgentDir` and `node:path`; initialize agent configs with bundled dir plus user override dir.

### Task 1: Add merged agent loading

**Files:**
- Modify: `extensions/subagent/agents.test.ts`
- Modify: `extensions/subagent/agents.ts`

- [ ] **Step 1: Write failing tests for user override precedence**

Add this import and tests to `extensions/subagent/agents.test.ts`:

```ts
import {
  loadAgentConfigs,
  loadMergedAgentConfigs,
  parseAgentConfig,
} from "./agents.js";
```

```ts
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

  const configs = loadMergedAgentConfigs(
    bundledDir,
    path.join(os.tmpdir(), "missing-pi-subagent-user-agents"),
  );

  assert.equal(configs.size, 1);
  assert.equal(configs.get("general-purpose")?.description, "General");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- extensions/subagent/agents.test.ts
```

Expected: FAIL because `loadMergedAgentConfigs` is not exported.

- [ ] **Step 3: Implement merged loading**

Add to `extensions/subagent/agents.ts` after `loadAgentConfigs`:

```ts
export function loadMergedAgentConfigs(
  baseAgentsDir: string,
  overrideAgentsDir: string,
): Map<string, AgentConfig> {
  return new Map([
    ...loadAgentConfigs(baseAgentsDir),
    ...loadAgentConfigs(overrideAgentsDir),
  ]);
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm test -- extensions/subagent/agents.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit merged loading helper**

```bash
git add extensions/subagent/agents.ts extensions/subagent/agents.test.ts
git commit -m "feat(subagent): merge user agent configs"
```

### Task 2: Wire Pi user agent directory into the extension

**Files:**
- Modify: `extensions/subagent/index.ts`

- [ ] **Step 1: Update extension wiring**

Change imports in `extensions/subagent/index.ts` to:

```ts
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { getDefaultAgentsDir, loadMergedAgentConfigs } from "./agents.js";
```

Change agent config initialization to:

```ts
const agentConfigs = loadMergedAgentConfigs(
  getDefaultAgentsDir(import.meta.url),
  path.join(getAgentDir(), "agents"),
);
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- extensions/subagent/agents.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 4: Commit extension wiring**

```bash
git add extensions/subagent/index.ts
git commit -m "feat(subagent): load user agent overrides"
```
