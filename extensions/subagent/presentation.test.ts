import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  FAILURE_REASON_LIMIT,
  formatDuration,
  formatReport,
  formatRunStatus,
  REPORT_CHARACTER_LIMIT,
  reportVerb,
  runStatusGlyph,
  runStatusTone,
} from "./presentation.ts";
import { createEmptyResult } from "./run.ts";

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

test("formatRunStatus words each lifecycle state with its duration", () => {
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

test("a delivered report is 'reported', not 'completed'", () => {
  assert.equal(reportVerb("completed"), "reported");
  assert.equal(reportVerb("failed"), "failed");
  assert.equal(reportVerb("cancelled"), "cancelled");
});

// ── Report shape ─────────────────────────────────────────────────────────────

test("a report carries the final output and names the run", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("three call sites"));
  result.lifecycle = { phase: "completed", finishedAt: 10, exitCode: 0 };

  const report = formatReport("a1b2c3d4", result);

  assert.match(report, /^Subagent explore \(a1b2c3d4\) finished:/);
  assert.match(report, /three call sites/);
});

test("a thorough report passes through whole", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("x".repeat(10_000)));
  result.lifecycle = { phase: "completed", finishedAt: 10, exitCode: 0 };

  const report = formatReport("a1b2c3d4", result);

  assert.match(report, /x{10000}/, "a real answer is never cut");
  assert.doesNotMatch(report, /incomplete/);
});

test("a runaway report is cut, and says how much went missing", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("x".repeat(REPORT_CHARACTER_LIMIT + 500)));
  result.lifecycle = { phase: "completed", finishedAt: 10, exitCode: 0 };

  const report = formatReport("a1b2c3d4", result);

  assert.match(report, /500 more characters dropped/);
  assert.match(report, /this report is incomplete/);
});

test("a failure reason keeps its tail, where the diagnosis is", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.lifecycle = { phase: "failed", finishedAt: 10, exitCode: 1 };
  result.stderr = `${"noise\n".repeat(2_000)}FATAL: the actual cause`;

  const report = formatReport("a1", result);

  assert.match(report, /FATAL: the actual cause$/);
  assert.match(report, /earlier characters dropped/);
  assert.ok(report.length < FAILURE_REASON_LIMIT + 200);
});

test("a failed report names the reason", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.lifecycle = { phase: "failed", finishedAt: 10, exitCode: 1 };
  result.errorMessage = "model refused";

  assert.match(formatReport("a1", result), /failed: model refused/);
});

test("a finished run with no output says so rather than looking empty", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.lifecycle = { phase: "completed", finishedAt: 10, exitCode: 0 };

  assert.match(formatReport("a1", result), /finished without output/);
});
