import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAgentResultUnavailable,
  formatAwaitOutcome,
  formatCancelOutcome,
  formatDuration,
  formatExecutorRejection,
  formatNotification,
  formatNotificationAccounting,
  formatResult,
  formatRunStatus,
  formatStartResult,
  formatUnknownAgent,
  fullOutput,
  NOTIFICATION_PREVIEW_CHARACTER_LIMIT,
  notificationVerb,
  runStatusTone,
} from "./presentation.ts";
import type { Fact } from "./run.ts";
import { createEmptyResult } from "./run.ts";
import type { Tone } from "./types.ts";

function assistantText(text: string): Fact {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

// ── Status words and tones ───────────────────────────────────────────────────

test("formatDuration reports tenths, then minutes, then hours", () => {
  assert.equal(formatDuration(0), "0.0s");
  assert.equal(formatDuration(3_240), "3.2s");
  assert.equal(formatDuration(63_000), "1m 3s");
  assert.equal(formatDuration(3_723_000), "1h 2m");
});

test("formatDuration never reports negative time", () => {
  assert.equal(formatDuration(-500), "0.0s");
});

test("INV-10: presentation observes lifecycle state without determining it", () => {
  assert.equal(
    formatRunStatus({ status: "running", elapsedMs: 2_000 }),
    "running",
  );
  assert.equal(
    formatRunStatus({ status: "completed", elapsedMs: 5_000 }),
    "completed in 5.0s",
  );
  assert.equal(
    formatRunStatus({ status: "failed", elapsedMs: 5_000 }),
    "failed after 5.0s",
  );
  assert.equal(
    formatRunStatus({ status: "cancelled", elapsedMs: 3_000 }),
    "cancelled after 3.0s",
  );
});

test("each lifecycle state has a presentation tone", () => {
  const completedTone: Tone = runStatusTone("completed");
  assert.equal(completedTone, "success");
  assert.deepEqual(
    (["running", "completed", "failed", "cancelled"] as const).map(
      runStatusTone,
    ),
    ["warning", "success", "error", "error"],
  );
});

test("presentation owns agent_start and unknown-agent prose", () => {
  assert.equal(
    formatUnknownAgent("ghost", ["explore", "review"]),
    'Unknown agent: "ghost". Available: explore, review',
  );
  assert.equal(
    formatUnknownAgent("ghost", []),
    'Unknown agent: "ghost". Available: none',
  );
  assert.equal(
    formatStartResult("explore", "run-1"),
    "Started explore as run run-1. Its notification will arrive when it finishes; carry on until then.",
  );
});

test("presentation owns every agent_await outcome", () => {
  assert.equal(
    formatAwaitOutcome({
      terminal: [
        { id: "run-1", agent: "explore", phase: "completed" },
        {
          id: "run-2",
          agent: "review",
          phase: "cancelled",
          reason: "requested",
        },
      ],
      stillRunning: ["run-3"],
      unknown: ["missing"],
    }),
    "explore (run-1): completed\n\nreview (run-2): cancelled (requested)\n\nStill running: run-3.\n\nUnknown run ids: missing.",
  );
  assert.equal(
    formatAwaitOutcome({ terminal: [], stillRunning: [], unknown: [] }),
    "No run ids were given.",
  );
});

test("presentation owns every agent_cancel outcome", () => {
  assert.equal(
    formatCancelOutcome({
      cancelled: ["run-1"],
      alreadySettling: ["run-2"],
      finished: ["run-3"],
      unknown: ["missing"],
    }),
    "Cancelled: run-1. Already settling: run-2. Already finished, result kept: run-3. Unknown run ids: missing.",
  );
  assert.equal(
    formatCancelOutcome({
      cancelled: [],
      alreadySettling: [],
      finished: [],
      unknown: [],
    }),
    "Nothing to cancel.",
  );
});

test("presentation owns every agent_result fallback", () => {
  const retained = {
    id: "run-1",
    agent: "explore",
    status: "completed" as const,
    output: "",
  };
  assert.equal(
    formatResult(retained),
    "explore (run-1):\n\nThe run finished without output.",
  );
  assert.equal(
    formatResult({ ...retained, evicted: true }),
    "explore (run-1):\n\nThis run's full output was evicted to bound result-store memory.",
  );
  assert.equal(
    formatAgentResultUnavailable("run-1", true),
    "Run run-1 has not finished yet. Its notification will arrive on its own; agent_await blocks for it if you cannot continue without it.",
  );
  assert.equal(
    formatAgentResultUnavailable("missing", false),
    "No run with id missing. Check it against what agent_start returned.",
  );
});

test("presentation owns executor-rejection result and notification prose", () => {
  assert.deepEqual(
    formatExecutorRejection("run-1", "explore", "executor bug"),
    {
      output:
        "This run failed before completing.\n\nFailure: executor bug\n\nThe run failed before producing output.",
      notification:
        "Subagent explore (run-1) failed: executor bug\n\nUse agent_result with id run-1 to retrieve the full result.",
    },
  );
  assert.equal(
    formatExecutorRejection("run-1", "explore", "").notification,
    "Subagent explore (run-1) failed: no reason reported\n\nUse agent_result with id run-1 to retrieve the full result.",
  );
});

test("a completed notification uses lifecycle vocabulary", () => {
  assert.equal(notificationVerb("completed"), "completed");
  assert.equal(notificationVerb("failed"), "failed");
  assert.equal(notificationVerb("cancelled"), "cancelled");
});

test("notification accounting abbreviates usage and includes the model", () => {
  assert.equal(
    formatNotificationAccounting(
      {
        input: 12_300,
        output: 4_500,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.1242,
        contextTokens: 0,
        turns: 3,
      },
      "claude-sonnet-4-6",
    ),
    "cost $0.1242 · 12.3k in / 4.5k out · 3 turns · claude-sonnet-4-6",
  );
});

test("notification accounting omits zero or absent fields", () => {
  assert.equal(
    formatNotificationAccounting(
      {
        input: 1_200,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      undefined,
    ),
    "1.2k in",
  );
  assert.equal(
    formatNotificationAccounting(
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      "baseline-model",
    ),
    undefined,
  );
  assert.equal(formatNotificationAccounting(undefined, "model"), undefined);
});

test("completed, failed, and cancelled notifications carry accounting", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.usage.input = 12_300;
  result.usage.output = 4_500;
  result.usage.cost = 0.1242;
  result.usage.turns = 3;
  result.model = "claude-sonnet-4-6";

  for (const lifecycle of [
    { phase: "completed", finishedAt: 10, exitCode: 0 },
    { phase: "failed", finishedAt: 10, exitCode: 1 },
    { phase: "cancelled", finishedAt: 10, reason: "requested" },
  ] as const) {
    result.lifecycle = lifecycle;
    assert.match(
      formatNotification("a1", result),
      /cost \$0\.1242 · 12\.3k in \/ 4\.5k out · 3 turns · claude-sonnet-4-6$/,
    );
  }
});

// ── Notification and result shape ───────────────────────────────────────────

test("N1/N2: completed notification has a deterministic bounded preview and result pointer", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(
    assistantText("x".repeat(NOTIFICATION_PREVIEW_CHARACTER_LIMIT + 500)),
  );
  result.lifecycle = { phase: "completed", finishedAt: 10, exitCode: 0 };

  const notification = formatNotification("a1", result);
  assert.ok(notification.length < NOTIFICATION_PREVIEW_CHARACTER_LIMIT + 200);
  assert.match(notification, /Use agent_result with id a1/);
  assert.doesNotMatch(notification, /x{1200}/);
});

test("N3: failed notification carries only the primary error and pointer", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.lifecycle = { phase: "failed", finishedAt: 10, exitCode: 1 };
  result.errorMessage = "model refused";
  result.stderr = "raw secret stderr";
  assert.equal(
    formatNotification("a1", result),
    "Subagent explore (a1) failed: model refused\n\nUse agent_result with id a1 to retrieve the full result.",
  );
});

test("N1: failed notification bounds a pathological error message", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.lifecycle = { phase: "failed", finishedAt: 10, exitCode: 1 };
  result.errorMessage = "y".repeat(NOTIFICATION_PREVIEW_CHARACTER_LIMIT + 500);

  const notification = formatNotification("a1", result);
  assert.ok(notification.length < NOTIFICATION_PREVIEW_CHARACTER_LIMIT + 200);
  assert.match(notification, /Use agent_result with id a1/);
});

test("completed results preserve output exactly", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("  answer\n"));
  result.lifecycle = { phase: "completed", finishedAt: 10, exitCode: 0 };

  assert.equal(fullOutput(result), "  answer\n");
});

test("a cancelled notification is terse and contains no partial output", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("partial secret"));
  result.lifecycle = { phase: "cancelled", finishedAt: 10, reason: "shutdown" };
  assert.equal(
    formatNotification("a1", result),
    "Subagent explore (a1) was cancelled (shutdown).",
  );
});

test("INV-11: failed and cancelled results label partial output", () => {
  const failed = createEmptyResult("explore", "look", 0);
  failed.messages.push(assistantText("partial finding"));
  failed.lifecycle = { phase: "failed", finishedAt: 10, exitCode: 1 };
  assert.match(fullOutput(failed), /failed before completing/);
  assert.match(
    fullOutput(failed),
    /Output produced before failure:\n\npartial finding/,
  );

  const cancelled = createEmptyResult("explore", "look", 0);
  cancelled.messages.push(assistantText("work so far"));
  cancelled.lifecycle = {
    phase: "cancelled",
    finishedAt: 10,
    reason: "requested",
  };
  assert.match(fullOutput(cancelled), /cancelled before finishing/);
  assert.match(
    fullOutput(cancelled),
    /Output produced before cancellation:\n\nwork so far/,
  );
});

test("INV-11: failed and cancelled results plainly say when output is absent", () => {
  const failed = createEmptyResult("explore", "look", 0);
  failed.lifecycle = { phase: "failed", finishedAt: 10, exitCode: 1 };
  assert.equal(
    fullOutput(failed),
    "This run failed before completing.\n\nThe run failed before producing output.",
  );

  const cancelled = createEmptyResult("explore", "look", 0);
  cancelled.lifecycle = {
    phase: "cancelled",
    finishedAt: 10,
    reason: "requested",
  };
  assert.equal(
    fullOutput(cancelled),
    "The run was cancelled before producing output.",
  );
});
