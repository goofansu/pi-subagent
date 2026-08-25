import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  formatDuration,
  formatNotification,
  formatRunStatus,
  fullOutput,
  NOTIFICATION_PREVIEW_CHARACTER_LIMIT,
  notificationVerb,
  runStatusGlyph,
  runStatusTone,
} from "./presentation.ts";
import { createEmptyResult } from "./run.ts";
import type { Tone } from "./types.ts";

function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] } as Message;
}

// ── Status words, glyphs, tones ──────────────────────────────────────────────

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

test("each lifecycle state has its own glyph-and-tone pair", () => {
  const completedTone: Tone = runStatusTone("completed");
  assert.equal(completedTone, "success");
  assert.deepEqual(
    (["running", "completed", "failed", "cancelled"] as const).map((status) => [
      runStatusGlyph(status),
      runStatusTone(status),
    ]),
    [
      ["●", "warning"],
      ["●", "success"],
      ["●", "error"],
      ["○", "error"],
    ],
  );
});

test("a completed notification uses lifecycle vocabulary", () => {
  assert.equal(notificationVerb("completed"), "completed");
  assert.equal(notificationVerb("failed"), "failed");
  assert.equal(notificationVerb("cancelled"), "cancelled");
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
