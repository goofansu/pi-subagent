import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPiArgs } from "./runner.js";

test("buildPiArgs passes configured tools directly to pi", () => {
  const args = buildPiArgs(
    {
      name: "explore",
      description: "Explore code",
      tools: "read,grep,find,ls,bash",
      systemPrompt: "Search only.",
    },
    "anthropic/claude",
    "/tmp/prompt.md",
    "Find parser",
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    "anthropic/claude",
    "--tools",
    "read,grep,find,ls,bash",
    "--append-system-prompt",
    "/tmp/prompt.md",
    "Find parser",
  ]);
});
