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
import {
  buildPiArgs,
  piBackend,
  resolveSubagentModel,
  resolveSubagentThinking,
} from "./pi.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Worker",
    systemPrompt: "Work.",
    ...overrides,
  };
}

test("resolveSubagentModel passes a variant-suffixed id through untouched", () => {
  assert.equal(
    resolveSubagentModel(
      agent({ model: "openrouter/google/gemma-4-31b-it:free" }),
      undefined,
    ),
    "openrouter/google/gemma-4-31b-it:free",
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

test("resolveSubagentModel hands pi the model exactly as written", () => {
  for (const model of [
    "openai-codex/gpt-5.5",
    "openrouter/google/gemma-4-31b-it:free",
    "sonnet",
  ]) {
    assert.equal(
      resolveSubagentModel(agent({ model }), undefined),
      model,
      model,
    );
  }
});

test("resolveSubagentModel inherits the caller's model without its level", () => {
  // The level travels separately now, so nothing is spliced into the id.
  assert.equal(
    resolveSubagentModel(agent({ model: "inherit" }), {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "low",
    }),
    "anthropic/claude-opus-4-5",
  );
});

test("resolveSubagentThinking prefers the profile's effort", () => {
  assert.equal(
    resolveSubagentThinking(agent({ model: "sonnet", effort: "high" }), {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "low",
    }),
    "high",
  );
});

test("resolveSubagentThinking inherits the caller's level only with the model", () => {
  const parent = {
    provider: "anthropic",
    id: "claude-opus-4-5",
    thinkingLevel: "low",
  };
  assert.equal(resolveSubagentThinking(agent(), parent), "low");
  assert.equal(
    resolveSubagentThinking(agent({ model: "inherit" }), parent),
    "low",
  );
  // A pinned model with no effort means pi's default, not the caller's level.
  assert.equal(
    resolveSubagentThinking(agent({ model: "sonnet" }), parent),
    undefined,
  );
});

test("buildPiArgs passes the thinking level as its own flag", () => {
  const args = buildPiArgs(agent(), "sonnet", undefined, undefined, "high");

  assert.ok(args.includes("--thinking"));
  assert.equal(args[args.indexOf("--thinking") + 1], "high");
  // And never spliced into the model, which is what made a colon ambiguous.
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
});

test("buildPiArgs omits the thinking flag when no level applies", () => {
  const args = buildPiArgs(agent(), "sonnet", undefined, undefined, undefined);

  assert.equal(args.includes("--thinking"), false);
});
