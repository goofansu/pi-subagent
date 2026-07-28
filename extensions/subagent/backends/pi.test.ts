/**
 * Pi-backend tests for the pieces added by the multi-backend work. The original
 * argument-building and event-folding coverage lives in ../runner.test.ts, which
 * exercises the same functions through the re-exports.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createEmptyResult } from "../backend.ts";
import type { AgentConfig } from "../types.ts";
import { piBackend, resolveSubagentModel, splitThinkingSuffix } from "./pi.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Worker",
    systemPrompt: "Work.",
    ...overrides,
  };
}

test("splitThinkingSuffix separates a trailing thinking level", () => {
  assert.deepEqual(splitThinkingSuffix("openai-codex/gpt-5.5:high"), [
    "openai-codex/gpt-5.5",
    "high",
  ]);
});

test("splitThinkingSuffix leaves a model with no level alone", () => {
  assert.deepEqual(splitThinkingSuffix("anthropic/claude-opus-4-5"), [
    "anthropic/claude-opus-4-5",
    undefined,
  ]);
});

test("splitThinkingSuffix ignores a colon that sits before the provider slash", () => {
  assert.deepEqual(splitThinkingSuffix("http://host/model"), [
    "http://host/model",
    undefined,
  ]);
});

test("splitThinkingSuffix keeps a colon that belongs to the model id", () => {
  // Bedrock ids carry a `:<version>` suffix that is part of the id, not a level.
  assert.deepEqual(
    splitThinkingSuffix("amazon-bedrock/anthropic.claude-opus-4-5-v1:0"),
    ["amazon-bedrock/anthropic.claude-opus-4-5-v1:0", undefined],
  );
});

test("resolveSubagentModel keeps a versioned id intact when adding a level", () => {
  assert.equal(
    resolveSubagentModel(
      agent({
        model: "amazon-bedrock/anthropic.claude-opus-4-5-v1:0",
        reasoningEffort: "high",
      }),
      undefined,
    ),
    "amazon-bedrock/anthropic.claude-opus-4-5-v1:0:high",
  );
});

test("resolveSubagentModel applies reasoningEffort as the thinking level", () => {
  assert.equal(
    resolveSubagentModel(
      agent({ model: "openai-codex/gpt-5.5", reasoningEffort: "high" }),
      undefined,
    ),
    "openai-codex/gpt-5.5:high",
  );
});

test("resolveSubagentModel lets reasoningEffort override a level in the model string", () => {
  assert.equal(
    resolveSubagentModel(
      agent({ model: "openai-codex/gpt-5.5:low", reasoningEffort: "xhigh" }),
      undefined,
    ),
    "openai-codex/gpt-5.5:xhigh",
  );
});

test("resolveSubagentModel applies reasoningEffort to an inherited model", () => {
  assert.equal(
    resolveSubagentModel(agent({ reasoningEffort: "medium" }), {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "low",
    }),
    "anthropic/claude-opus-4-5:medium",
  );
});

test("resolveSubagentModel keeps inheriting the parent thinking level without reasoningEffort", () => {
  assert.equal(
    resolveSubagentModel(agent(), {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "low",
    }),
    "anthropic/claude-opus-4-5:low",
  );
});

/**
 * Put a stand-in `pi` on PATH so the backend's real spawn path runs without a
 * pi install. Returns a restore function.
 */
function shadowPiBinary(script: string): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bin-"));
  fs.writeFileSync(path.join(dir, "pi"), script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("pi backend settles a cancelled run instead of rejecting", async () => {
  // The backend contract: cancellation is a resolved result. Rejecting would
  // strip `details` on the way through the host and take the partial transcript
  // with it, so this asserts the resolution rather than a throw.
  const shadow = shadowPiBinary("#!/bin/sh\nsleep 30\n");
  const controller = new AbortController();

  try {
    const result = createEmptyResult("worker", "Work", "pi");
    const run = piBackend.run({
      task: {
        config: agent(),
        description: "Work",
        prompt: "do it",
        cwd: os.tmpdir(),
        agentDir: os.tmpdir(),
        configCwd: os.tmpdir(),
        depth: 0,
      },
      result,
      emit: () => {},
      signal: controller.signal,
    });

    // Let the child get going, then cancel it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();

    const settled = await run;
    assert.equal(settled.exitCode, 1);
    assert.equal(settled.stopReason, "aborted");
    assert.match(settled.errorMessage ?? "", /Subagent was aborted/);
  } finally {
    shadow.restore();
  }
});
