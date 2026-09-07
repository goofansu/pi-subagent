import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary } from "../domain/history.ts";
import { backendId, runId, subagentId } from "../domain/index.ts";
import { PLAIN_THEME } from "../testing/stand-in-host.ts";
import { historyCategory, historyRow } from "./history.ts";

const run: RunSummary = {
  runId: runId("run-test-1"),
  subagentId: subagentId("subagent-test-1"),
  profile: "explore",
  backend: backendId("pi"),
  label: "Review authentication",
  phase: "running",
  activity: "Reading middleware",
  turns: 3,
  startedAt: 0,
};
const row = (value: RunSummary, width = 120, selected = false) =>
  historyRow(value, width, PLAIN_THEME, "enter runs", selected);

test("rows align labels, statuses, activity and trailing actions without technical metadata", () => {
  const selected = row(run, 120, true);
  const other = row({ ...run, label: "Settings", phase: "finalizing" });
  assert.equal(selected.indexOf("Running"), other.indexOf("Finalizing"));
  assert.equal(
    selected.indexOf("Reading middleware"),
    other.indexOf("Reading middleware"),
  );
  assert.ok(selected.startsWith("› Review authentication"));
  assert.ok(selected.endsWith("enter runs"));
  assert.doesNotMatch(other, /enter runs/);
  assert.doesNotMatch(
    selected,
    /explore|run-test|subagent-test|turns|Label:|changed .* ago/,
  );
  assert.equal(visibleWidth(selected), 120);
  assert.equal(visibleWidth(other), 120);
});

test("terminal rows do not imply stale tool activity is the result", () => {
  for (const phase of ["completed", "failed", "cancelled"] as const) {
    const line = row({ ...run, phase });
    assert.doesNotMatch(line, /Reading middleware/);
    assert.match(line, /—/);
  }
  assert.match(
    row({ ...run, phase: "cancelled", cancellationReason: "timeout" }),
    /timeout/,
  );
  assert.match(
    row({
      ...run,
      activity: undefined,
      lastActivity: { summary: "Latest activity", changedAt: 0 },
    }),
    /Latest activity/,
  );
});

test("responsive rows drop actions and activity before status and never split Unicode", () => {
  const unicode = {
    ...run,
    label: "任务 café 👩‍💻 é".repeat(20),
    activity: "界".repeat(100),
  };
  for (let width = 0; width <= 160; width += 1) {
    const line = row(unicode, width, true);
    assert.ok(visibleWidth(line) <= width);
    assert.doesNotMatch(line, /\ufffd/);
  }
  const narrow = row(run, 40, true);
  assert.match(narrow, /Review authentication.*Running/);
  assert.doesNotMatch(narrow, /Reading middleware|enter runs/);
});

test("selection preserves semantic status tones", () => {
  for (const [phase, cancellationReason, tone] of [
    ["running", undefined, "warning"],
    ["finalizing", undefined, "warning"],
    ["completed", undefined, "success"],
    ["failed", undefined, "error"],
    ["cancelled", "timeout", "error"],
    ["cancelled", "requested", "muted"],
  ] as const) {
    const tones: { color: string; text: string }[] = [];
    const line = historyRow(
      { ...run, phase, cancellationReason },
      120,
      {
        ...PLAIN_THEME,
        fg: (color, text) => {
          tones.push({ color, text });
          return `\x1b[33m${text}\x1b[39m`;
        },
      },
      "enter inspect",
      true,
    );
    assert.ok(
      tones.some(
        ({ color, text }) =>
          color === tone && text.trim().toLowerCase() === phase,
      ),
    );
    assert.equal(visibleWidth(line), 120);
    assert.match(stripVTControlCharacters(line), /enter inspect$/);
  }
});

test("sorting retains active, attention and completed groups without displaying headings", () => {
  assert.equal(
    historyCategory({
      subagentId: run.subagentId,
      phase: "running",
      current: run,
      latest: run,
    }),
    "Active",
  );
  assert.equal(
    historyCategory({
      subagentId: run.subagentId,
      phase: "idle",
      latest: { ...run, phase: "failed" },
    }),
    "Needs attention",
  );
  assert.equal(
    historyCategory({
      subagentId: run.subagentId,
      phase: "closed",
      latest: { ...run, phase: "cancelled", cancellationReason: "shutdown" },
    }),
    "Completed",
  );
});
