import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTokens,
  formatToolCall,
  formatUsageStats,
} from "./formatting.js";
import type { UsageStats } from "./types.js";

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
