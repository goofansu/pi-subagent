import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary } from "../domain/history.ts";
import { backendId, runId, subagentId } from "../domain/index.ts";
import { PLAIN_THEME } from "../testing/stand-in-host.ts";
import { historyCategory, historyRows } from "./history.ts";

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
type HistoryRunSummary = RunSummary & {
  readonly failureDetail?: string | undefined;
};

const row = (
  value: HistoryRunSummary,
  width = 120,
  selected = false,
  now = 1000,
) =>
  historyRows(
    [value],
    selected ? value.runId : undefined,
    width,
    PLAIN_THEME,
    now,
  )[0] ?? "";

test("rows align labels, statuses, outcome details and rightmost elapsed time without actions or technical metadata", () => {
  const [selected = "", other = ""] = historyRows(
    [run, { ...run, label: "Settings", phase: "finalizing" }],
    run.runId,
    120,
    PLAIN_THEME,
    1000,
  );
  assert.equal(selected.indexOf("Running"), other.indexOf("Finalizing"));
  assert.doesNotMatch(selected + other, /Reading middleware/);
  assert.match(selected, /Running +· -/);
  assert.match(other, /Finalizing +· -/);
  assert.ok(selected.startsWith("› Review authentication"));
  assert.ok(selected.endsWith("1.0s"));
  assert.ok(other.endsWith("1.0s"));
  assert.doesNotMatch(selected + other, /enter/);
  assert.doesNotMatch(
    selected,
    /explore|run-test|subagent-test|turns|Label:|changed .* ago/,
  );
  assert.equal(visibleWidth(selected), 120);
  assert.equal(visibleWidth(other), 120);
});

test("a list sizes label and status columns to its longest visible values", () => {
  const values = [
    { ...run, label: "One", phase: "finalizing" as const },
    { ...run, label: "Longer label" },
  ];
  const lines = historyRows(values, undefined, 120, PLAIN_THEME, 1000).map(
    stripVTControlCharacters,
  );
  assert.equal(lines[0].indexOf("Finalizing"), lines[1].indexOf("Running"));
  assert.equal(lines[0].indexOf("·"), lines[1].indexOf("·"));
  assert.match(lines[0], /^ {2}One {11}Finalizing · -/);
  assert.match(lines[1], /^ {2}Longer label {2}Running {4}· -/);
});

test("labels are capped at 40 columns in roomy subagent lists", () => {
  const value = { ...run, label: "a".repeat(80) };
  const line = stripVTControlCharacters(
    historyRows([value], undefined, 160, PLAIN_THEME, 1000)[0] ?? "",
  );
  assert.match(line, /^ {2}a{39}… {2}Running/);
  assert.doesNotMatch(line, /a{40}/);
});

test("history resolves outcome detail for every phase and cancellation reason", () => {
  const reasons = [undefined, "requested", "shutdown", "timeout"] as const;
  for (const phase of [
    "running",
    "finalizing",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    for (const cancellationReason of reasons) {
      const line = stripVTControlCharacters(
        row({
          ...run,
          phase,
          cancellationReason,
          activity: "Current activity",
          lastActivity: { summary: "Last activity", changedAt: 0 },
          failureDetail: "Safe failure detail",
        }),
      );
      const expected =
        phase === "failed"
          ? "Safe failure detail"
          : phase === "cancelled" && cancellationReason !== undefined
            ? cancellationReason
            : "-";
      assert.match(
        line,
        new RegExp(`· ${expected.replaceAll(" ", "\\s+")}`),
        `${phase} ${cancellationReason}`,
      );
      assert.doesNotMatch(line, /Current activity|Last activity/);
      if (phase === "completed" || phase === "failed") {
        assert.doesNotMatch(line, /requested|shutdown|timeout/);
      }
    }
  }
});

test("failed and cancelled outcome details fall back to a literal hyphen when unavailable", () => {
  for (const failureDetail of [undefined, "", " ", "\t\n"]) {
    const line = stripVTControlCharacters(
      row({ ...run, phase: "failed", failureDetail }),
    );
    assert.match(line, /Failed +· -/);
    assert.doesNotMatch(line, /· —/);
  }
  const cancelled = stripVTControlCharacters(
    row({ ...run, phase: "cancelled", cancellationReason: undefined }),
  );
  assert.match(cancelled, /Cancelled +· -/);
  assert.doesNotMatch(cancelled, /· —/);
});

test("assembled history preserves content-gate transitions and selection prefixes", () => {
  const selected = (width: number) =>
    stripVTControlCharacters(
      historyRows([run], run.runId, width, PLAIN_THEME, 1000)[0] ?? "",
    );
  for (const width of [0, 1, 2, 25, 26, 27, 51, 52, 53, 79, 80, 81]) {
    const line = selected(width);
    assert.equal(visibleWidth(line), width, `selected width ${width}`);
    if (width >= 2) assert.ok(line.startsWith("› "), `prefix at ${width}`);
  }
  assert.doesNotMatch(selected(25), /Running/);
  assert.match(selected(26), /Running/);
  assert.match(selected(27), /Running/);
  assert.doesNotMatch(selected(51), /· -/);
  assert.match(selected(52), /· -/);
  assert.match(selected(53), /· -/);
  assert.doesNotMatch(selected(79), /1\.0s/);
  assert.match(selected(80), /1\.0s$/);
  assert.match(selected(81), /1\.0s$/);

  const [unselected = ""] = historyRows(
    [run],
    undefined,
    80,
    PLAIN_THEME,
    1000,
  );
  assert.match(
    stripVTControlCharacters(unselected),
    /^ {2}Review authentication/,
  );
  assert.equal(visibleWidth(unselected), 80);
});

test("responsive rows fit oversized wide-character failure detail without splitting Unicode", () => {
  const unicode = {
    ...run,
    label: "任务 café 👩‍💻 é".repeat(20),
    phase: "failed" as const,
    failureDetail: "界".repeat(100),
  };
  for (let width = 0; width <= 160; width += 1) {
    const line = row(unicode, width, true);
    assert.ok(visibleWidth(line) <= width);
    assert.doesNotMatch(line, /\ufffd/);
  }
  assert.match(row(unicode, 160, true), /界/);
  const narrow = row(unicode, 40, true);
  assert.match(narrow, /任务.*Failed/);
  assert.doesNotMatch(narrow, /界|Reading middleware|enter runs/);
});

test("elapsed time uses the supplied event time and freezes at settlement", () => {
  const render = (value: RunSummary, now: number) =>
    row(value, 120, false, now);
  assert.match(render(run, 1500), /1\.5s/);
  assert.match(render(run, 61000), /1m 1s/);
  const completed = { ...run, phase: "completed" as const, settledAt: 2500 };
  assert.equal(render(completed, 3000), render(completed, 90000));
  assert.match(render(completed, 90000), /2\.5s/);
  assert.match(render({ ...run, startedAt: 5000 }, 1000), /0\.0s/);
  assert.doesNotMatch(row(run, 40), /1\.0s/);
});

test("selection preserves resolved status text and tones", () => {
  for (const [phase, cancellationReason, status, tone] of [
    ["running", undefined, "running", "warning"],
    ["running", "requested", "cancelling", "warning"],
    ["finalizing", undefined, "finalizing", "warning"],
    ["finalizing", "shutdown", "cancelling", "warning"],
    ["completed", undefined, "completed", "success"],
    ["failed", undefined, "failed", "error"],
    ["cancelled", "timeout", "cancelled", "error"],
    ["cancelled", "requested", "cancelled", "muted"],
    ["cancelled", "shutdown", "cancelled", "muted"],
  ] as const) {
    const tones: { color: string; text: string }[] = [];
    const value = { ...run, phase, cancellationReason };
    const line =
      historyRows(
        [value],
        value.runId,
        120,
        {
          ...PLAIN_THEME,
          fg: (color, text) => {
            tones.push({ color, text });
            return `\x1b[33m${text}\x1b[39m`;
          },
        },
        1000,
      )[0] ?? "";
    assert.ok(
      tones.some(
        ({ color, text }) =>
          color === tone && text.trim().toLowerCase() === status,
      ),
    );
    assert.equal(visibleWidth(line), 120);
    assert.doesNotMatch(stripVTControlCharacters(line), /enter/);
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
