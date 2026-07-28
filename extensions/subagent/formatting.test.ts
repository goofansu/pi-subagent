import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatHarnessBadge,
  formatResumeHint,
  formatTokens,
  formatToolCall,
  formatUsageStats,
} from "./formatting.ts";
import type { ThemeForeground, UsageStats } from "./types.ts";

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

test("formatToolCall renders Claude Code's capitalized tool names", () => {
  // Backends name the same tools differently; without case-insensitive
  // matching every Claude tool call falls back to a raw JSON preview.
  const plain: ThemeForeground = (_color, text) => text;

  assert.equal(
    formatToolCall("Read", { file_path: "/a.ts" }, plain),
    "read /a.ts",
  );
  assert.equal(
    formatToolCall("Bash", { command: "ls -la" }, plain),
    "$ ls -la",
  );
  assert.equal(
    formatToolCall("Grep", { pattern: "foo", path: "/src" }, plain),
    "grep /foo/ in /src",
  );
  assert.equal(
    formatToolCall("Glob", { pattern: "*.ts", path: "/src" }, plain),
    "find *.ts in /src",
  );
});

test("formatToolCall keeps the original casing for an unknown tool", () => {
  const plain: ThemeForeground = (_color, text) => text;

  assert.match(formatToolCall("TodoWrite", { todos: [] }, plain), /^TodoWrite/);
});

test("formatHarnessBadge tags a non-default harness and leaves pi bare", () => {
  const plain: ThemeForeground = (_color, text) => text;

  assert.equal(formatHarnessBadge("pi", plain), "");
  assert.equal(formatHarnessBadge("claude", plain), " [claude]");
});

test("formatResumeHint gives a bare command when already in the subagent's directory", () => {
  assert.equal(
    formatResumeHint(
      { harness: "claude", sessionId: "abc-123", cwd: "/repo" },
      "/repo",
      "claude",
    ),
    "claude -r abc-123",
  );
});

test("formatResumeHint includes the directory hop when elsewhere", () => {
  // Claude Code resolves sessions per project directory, so `claude -r` finds
  // nothing unless it runs where the subagent ran.
  assert.equal(
    formatResumeHint(
      { harness: "claude", sessionId: "abc-123", cwd: "/repo" },
      "/somewhere/else",
      "claude",
    ),
    "(cd /repo && claude -r abc-123)",
  );
});

test("formatResumeHint quotes a directory the shell would mangle", () => {
  assert.equal(
    formatResumeHint(
      { harness: "claude", sessionId: "abc-123", cwd: "/tmp/my project" },
      "/somewhere/else",
      "claude",
    ),
    "(cd '/tmp/my project' && claude -r abc-123)",
  );
});

test("formatResumeHint uses the bundled binary when claude is not on PATH", () => {
  // Neither the SDK nor its platform package declares an npm `bin`, so a setup
  // can run claude subagents with no `claude` command anywhere. A hint that
  // assumed one would only ever print "command not found".
  assert.equal(
    formatResumeHint(
      { harness: "claude", sessionId: "abc-123", cwd: "/repo" },
      "/repo",
      "/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
    ),
    "/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude -r abc-123",
  );
});

test("formatResumeHint quotes an executable path the shell would mangle", () => {
  assert.equal(
    formatResumeHint(
      { harness: "claude", sessionId: "abc-123", cwd: "/repo" },
      "/repo",
      "/opt/my tools/claude",
    ),
    "'/opt/my tools/claude' -r abc-123",
  );
});

test("formatResumeHint is absent when there is no session to resume", () => {
  // pi runs with --no-session, and a claude run that died before init has no id.
  assert.equal(
    formatResumeHint(
      { harness: "pi", sessionId: "abc", cwd: "/repo" },
      "/repo",
    ),
    undefined,
  );
  assert.equal(
    formatResumeHint({ harness: "claude", cwd: "/repo" }, "/repo"),
    undefined,
  );
});

test("formatUsageStats withholds an output count the run never reported", () => {
  // A run cut short never delivers the result frame carrying its real totals,
  // and the per-frame `output_tokens` accumulated in the meantime is a
  // placeholder — 4 against a true 667 in one measured run. Printing it in the
  // same shape as an exact figure asserts a number the wire never gave.
  assert.equal(
    formatUsageStats(
      usage({
        turns: 6,
        input: 12,
        output: 186,
        cacheRead: 130013,
        cacheWrite: 31067,
        contextTokens: 44559,
        outputUnreported: true,
      }),
      "claude-sonnet-5",
    ),
    // Prompt-side counts settle before generation, so they are real — just
    // missing whatever request was in flight. Only ↓ goes.
    "6 turns ↑12 R130k W31k ctx:45k claude-sonnet-5",
  );
});

test("formatUsageStats shows the output count of a run that reported one", () => {
  // The flag is absent on every result written before it existed, and on every
  // run that settled normally, so an omitted flag must keep the old rendering.
  assert.equal(
    formatUsageStats(usage({ turns: 1, output: 667 })),
    "1 turn ↓667",
  );
});
