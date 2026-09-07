import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import {
  backendId,
  EMPTY_USAGE_SNAPSHOT,
  runId,
  subagentId,
} from "../domain/index.ts";
import { historyCategory, historyRow } from "./history.ts";
import { inspectionLines } from "./inspection.ts";

const run: RunSummary = {
  runId: runId("run-test-1"),
  subagentId: subagentId("subagent-test-1"),
  profile: "研究👩‍💻".repeat(20),
  backend: backendId("pi"),
  label: "任务 café 👩‍💻",
  phase: "cancelled",
  cancellationReason: "shutdown",
  activity: "optional activity".repeat(40),
  turns: 3,
  startedAt: 0,
};

test("history retains last activity after clearing current activity, without adding a live age", () => {
  const settled = {
    ...run,
    activity: undefined,
    lastActivity: { summary: "finished reading", changedAt: 0 },
  };
  assert.match(
    historyRow(settled, 300, run.runId).join("\n"),
    /finished reading/,
  );
  assert.doesNotMatch(
    historyRow(settled, 300, run.runId).join("\n"),
    /changed/,
  );
  assert.match(
    historyRow({ ...settled, activity: "current" }, 300, run.runId).join("\n"),
    /current/,
  );
});

for (const [age, expected] of [
  [-1000, "0.0s"],
  [1500, "1.5s"],
  [61000, "1m 1s"],
  [3660000, "1h 1m"],
] as const)
  test(`history and frozen inspection share duration vocabulary at ${age}ms`, () => {
    const summary = {
      ...run,
      lastActivity: { summary: "reading", changedAt: 1000 },
    };
    const capture = {
      outcome: "ResultExpired",
      runId: run.runId,
      capturedAt: 1000 + age,
      summary,
      usage: EMPTY_USAGE_SNAPSHOT,
    } as const;
    assert.ok(
      historyRow(summary, 500, run.runId, undefined, capture.capturedAt)
        .join("\n")
        .includes(`changed ${expected} ago`),
    );
    const first = inspectionLines(capture, "pending");
    assert.ok(first.join("\n").includes(`changed ${expected} ago`));
    assert.deepEqual(inspectionLines(capture, "pending"), first);
  });

test("retained shutdown cancellation is Completed, not a presentation phase or broken work", () => {
  const subagent: SubagentSummary = {
    subagentId: run.subagentId,
    phase: "closed",
    latest: run,
  };
  assert.equal(historyCategory(subagent), "Completed");
  const rows = historyRow(run, 160, run.subagentId, subagent.phase).join("\n");
  assert.match(rows, /closed · cancelled \(shutdown\)/);
  assert.doesNotMatch(rows, /Completed/);
});

test("long Unicode Profiles and activity cannot displace the Label or exceed terminal width", () => {
  for (let width = 0; width <= 160; width += 1) {
    const rows = historyRow(run, width, run.subagentId, "closed");
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.ok(rows.every((row) => !row.includes("\ufffd")));
    if (width >= 24) assert.ok(rows[1].includes(run.label));
  }
});
