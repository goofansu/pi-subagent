import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentDelivery } from "./delivery.ts";
import type { Harness } from "./harness.ts";
import { createHarnessRegistry } from "./harness.ts";
import { formatNotification } from "./presentation.ts";
import { startSubagent } from "./runner.ts";
import { createSubagentRuns } from "./runs.ts";
import type { AgentConfig } from "./types.ts";
import { renderRunLines } from "./widget.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const profile: AgentConfig = {
  name: "fake",
  description: "fake",
  harness: "fake",
  fields: {},
  systemPrompt: "work",
};

function fakeHarness(
  onRun: (signal: AbortSignal | undefined) => Promise<void>,
): Harness {
  return {
    name: "fake",
    validate: () => [],
    prepare: () => ({
      execute: async (run) => {
        await onRun(run.signal);
        return run.signal?.aborted
          ? { stopReason: "aborted" }
          : { exitCode: 0 };
      },
    }),
  };
}

test("a fake harness reaches dispatcher, registry, delivery, presentation, and widget", async () => {
  const runs = createSubagentRuns();
  const pushed: string[] = [];
  const delivery = createSubagentDelivery({
    runs,
    push: (notification) => pushed.push(notification.text),
  });
  const harness = fakeHarness(async (signal) => {
    assert.equal(signal?.aborted, false);
  });
  const started = startSubagent({
    config: profile,
    description: "core seam",
    prompt: "go",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  delivery.register(started.id, started.settled);
  const result = await started.settled;
  await delivery.wait([started.id]);

  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(runs.list()[0]?.status, "completed");
  assert.match(pushed[0] ?? "", /completed/);
  assert.match(formatNotification(started.id, result), /completed/);
  assert.match(
    renderRunLines(runs.list(), plainTheme, 120).join("\\n"),
    /completed/,
  );
  assert.equal(delivery.result(started.id)?.status, "completed");
});

test("a fake harness runs the core seam without a backend dependency", async () => {
  const runs = createSubagentRuns();
  const harness = fakeHarness(async (signal) => {
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const started = startSubagent({
    config: profile,
    description: "test",
    prompt: "go",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  runs.cancel([started.id], "requested");
  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "cancelled");
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "requested");
  }
});

test("a Codex-like harness compiles and runs through the unchanged one-shot core", async () => {
  const codex: Harness = {
    name: "codex",
    validate: () => [],
    prepare: () => ({
      execute: async (run) => {
        run.report.message({
          role: "assistant",
          parts: [{ type: "text", text: "codex fixture" }],
        });
        return { exitCode: 0, stopReason: "stop" };
      },
    }),
  };
  const started = startSubagent({
    config: { ...profile, harness: "codex" },
    description: "codex fixture",
    prompt: "go",
    harnesses: createHarnessRegistry([codex]),
    runs: createSubagentRuns(),
  });

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.messages[0]?.parts[0]?.type, "text");
});
