import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDuration,
  formatRunStatus,
  runStatusGlyph,
  runStatusTone,
} from "./formatting.ts";

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
    "running for 2.0s",
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
    formatRunStatus({ status: "aborted", elapsedMs: 3_000 }),
    "aborted after 3.0s",
  );
});

test("each lifecycle state has its own glyph-and-tone pair", () => {
  assert.deepEqual(
    (["running", "completed", "failed", "aborted"] as const).map((status) => [
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
