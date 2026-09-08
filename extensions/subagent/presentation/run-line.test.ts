import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as runLine from "./run-line.ts";
import {
  type FittedRunLine,
  fitHistoryRunLine,
  fitHistoryRunLines,
  fitWidgetRunLine,
  type ResolvedRunLineContent,
  RUN_ACTIVITY_SEPARATOR,
  RUN_STATUS_SEPARATOR,
} from "./run-line.ts";

const parts = (
  overrides: Partial<ResolvedRunLineContent> = {},
): ResolvedRunLineContent => ({
  label: "look around",
  status: "running",
  activity: "bash: npm test",
  duration: "12.4s",
  ...overrides,
});
const historyParts = (overrides: Partial<ResolvedRunLineContent> = {}) => ({
  ...parts(overrides),
  prefix: "  ",
});

/** Visible fitted width, including the separators the painters actually use. */
function drawn(line: FittedRunLine): number {
  return (
    visibleWidth(line.label) +
    (line.status === undefined
      ? 0
      : visibleWidth(RUN_STATUS_SEPARATOR) + visibleWidth(line.status)) +
    (line.activity === undefined
      ? 0
      : visibleWidth(RUN_ACTIVITY_SEPARATOR) + visibleWidth(line.activity)) +
    (line.duration === undefined ? 0 : line.gap + visibleWidth(line.duration))
  );
}

test("the public fitter surface exposes operations, not policy machinery", () => {
  assert.deepEqual(Object.keys(runLine).sort(), [
    "RUN_ACTIVITY_SEPARATOR",
    "RUN_STATUS_SEPARATOR",
    "fitHistoryRunLine",
    "fitHistoryRunLines",
    "fitWidgetRunLine",
    "runActivitySeparator",
  ]);
});

test("widget fitting accepts resolved content without a public policy", () => {
  const fitted = fitWidgetRunLine(parts(), 44);
  assert.deepEqual(
    [fitted.label, fitted.status, fitted.activity, fitted.duration],
    ["look around", "running", "bash: npm test", "12.4s"],
  );
});

test("widget and dashboard fitting own their 40-column Label cap", () => {
  const long = parts({ label: "a".repeat(80) });
  assert.equal(visibleWidth(fitWidgetRunLine(long, 200).label), 40);
  assert.equal(
    visibleWidth(
      fitHistoryRunLines([{ ...long, prefix: "  " }], 200)[0]?.label ?? "",
    ),
    40,
  );
});

test("widget fitting preserves useful Label and activity priority", () => {
  const squeezed = fitWidgetRunLine(
    parts({ label: "a-very-long-work-label" }),
    31,
  );
  assert.equal(squeezed.label, "a-very…");
  assert.equal(squeezed.activity, "bash: npm t…");

  assert.equal(visibleWidth(fitWidgetRunLine(parts(), 31).activity ?? ""), 12);
  const given = fitWidgetRunLine(parts(), 30);
  assert.equal(given.activity, undefined);
  assert.equal(given.status, "running");
  assert.equal(given.label, "look around");
});

test("widget duration reserves the right edge and retries without it when useful activity loses", () => {
  const four = fitWidgetRunLine(parts(), 44);
  assert.equal(four.duration, "12.4s");
  assert.equal(drawn(four), 44);

  const yielded = fitWidgetRunLine(parts(), 37);
  assert.equal(yielded.duration, undefined);
  assert.equal(yielded.gap, 0);
  assert.equal(yielded.activity, "bash: npm test");
});

test("widget status gives way only when it would leave no Label", () => {
  const last = fitWidgetRunLine(parts(), 10);
  assert.deepEqual([last.label, last.status], ["…", "running"]);
  const narrower = fitWidgetRunLine(parts(), 9);
  assert.equal(narrower.label, "look aro…");
  assert.equal(narrower.status, undefined);
  assert.equal(narrower.activity, undefined);
});

test("history-list fitting measures and pads shared columns from actual content", () => {
  const [short, long] = fitHistoryRunLines(
    [
      historyParts({ label: "One" }),
      historyParts({ label: "Longer label here!!" }),
    ],
    120,
  );
  assert.ok(short && long);
  assert.equal(visibleWidth(short.label), 19);
  assert.equal(visibleWidth(long.label), 19);
  assert.equal(visibleWidth(short.status ?? ""), 7);
  assert.equal(
    visibleWidth(short.activity ?? ""),
    visibleWidth(long.activity ?? ""),
  );
  assert.equal(drawn(short), 118);

  const [wideLabel, asciiLabel] = fitHistoryRunLines(
    [historyParts({ label: "界".repeat(4) }), historyParts({ label: "One" })],
    120,
  );
  assert.ok(wideLabel && asciiLabel);
  assert.equal(visibleWidth(wideLabel.label), 8);
  assert.equal(visibleWidth(asciiLabel.label), 8);
});

test("history thresholds remain tied to full row width around every transition", () => {
  const fit = (width: number) => fitHistoryRunLine(historyParts(), width);
  assert.equal(fit(25).status, undefined);
  assert.notEqual(fit(26).status, undefined);
  assert.notEqual(fit(27).status, undefined);

  assert.equal(fit(51).activity, undefined);
  assert.notEqual(fit(52).activity, undefined);
  assert.notEqual(fit(53).activity, undefined);

  assert.equal(fit(79).duration, undefined);
  assert.equal(fit(80).duration, "   12.4s");
  assert.equal(fit(81).duration, "   12.4s");
  assert.equal(fit(80).gap, 2);
});

test("narrow fitting retains ANSI behavior and never splits combining marks or emoji", () => {
  const painted = `\u001b[2m${"a".repeat(50)}\u001b[0m`;
  const widget = fitWidgetRunLine(
    parts({ label: painted, activity: "café 👩‍💻".repeat(20) }),
    31,
  );
  assert.ok(
    !widget.label.includes("\u001b"),
    "plain widget parts discard resets",
  );
  assert.doesNotMatch(widget.label + widget.activity, /�/);

  const [history] = fitHistoryRunLines(
    [historyParts({ label: painted, activity: "café 👩‍💻".repeat(20) })],
    80,
  );
  assert.ok(history);
  assert.ok(
    history.label.includes("\u001b"),
    "painted history parts retain ANSI",
  );
  assert.doesNotMatch(history.label + history.activity, /�/);
});

test("empty history Labels retain the established delimiter accounting", () => {
  const [line] = fitHistoryRunLines(
    [historyParts({ label: "", activity: "grep: x" })],
    100,
  );
  assert.ok(line);
  assert.equal(line.label, "");
  assert.equal(drawn(line), 98);
  assert.equal(line.duration, "   12.4s");
});

test("narrow operations elide instead of overflowing at every width", () => {
  const fixtures = [
    parts(),
    parts({ label: "任务 café 👩‍💻 é".repeat(20), activity: "界".repeat(100) }),
    parts({ status: "cancelled", activity: "timeout" }),
  ];
  for (const content of fixtures) {
    for (let width = 0; width <= 160; width += 1) {
      const widget = fitWidgetRunLine(content, width);
      const [history] = fitHistoryRunLines(
        [{ ...content, prefix: "  " }],
        width,
      );
      assert.ok(history);
      assert.ok(
        drawn(widget) <= width,
        `widget at ${width}: ${JSON.stringify(widget)}`,
      );
      assert.ok(
        drawn(history) <= Math.max(0, width - 2),
        `history at ${width}: ${JSON.stringify(history)}`,
      );
      assert.doesNotMatch(widget.label, /\ufffd/);
      assert.doesNotMatch(history.label, /\ufffd/);
    }
    assert.deepEqual(fitWidgetRunLine(content, 0), { label: "", gap: 0 });
    assert.deepEqual(fitHistoryRunLines([{ ...content, prefix: "  " }], 0)[0], {
      label: "",
      gap: 0,
    });
  }
});
