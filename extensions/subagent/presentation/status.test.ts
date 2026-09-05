import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_PHASES } from "../domain/index.ts";
import {
  formatCharacterCount,
  formatDuration,
  formatRunPhase,
  formatTokenCount,
  formatTurns,
  RUN_PHASE_DISPLAY_ORDER,
  runPhaseBackground,
  runPhaseTone,
  runPhaseVerb,
} from "./status.ts";

test("every Run phase has a background, and it is one of Pi's tool-box three", () => {
  assert.deepEqual(RUN_PHASES.map(runPhaseBackground), [
    "toolPendingBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
    "toolErrorBg",
  ]);
});

test("every Run phase has a tone, a verb, and a phrase", () => {
  assert.deepEqual([...RUN_PHASE_DISPLAY_ORDER], [...RUN_PHASES]);
  for (const phase of RUN_PHASES) {
    assert.ok(["warning", "success", "error"].includes(runPhaseTone(phase)));
    assert.ok(runPhaseVerb(phase).length > 0);
    assert.ok(formatRunPhase({ phase, elapsedMillis: 1_000 }).length > 0);
  }
});

test("presentation observes phase without determining it", () => {
  // The five phrases, with the two live ones deliberately naming no duration:
  // a phrase is written into tool results and notices, where a live figure
  // would be stale as soon as it was read. The widget's duration column is
  // where a live Run's time is shown.
  assert.deepEqual(
    RUN_PHASES.map((phase) => formatRunPhase({ phase, elapsedMillis: 12_400 })),
    [
      "running",
      "finalizing",
      "completed in 12.4s",
      "failed after 12.4s",
      "cancelled after 12.4s",
    ],
  );
});

test("finalizing is its own phase rather than borrowing running's word", () => {
  assert.notEqual(runPhaseVerb("finalizing"), runPhaseVerb("running"));
  assert.equal(runPhaseTone("finalizing"), "warning");
});

test("formatDuration reports tenths, then minutes, then hours", () => {
  assert.equal(formatDuration(0), "0.0s");
  assert.equal(formatDuration(12_449), "12.4s");
  assert.equal(formatDuration(59_949), "59.9s");
  assert.equal(formatDuration(60_000), "1m 0s");
  assert.equal(formatDuration(3_599_000), "59m 59s");
  assert.equal(formatDuration(3_600_000), "1h 0m");
  assert.equal(formatDuration(7_830_000), "2h 10m");
});

test("formatDuration never reports negative time", () => {
  assert.equal(formatDuration(-5_000), "0.0s");
});

test("a character count abbreviates once it gets long", () => {
  assert.equal(formatCharacterCount(0), "0 characters");
  assert.equal(formatCharacterCount(999), "999 characters");
  assert.equal(formatCharacterCount(1_000), "1.0k characters");
  assert.equal(formatCharacterCount(12_345), "12.3k characters");
});

test("a token count abbreviates and promotes at each boundary", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_000), "1.0k");
  assert.equal(formatTokenCount(12_300), "12.3k");
  assert.equal(formatTokenCount(999_950), "1.0m");
  assert.equal(formatTokenCount(1_500_000), "1.5m");
  assert.equal(formatTokenCount(2_000_000_000), "2.0b");
  assert.equal(formatTokenCount(3_000_000_000_000), "3.0t");
});

test("turns use a quiet singular and plural format", () => {
  assert.equal(formatTurns(0), "—");
  assert.equal(formatTurns(1), "1 turn");
  assert.equal(formatTurns(2), "2 turns");
});
