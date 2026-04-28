# Subagent Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the subagent extension into maintainable modules and add focused tests for extracted pure behavior.

**Architecture:** Split the current monolithic `extensions/subagent/index.ts` by responsibility. `index.ts` only registers commands/tools, pure helpers live in tested modules, rendering is isolated from runner/process execution, and agent config loading is exported from `agents.ts`.

**Tech Stack:** TypeScript ES modules, Node.js built-in `node:test`, `node:assert/strict`, existing `tsx` test runner, Biome, pi extension APIs.

---

## File Structure

- Create `extensions/subagent/types.ts`: shared TypeScript interfaces and callback aliases.
- Create `extensions/subagent/formatting.ts`: `formatTokens`, `formatUsageStats`, `formatToolCall`.
- Create `extensions/subagent/messages.ts`: `getFinalOutput`, `getDisplayItems`.
- Create `extensions/subagent/agents.ts`: `parseAgentConfig`, `getDefaultAgentsDir`, `loadAgentConfigs`.
- Create `extensions/subagent/runner.ts`: prompt temp-file writing, pi invocation, `runSingleAgent`.
- Create `extensions/subagent/render.ts`: `renderCall`, `renderResult`.
- Modify `extensions/subagent/index.ts`: extension registration and wiring only.
- Create tests:
  - `extensions/subagent/formatting.test.ts`
  - `extensions/subagent/messages.test.ts`
  - `extensions/subagent/agents.test.ts`

## Task 1: Extract and test formatting helpers

**Files:**
- Create: `extensions/subagent/formatting.test.ts`
- Create: `extensions/subagent/types.ts`
- Create: `extensions/subagent/formatting.ts`
- Modify: `extensions/subagent/index.ts`

- [ ] **Step 1: Write failing tests for formatting helpers**

Create `extensions/subagent/formatting.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokens, formatToolCall, formatUsageStats } from "./formatting.ts";
import type { UsageStats } from "./types.ts";

const plainFg = (_color: unknown, text: string) => text;

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...overrides,
  };
}

test("formatTokens renders compact token counts", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1200), "1.2k");
  assert.equal(formatTokens(12500), "13k");
  assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatUsageStats includes only non-zero usage parts and model", () => {
  assert.equal(
    formatUsageStats(
      usage({
        turns: 2,
        input: 1200,
        output: 99,
        cacheRead: 3000,
        cacheWrite: 4000,
        cost: 0.12345,
        contextTokens: 4567,
      }),
      "anthropic/claude",
    ),
    "2 turns ↑1.2k ↓99 R3.0k W4.0k $0.1235 ctx:4.6k anthropic/claude",
  );
});

test("formatToolCall shortens home paths for read calls", () => {
  const home = process.env.HOME || "";
  const result = formatToolCall(
    "read",
    { path: `${home}/project/file.ts`, offset: 3, limit: 4 },
    plainFg,
  );

  assert.equal(result, "read ~/project/file.ts:3-6");
});

test("formatToolCall renders bash command previews", () => {
  const result = formatToolCall("bash", { command: "npm test" }, plainFg);

  assert.equal(result, "$ npm test");
});
```

- [ ] **Step 2: Run formatting tests to verify RED**

Run:

```bash
npm test -- extensions/subagent/formatting.test.ts
```

Expected: FAIL because `extensions/subagent/formatting.ts` and `extensions/subagent/types.ts` do not exist.

- [ ] **Step 3: Create shared types and formatting implementation**

Create `extensions/subagent/types.ts`:

```ts
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  description: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  results: SingleResult[];
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  systemPrompt: string;
}

export type OnUpdateCallback = (
  partial: AgentToolResult<SubagentDetails>,
) => void;

export type ThemeForeground = (color: unknown, text: string) => string;
```

Create `extensions/subagent/formatting.ts`:

```ts
import * as os from "node:os";
import type { ThemeForeground, UsageStats } from "./types.ts";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: ThemeForeground,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview =
        command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg(
          "warning",
          `:${startLine}${endLine ? `-${endLine}` : ""}`,
        );
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview =
        argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}
```

Remove the duplicated type declarations and formatting functions from `extensions/subagent/index.ts`, then import the needed symbols from `./formatting.ts` and `./types.ts` until later tasks move more code.

- [ ] **Step 4: Run formatting tests to verify GREEN**

Run:

```bash
npm test -- extensions/subagent/formatting.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit formatting extraction**

Run:

```bash
git add extensions/subagent/index.ts extensions/subagent/types.ts extensions/subagent/formatting.ts extensions/subagent/formatting.test.ts
git commit -m "refactor(subagent): extract formatting helpers"
```

## Task 2: Extract and test message helpers

**Files:**
- Create: `extensions/subagent/messages.test.ts`
- Create: `extensions/subagent/messages.ts`
- Modify: `extensions/subagent/index.ts`

- [ ] **Step 1: Write failing tests for message helpers**

Create `extensions/subagent/messages.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@mariozechner/pi-ai";
import { getDisplayItems, getFinalOutput } from "./messages.ts";

const assistantMessage = (content: Message["content"]): Message =>
  ({ role: "assistant", content }) as Message;

const userMessage = (content: Message["content"]): Message =>
  ({ role: "user", content }) as Message;

test("getFinalOutput returns the last assistant text part", () => {
  const messages = [
    assistantMessage([{ type: "text", text: "first" }]),
    userMessage([{ type: "text", text: "ignored" }]),
    assistantMessage([{ type: "text", text: "final" }]),
  ];

  assert.equal(getFinalOutput(messages), "final");
});

test("getFinalOutput returns an empty string when no assistant text exists", () => {
  assert.equal(getFinalOutput([userMessage([{ type: "text", text: "hello" }])]), "");
});

test("getDisplayItems extracts assistant text and tool calls in order", () => {
  const messages = [
    userMessage([{ type: "text", text: "ignored" }]),
    assistantMessage([
      { type: "text", text: "thinking" },
      { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
    ]),
  ];

  assert.deepEqual(getDisplayItems(messages), [
    { type: "text", text: "thinking" },
    { type: "toolCall", name: "bash", args: { command: "npm test" } },
  ]);
});
```

- [ ] **Step 2: Run message tests to verify RED**

Run:

```bash
npm test -- extensions/subagent/messages.test.ts
```

Expected: FAIL because `extensions/subagent/messages.ts` does not exist.

- [ ] **Step 3: Create message helper implementation**

Create `extensions/subagent/messages.ts`:

```ts
import type { Message } from "@mariozechner/pi-ai";
import type { DisplayItem } from "./types.ts";

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({
            type: "toolCall",
            name: part.name,
            args: part.arguments,
          });
      }
    }
  }
  return items;
}
```

Remove `getFinalOutput` and `getDisplayItems` from `extensions/subagent/index.ts`, then import them from `./messages.ts`.

- [ ] **Step 4: Run message tests to verify GREEN**

Run:

```bash
npm test -- extensions/subagent/messages.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit message extraction**

Run:

```bash
git add extensions/subagent/index.ts extensions/subagent/messages.ts extensions/subagent/messages.test.ts extensions/subagent/types.ts
git commit -m "refactor(subagent): extract message helpers"
```

## Task 3: Extract and test agent config loading

**Files:**
- Create: `extensions/subagent/agents.test.ts`
- Create: `extensions/subagent/agents.ts`
- Modify: `extensions/subagent/index.ts`

- [ ] **Step 1: Write failing tests for agent config parsing and loading**

Create `extensions/subagent/agents.test.ts`:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { loadAgentConfigs, parseAgentConfig } from "./agents.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

test("parseAgentConfig reads name, frontmatter, and system prompt", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\nmodel: inherit\n---\n\nYou review code.\n",
  );

  assert.deepEqual(parseAgentConfig(filePath), {
    name: "reviewer",
    description: "Reviews code",
    model: "inherit",
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
  const configs = loadAgentConfigs(path.join(os.tmpdir(), "missing-pi-subagent-agents"));

  assert.equal(configs.size, 0);
});
```

- [ ] **Step 2: Run agent tests to verify RED**

Run:

```bash
npm test -- extensions/subagent/agents.test.ts
```

Expected: FAIL because `extensions/subagent/agents.ts` does not exist.

- [ ] **Step 3: Create agents implementation**

Create `extensions/subagent/agents.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./types.ts";

export function parseAgentConfig(filePath: string): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<{
    description?: string;
    model?: string;
  }>(content);
  return {
    name: path.basename(filePath, path.extname(filePath)),
    description: frontmatter.description ?? "",
    model: frontmatter.model,
    systemPrompt: body.trim(),
  };
}

export function getDefaultAgentsDir(moduleUrl: string): string {
  return path.join(path.dirname(new URL(moduleUrl).pathname), "../../agents");
}

export function loadAgentConfigs(agentsDir: string): Map<string, AgentConfig> {
  const agentConfigs = new Map<string, AgentConfig>();
  if (!fs.existsSync(agentsDir)) return agentConfigs;
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const config = parseAgentConfig(path.join(agentsDir, file));
    agentConfigs.set(config.name, config);
  }
  return agentConfigs;
}
```

Remove `AgentConfig`, `parseAgentConfig`, and `loadAgentConfigs` from `extensions/subagent/index.ts`. Import `getDefaultAgentsDir` and `loadAgentConfigs` from `./agents.ts`, then initialize configs with:

```ts
const agentConfigs = loadAgentConfigs(getDefaultAgentsDir(import.meta.url));
```

- [ ] **Step 4: Run agent tests to verify GREEN**

Run:

```bash
npm test -- extensions/subagent/agents.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full current test set**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit agents extraction**

Run:

```bash
git add extensions/subagent/index.ts extensions/subagent/agents.ts extensions/subagent/agents.test.ts extensions/subagent/types.ts
git commit -m "refactor(subagent): extract agent loading"
```

## Task 4: Extract runner

**Files:**
- Create: `extensions/subagent/runner.ts`
- Modify: `extensions/subagent/index.ts`

- [ ] **Step 1: Move runner implementation without behavior changes**

Create `extensions/subagent/runner.ts` with the existing `getPiInvocation`, `writePromptToTempFile`, and `runSingleAgent` logic moved from `index.ts`. Export all three functions:

```ts
export function getPiInvocation(args: string[]): { command: string; args: string[] }
export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }>
export async function runSingleAgent(...): Promise<SingleResult>
```

Import required types from `./types.ts` and `getFinalOutput` from `./messages.ts`. Keep the current JSON event parsing, usage accumulation, abort handling, and cleanup exactly equivalent.

- [ ] **Step 2: Wire index to runner**

Remove runner functions from `extensions/subagent/index.ts` and import:

```ts
import { runSingleAgent } from "./runner.ts";
```

Keep `execute()` behavior the same.

- [ ] **Step 3: Run tests and typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 4: Commit runner extraction**

Run:

```bash
git add extensions/subagent/index.ts extensions/subagent/runner.ts
git commit -m "refactor(subagent): extract runner"
```

## Task 5: Extract rendering

**Files:**
- Create: `extensions/subagent/render.ts`
- Modify: `extensions/subagent/index.ts`

- [ ] **Step 1: Move rendering implementation without behavior changes**

Create `extensions/subagent/render.ts`. Export:

```ts
export const COLLAPSED_ITEM_COUNT = 10;
export function renderSubagentCall(args: { agent: string; description: string; prompt: string }, theme: unknown, context: { lastComponent?: unknown }): Text;
export function renderSubagentResult(result: AgentToolResult<SubagentDetails>, options: { expanded: boolean }, theme: unknown, context: unknown): Text | Container;
```

Move the current `renderCall` and `renderResult` bodies from `index.ts` into these functions. Import `getMarkdownTheme` and `keyHint` from `@mariozechner/pi-coding-agent`, `Container`, `Markdown`, `Spacer`, and `Text` from `@mariozechner/pi-tui`, `formatToolCall` and `formatUsageStats` from `./formatting.ts`, `getDisplayItems` and `getFinalOutput` from `./messages.ts`, and `SubagentDetails` from `./types.ts`.

- [ ] **Step 2: Wire index to rendering helpers**

In `extensions/subagent/index.ts`, replace inline rendering methods with:

```ts
renderCall: renderSubagentCall,
renderResult: renderSubagentResult,
```

Import both functions from `./render.ts`.

- [ ] **Step 3: Run tests and typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 4: Commit render extraction**

Run:

```bash
git add extensions/subagent/index.ts extensions/subagent/render.ts
git commit -m "refactor(subagent): extract rendering"
```

## Task 6: Final cleanup and verification

**Files:**
- Modify: `extensions/subagent/index.ts`
- Modify: extracted modules only if needed for lint/type cleanup

- [ ] **Step 1: Review `index.ts` for orchestration-only responsibility**

Ensure `extensions/subagent/index.ts` contains only imports, default extension function, command registration, tool registration, config lookup, and execution result/error handling.

- [ ] **Step 2: Run formatter/linter**

Run:

```bash
npm run lint
```

Expected: PASS. Biome may print schema version info; no errors should remain.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat
git diff -- extensions/subagent/index.ts
```

Expected: `index.ts` is significantly smaller and only wires extracted modules together.

- [ ] **Step 5: Commit final cleanup**

Run:

```bash
git add extensions/subagent
git commit -m "refactor(subagent): simplify extension entrypoint"
```

## Self-Review

- Spec coverage: modules from the design are included, tests cover pure formatting/message/agent helpers, runner and rendering are isolated, and final verification commands are specified.
- Placeholder scan: no TBD/TODO placeholders remain; each test task includes concrete code and commands.
- Type consistency: shared types live in `types.ts`; later modules import the same names defined in Task 1.
