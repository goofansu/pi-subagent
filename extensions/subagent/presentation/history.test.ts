import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import { backendId, runId, subagentId } from "../domain/index.ts";
import { historyCategory, historyRow } from "./history.ts";

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
