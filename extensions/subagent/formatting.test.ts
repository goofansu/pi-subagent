import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  COLLAPSED_TOOL_CALL_PREVIEW_WIDTH,
  EXPANDED_TOOL_CALL_PREVIEW_LENGTH,
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

test("formatUsageStats appends configured effort after the model", () => {
  assert.equal(
    formatUsageStats(usage({ turns: 1 }), "openai/gpt-5.6-sol", "high"),
    "1 turn openai/gpt-5.6-sol effort:high",
  );
});

test("formatUsageStats omits effort when it is not configured", () => {
  assert.equal(
    formatUsageStats(usage({ turns: 1 }), "openai/gpt-5.6-sol"),
    "1 turn openai/gpt-5.6-sol",
  );
});

test("formatToolCall shortens home paths for read calls", () => {
  const home = process.env.HOME || "";
  const result = formatToolCall(
    "read",
    { path: `${home}/project/file.ts`, offset: 3, limit: 4 },
    plainFg,
    "collapsed",
  );

  assert.equal(result, "read ~/project/file.ts:3-6");
});

test("formatToolCall renders bash command previews", () => {
  const result = formatToolCall(
    "bash",
    { command: "npm test" },
    plainFg,
    "collapsed",
  );

  assert.equal(result, "$ npm test");
});

test("formatToolCall normalizes collapsed multiline bash commands", () => {
  const result = formatToolCall(
    "bash",
    { command: "printf 'one'\n\n  npm    test\t-- --runInBand" },
    plainFg,
    "collapsed",
  );

  assert.equal(result, "$ printf 'one' npm test -- --runInBand");
});

test("formatToolCall reserves the render arrow within the collapsed width", () => {
  const result = formatToolCall(
    "bash",
    { command: "x".repeat(100) },
    plainFg,
    "collapsed",
  );

  assert.equal(result, `$ ${"x".repeat(67)}…`);
  assert.equal(visibleWidth(result), COLLAPSED_TOOL_CALL_PREVIEW_WIDTH);
  assert.equal(result.split("\n").length, 1);
});

test("formatToolCall applies the collapsed budget in terminal columns", () => {
  const result = formatToolCall(
    "bash",
    { command: "界".repeat(100) },
    plainFg,
    "collapsed",
  );

  assert.ok(visibleWidth(result) <= COLLAPSED_TOOL_CALL_PREVIEW_WIDTH);
  assert.match(result, /…$/);
});

test("formatToolCall preserves readable multiline bash commands when expanded", () => {
  const command = "printf 'one'\n\n  npm    test\t-- --runInBand";

  assert.equal(
    formatToolCall("bash", { command }, plainFg, "expanded"),
    `$ ${command}`,
  );
});

test("formatToolCall explicitly truncates unusually large expanded commands", () => {
  const result = formatToolCall(
    "bash",
    { command: "x".repeat(EXPANDED_TOOL_CALL_PREVIEW_LENGTH + 100) },
    plainFg,
    "expanded",
  );

  assert.equal(result.length, EXPANDED_TOOL_CALL_PREVIEW_LENGTH);
  assert.match(result, /\n… \[truncated\]$/);
});

test("formatToolCall truncates without splitting surrogate pairs", () => {
  const marker = "\n… [truncated]";
  const availableCommandUnits =
    EXPANDED_TOOL_CALL_PREVIEW_LENGTH - marker.length - "$ ".length;
  const command = `${"x".repeat(availableCommandUnits - 1)}😀${"t".repeat(20)}`;
  const expanded = formatToolCall("bash", { command }, plainFg, "expanded");
  const collapsed = formatToolCall(
    "bash",
    { command: `${"x".repeat(66)}😀tail` },
    plainFg,
    "collapsed",
  );

  assert.equal(expanded.length, EXPANDED_TOOL_CALL_PREVIEW_LENGTH - 1);
  assert.match(expanded, /x\n… \[truncated\]$/);
  assert.equal(hasUnpairedSurrogate(expanded), false);
  assert.equal(hasUnpairedSurrogate(collapsed), false);
});

test("formatToolCall renders Claude Code's capitalized tool names", () => {
  // Backends name the same tools differently; without case-insensitive
  // matching every Claude tool call falls back to a raw JSON preview.
  const plain: ThemeForeground = (_color, text) => text;

  assert.equal(
    formatToolCall("Read", { file_path: "/a.ts" }, plain, "collapsed"),
    "read /a.ts",
  );
  assert.equal(
    formatToolCall("Bash", { command: "ls -la" }, plain, "collapsed"),
    "$ ls -la",
  );
  assert.equal(
    formatToolCall(
      "Grep",
      { pattern: "foo", path: "/src" },
      plain,
      "collapsed",
    ),
    "grep /foo/ in /src",
  );
  assert.equal(
    formatToolCall(
      "Glob",
      { pattern: "*.ts", path: "/src" },
      plain,
      "collapsed",
    ),
    "find *.ts in /src",
  );
});

test("formatToolCall keeps the original casing for an unknown tool", () => {
  const plain: ThemeForeground = (_color, text) => text;

  assert.equal(
    formatToolCall("CustomTool", { value: "ok" }, plain, "collapsed"),
    'CustomTool {"value":"ok"}',
  );
});

test("formatToolCall keeps collapsed high-volume summaries count-focused", () => {
  assert.equal(
    formatToolCall(
      "TodoWrite",
      {
        todos: [
          { content: "one", status: "completed" },
          { content: "two", status: "pending" },
        ],
      },
      plainFg,
      "collapsed",
    ),
    "TodoWrite (2 todos)",
  );
  assert.equal(
    formatToolCall(
      "apply_patch",
      { changes: [{ path: "/a.ts" }] },
      plainFg,
      "collapsed",
    ),
    "apply_patch (1 change)",
  );
});

test("formatToolCall adds concise todo and changed-path detail when expanded", () => {
  assert.equal(
    formatToolCall(
      "TodoWrite",
      {
        todos: [
          {
            content: "fix  spaced\nsummary",
            status: "completed",
            activeForm: "fixing",
          },
          { content: "run tests", status: "pending" },
        ],
      },
      plainFg,
      "expanded",
    ),
    "TodoWrite (2 todos: [x] fix  spaced summary; [ ] run tests)",
  );
  assert.equal(
    formatToolCall(
      "apply_patch",
      {
        changes: [
          { path: "/src/a  b.ts" },
          { path: "/src/c\n.ts" },
          { path: 42 },
        ],
      },
      plainFg,
      "expanded",
    ),
    "apply_patch (3 changes: /src/a  b.ts, /src/c .ts)",
  );
});

test("formatToolCall preserves ordinary spaces in paths and grep patterns", () => {
  assert.equal(
    formatToolCall("read", { path: "/src/a  b\nc.ts" }, plainFg, "expanded"),
    "read /src/a  b c.ts",
  );
  assert.equal(
    formatToolCall(
      "grep",
      { pattern: "one  two\tthree", path: "/src/a  b" },
      plainFg,
      "collapsed",
    ),
    "grep /one  two three/ in /src/a  b",
  );
});

test("formatToolCall handles non-string paths and uses a valid alternate path", () => {
  assert.equal(
    formatToolCall(
      "read",
      { file_path: 42, path: "/valid.ts", offset: "2\n3" },
      plainFg,
      "expanded",
    ),
    "read /valid.ts",
  );
  assert.equal(
    formatToolCall("edit", { path: { nested: true } }, plainFg, "expanded"),
    "edit ...",
  );
});

test("formatToolCall sanitizes expanded tool names and inline fragments", () => {
  const result = formatToolCall(
    "Custom\n Tool",
    { prompt: "first\nsecond" },
    plainFg,
    "expanded",
  );

  assert.equal(result, 'Custom  Tool {"prompt":"first second"}');
  assert.equal(result.includes("\n"), false);
});

test("formatToolCall preserves ordinary spaces in collapsed generic arguments", () => {
  assert.equal(
    formatToolCall(
      "Custom\n Tool",
      { prompt: "first\n\n  second   third" },
      plainFg,
      "collapsed",
    ),
    'Custom  Tool {"prompt":"first   second   third"}',
  );
});

test("formatToolCall falls through when structured summary args are absent", () => {
  assert.equal(
    formatToolCall("TodoWrite", { todos: "not an array" }, plainFg, "expanded"),
    'TodoWrite {"todos":"not an array"}',
  );
  assert.equal(
    formatToolCall("apply_patch", { changes: null }, plainFg, "expanded"),
    'apply_patch {"changes":null}',
  );
});

test("formatToolCall handles circular and otherwise unserializable arguments", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.equal(
    formatToolCall("CustomTool", circular, plainFg, "collapsed"),
    "CustomTool [unserializable arguments]",
  );
  assert.equal(
    formatToolCall("CustomTool", { value: 1n }, plainFg, "expanded"),
    "CustomTool [unserializable arguments]",
  );
});

test("formatToolCall bounds large generic arguments in expanded view", () => {
  const result = formatToolCall(
    "CustomTool",
    { payload: "x".repeat(EXPANDED_TOOL_CALL_PREVIEW_LENGTH + 100) },
    plainFg,
    "expanded",
  );

  assert.equal(result.length, EXPANDED_TOOL_CALL_PREVIEW_LENGTH);
  assert.match(result, /^CustomTool \{"payload":"x+/);
  assert.match(result, /\n… \[truncated\]$/);
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

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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

test("formatResumeHint reopens a Codex thread", () => {
  assert.equal(
    formatResumeHint(
      { harness: "codex", sessionId: "thread-123", cwd: "/repo" },
      "/repo",
      "codex",
    ),
    "codex resume thread-123",
  );
  assert.equal(
    formatResumeHint(
      { harness: "codex", sessionId: "thread-123", cwd: "/repo" },
      "/elsewhere",
      "/opt/Codex CLI/codex",
    ),
    "(cd /repo && '/opt/Codex CLI/codex' resume thread-123)",
  );
});

test("formatResumeHint is absent when there is no session to resume", () => {
  // pi runs with --no-session, and an external harness can die before init.
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
