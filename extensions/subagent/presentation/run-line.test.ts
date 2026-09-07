import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FIXTURE_NOW, fixtureRow } from "../testing/presentation-fixtures.ts";
import { historyRunLine } from "./history.ts";
import { NOTICE_RUN_LINE } from "./renderers.ts";
import { WIDGET_RUN_LINE } from "./rows.ts";
import {
  type FittedRunLine,
  fitRunLine,
  fitToWidth,
  MAX_RUN_LABEL_WIDTH,
  type RunLineParts,
  type RunLinePolicy,
  runLineColumn,
  runLineParts,
} from "./run-line.ts";
import { runPresentationFromRow } from "./run-presentation.ts";

/**
 * The three surfaces' own policy values, driven directly.
 *
 * The widget-row, history-row and notice tests assert the exact strings those
 * surfaces paint, and they are what says the merge preserved their behaviour.
 * This one asserts the arithmetic underneath all three — the
 * budgets each policy states, and what gives way when they cannot all be met —
 * which is what a fourth surface would inherit by supplying a fourth policy.
 */
const HISTORY_RUN_LINE = historyRunLine({ label: 20, status: 10 });

/** The gaps each policy puts before its status word and its activity. */
const GAPS = { status: 2, activity: 3 };
const NO_GAPS = { status: 0, activity: 0 };

/** One Run's parts, from the fixture every presentation golden shares. */
function parts(overrides: Parameters<typeof fixtureRow>[0] = {}): RunLineParts {
  return runLineParts(
    runPresentationFromRow(fixtureRow(overrides)),
    FIXTURE_NOW,
  );
}

/** The columns the fitted parts occupy, gaps included but reservations not. */
function drawn(
  line: FittedRunLine,
  gaps: { readonly status: number; readonly activity: number },
): number {
  return (
    visibleWidth(line.label) +
    (line.status === undefined ? 0 : gaps.status + visibleWidth(line.status)) +
    (line.activity === undefined
      ? 0
      : gaps.activity + visibleWidth(line.activity)) +
    (line.duration === undefined ? 0 : line.gap + visibleWidth(line.duration))
  );
}

/** What the parts leave for the surface: everything but what it reserved. */
function shared(policy: RunLinePolicy, width: number): number {
  return Math.max(0, width - (policy.reserved ?? 0));
}

test("one wrapper clips, pads, and discards the resets a clip leaves in plain text", () => {
  assert.equal(fitToWidth("look around", 40), "look around");
  assert.equal(fitToWidth("look around", 7, { plain: true }), "look a…");
  assert.equal(fitToWidth("look around", 0), "");
  assert.equal(fitToWidth("look around", -5), "");
  assert.equal(fitToWidth("ab", 5, { pad: true }), "ab   ");
  assert.equal(fitToWidth("abcdef", 3, { pad: true, plain: true }), "ab…");
  // A wide grapheme is never split, and padding still fills the column.
  assert.equal(visibleWidth(fitToWidth("界".repeat(9), 5, { pad: true })), 5);
  // A plain caller paints its own text afterwards, so a reset the clip left
  // behind would close that paint several columns early. A caller whose text
  // is already painted needs that same reset kept.
  const painted = `\u001b[2m${"a".repeat(50)}\u001b[0m`;
  assert.ok(!fitToWidth(painted, 10, { plain: true }).includes("\u001b"));
  assert.ok(fitToWidth(painted, 10).includes("\u001b"));
});

test("a shared column is the widest value in a list, up to its cap", () => {
  assert.equal(runLineColumn(["One", "Longer label"]), 12);
  assert.equal(runLineColumn(["界".repeat(4)]), 8);
  assert.equal(runLineColumn([]), 0);
  assert.equal(
    runLineColumn(["a".repeat(80)], MAX_RUN_LABEL_WIDTH),
    MAX_RUN_LABEL_WIDTH,
  );
});

test("the Label cap has one owner, and a notice caps further still", () => {
  const long = parts({ identity: { description: "a".repeat(80) } });
  assert.equal(
    visibleWidth(fitRunLine(long, WIDGET_RUN_LINE, 200).label),
    MAX_RUN_LABEL_WIDTH,
  );
  assert.equal(
    visibleWidth(
      fitRunLine(long, historyRunLine({ label: 40, status: 10 }), 200).label,
    ),
    MAX_RUN_LABEL_WIDTH,
  );
  // The notice's own budget, which is the whole of its policy.
  assert.equal(visibleWidth(fitRunLine(long, NOTICE_RUN_LINE, 200).label), 48);
});

test("the widget's Label leads, and shrinks to a floor rather than vanishing", () => {
  const wide = fitRunLine(
    parts({ activity: "bash: npm test" }),
    WIDGET_RUN_LINE,
    120,
  );
  assert.deepEqual(
    [wide.label, wide.status, wide.activity, wide.duration],
    ["look around", "running", "bash: npm test", "12.4s"],
  );
  // The Label sizes to its own text, so what it does not use goes to the
  // activity and the right-aligned duration rather than being padded away.
  assert.equal(drawn(wide, GAPS), shared(WIDGET_RUN_LINE, 120));

  // Squeezed, the Label keeps a recognisable seven-column prefix and no less,
  // even though the activity beside it would take the columns.
  const squeezed = fitRunLine(
    parts({
      identity: { description: "a-very-long-work-label" },
      activity: "bash: npm test",
    }),
    WIDGET_RUN_LINE,
    31,
  );
  assert.equal(squeezed.label, "a-very…");
  assert.equal(squeezed.activity, "bash: npm t…");
});

test("the widget's activity gives way whole below the width at which it still names a tool", () => {
  const run = parts({ activity: "bash: npm test" });
  // Twelve columns is where `bash: npm t…` still says which tool. A column
  // narrower and the activity goes, rather than being cut to `bash: …`.
  assert.equal(
    visibleWidth(fitRunLine(run, WIDGET_RUN_LINE, 31).activity ?? ""),
    12,
  );
  const given = fitRunLine(run, WIDGET_RUN_LINE, 30);
  assert.equal(given.activity, undefined);
  assert.equal(given.status, "running");
  assert.equal(given.label, "look around");
});

test("the widget's duration reserves the right edge and yields when that costs activity", () => {
  const run = parts({ activity: "bash: npm test" });
  // Wide enough for all four: the duration is flush right, and its gap is
  // whatever the other three did not use.
  const four = fitRunLine(run, WIDGET_RUN_LINE, 44);
  assert.equal(four.duration, "12.4s");
  assert.equal(drawn(four, GAPS), 44);
  // Too narrow to reserve the clock without cutting the activity below its
  // floor: the clock is what gives, and the activity it crowded stays whole.
  const yielded = fitRunLine(run, WIDGET_RUN_LINE, 37);
  assert.equal(yielded.duration, undefined);
  assert.equal(yielded.gap, 0);
  assert.equal(yielded.activity, "bash: npm test");
});

test("the widget's status gives way only when the Label would have nothing beside it", () => {
  const run = parts({ activity: "bash: npm test" });
  // `running` and its two-column delimiter, leaving the Label its one column.
  const last = fitRunLine(run, WIDGET_RUN_LINE, 10);
  assert.deepEqual([last.label, last.status], ["…", "running"]);
  // One column narrower, the status goes — and the activity after it, because
  // a row with no room for its state word has none for what follows it.
  const narrower = fitRunLine(run, WIDGET_RUN_LINE, 9);
  assert.equal(narrower.label, "look aro…");
  assert.equal(narrower.status, undefined);
  assert.equal(narrower.activity, undefined);
});

test("the inset a policy states is the surface's, and the fitting never spends it", () => {
  // The widget insets the line it *contains* and hands the fitting a width the
  // inset has already come off, so a line fitted to 44 columns occupies 44.
  assert.equal(WIDGET_RUN_LINE.inset, 1);
  const line = fitRunLine(
    parts({ activity: "bash: npm test" }),
    WIDGET_RUN_LINE,
    44,
  );
  assert.equal(drawn(line, GAPS), 44);
});

test("the history's columns are shared and padded, so rows below each other line up", () => {
  const short = fitRunLine(
    parts({ identity: { description: "One" } }),
    HISTORY_RUN_LINE,
    120,
  );
  const long = fitRunLine(
    parts({ identity: { description: "Longer label here!!" } }),
    HISTORY_RUN_LINE,
    120,
  );
  // A short Label keeps its column rather than handing it to the activity, so
  // the status words below each other start in the same place.
  assert.equal(visibleWidth(short.label), 20);
  assert.equal(visibleWidth(long.label), 20);
  assert.equal(visibleWidth(short.status ?? ""), 10);
  assert.equal(
    visibleWidth(short.activity ?? ""),
    visibleWidth(long.activity ?? ""),
  );
  assert.equal(drawn(short, GAPS), shared(HISTORY_RUN_LINE, 120));
});

test("the history's status, activity and duration each appear at their own width", () => {
  const run = parts({ activity: "Reading middleware" });
  // A fixed eight columns, right-aligned in them, once the row reaches 80.
  assert.equal(fitRunLine(run, HISTORY_RUN_LINE, 79).duration, undefined);
  assert.equal(fitRunLine(run, HISTORY_RUN_LINE, 80).duration, "   12.4s");
  assert.equal(fitRunLine(run, HISTORY_RUN_LINE, 80).gap, 2);
  // The activity needs 50 columns beside the selection prefix, the status 24.
  assert.notEqual(fitRunLine(run, HISTORY_RUN_LINE, 52).activity, undefined);
  assert.equal(fitRunLine(run, HISTORY_RUN_LINE, 51).activity, undefined);
  assert.notEqual(fitRunLine(run, HISTORY_RUN_LINE, 26).status, undefined);
  assert.equal(fitRunLine(run, HISTORY_RUN_LINE, 25).status, undefined);
  // The columns the selection prefix costs are the table's, not the fit's: the
  // parts divide what is left, so a row that reserved two occupies 78 of 80.
  assert.equal(drawn(fitRunLine(run, HISTORY_RUN_LINE, 80), GAPS), 78);
});

test("a column of no Label still costs the delimiter the row draws after it", () => {
  // A list whose Labels are all empty sizes its Label column to nothing, and
  // the table still separates the prefix from the status word. The gap before
  // the duration has to know that, or the duration is pushed off the row.
  const empty = historyRunLine({ label: 0, status: 10 });
  const line = fitRunLine(parts({ activity: "grep: x" }), empty, 100);
  assert.equal(line.label, "");
  assert.equal(drawn(line, GAPS), 98);
  assert.equal(line.duration, "   12.4s");
});

test("a notice's fixed parts are columns already spent, and never the parts that give", () => {
  const run = parts();
  const spent = (reserved: number) =>
    fitRunLine(run, { ...NOTICE_RUN_LINE, reserved }, 40);
  assert.equal(spent(0).label, "look around");
  assert.equal(stripVTControlCharacters(spent(32).label), "look ar…");
  // No column left for even one of the Label: it goes whole rather than
  // leaving a fragment, and nothing is taken back from what was spent.
  assert.equal(spent(40).label, "");
  assert.equal(spent(60).label, "");
  assert.equal(spent(40).status, undefined);
});

test("every policy elides rather than overflowing, at every width down to nothing", () => {
  const policies = [
    ["widget", WIDGET_RUN_LINE, GAPS],
    ["history", HISTORY_RUN_LINE, GAPS],
    ["notice", NOTICE_RUN_LINE, NO_GAPS],
  ] as const;
  for (const run of [
    parts({ activity: "bash: npm test" }),
    parts({
      identity: { description: "任务 café 👩‍💻 é".repeat(20) },
      activity: "界".repeat(100),
    }),
    parts({ phase: "cancelled", cancellation: { reason: "timeout" } }),
  ]) {
    for (const [name, policy, gaps] of policies) {
      for (let width = 0; width <= 160; width += 1) {
        const line = fitRunLine(run, policy, width);
        assert.ok(
          drawn(line, gaps) <= shared(policy, width),
          `${name} at ${width}: ${JSON.stringify(line)}`,
        );
        assert.doesNotMatch(line.label, /\ufffd/, `${name} at ${width}`);
      }
      // Nothing at all is a Label of nothing, never a fragment of chrome.
      assert.deepEqual(fitRunLine(run, policy, 0), { label: "", gap: 0 });
    }
  }
});
