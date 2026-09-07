/**
 * The dashboard history's table of Runs: one borderless row each.
 *
 * The fitting is `run-line.ts`'s under {@link historyRunLine}; what is left
 * here is the paint and the grouping. The policy is content-sized shared
 * columns — a list measures its own widest Label and status word once, so the
 * rows below each other line up — with a selection prefix at the left and a
 * duration once the screen is wide enough to spend eight columns on one.
 */

import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import type { RenderableTheme } from "./rows.ts";
import {
  fitRunLine,
  fitToWidth,
  MAX_RUN_LABEL_WIDTH,
  type RunLinePolicy,
  runLineColumn,
  runLineParts,
} from "./run-line.ts";
import {
  type RunPresentation,
  runPresentationFromSummary,
} from "./run-presentation.ts";

export const HISTORY_CATEGORIES = [
  "Active",
  "Needs attention",
  "Completed",
] as const;
export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];

export interface HistoryColumnWidths {
  readonly label: number;
  readonly status: number;
}

/** A table column reads as a heading; the shared status word does not. */
const statusText = (run: RunPresentation) =>
  run.status.text[0].toUpperCase() + run.status.text.slice(1);

/** Content-sized columns shared by every row in one displayed list. */
function historyColumnWidths(
  runs: readonly RunPresentation[],
): HistoryColumnWidths {
  return {
    label: runLineColumn(
      runs.map((run) => run.label),
      MAX_RUN_LABEL_WIDTH,
    ),
    status: runLineColumn(runs.map(statusText)),
  };
}

/**
 * The history's column budgets: content-sized shared columns.
 *
 * The two columns a list measured for itself are fixed here, so every row pads
 * to them rather than sizing to its own text; the selection prefix is columns
 * the table has already spent. The status word appears once the row has 24
 * columns to share and the activity once it has 50 — below those a clipped
 * fragment of either says less than the Label alone. Elapsed duration takes a
 * fixed eight columns above 80, which is where a row can afford them.
 */
export function historyRunLine(columns: HistoryColumnWidths): RunLinePolicy {
  return {
    reserved: UNSELECTED_PREFIX.length,
    padded: true,
    label: { column: columns.label },
    status: {
      column: columns.status,
      gate: STATUS_GATE,
      gap: STATUS_DELIMITER.length,
    },
    activity: {
      share: ACTIVITY_SHARE,
      gate: ACTIVITY_GATE,
      gap: ACTIVITY_DELIMITER.length,
    },
    duration: {
      column: ELAPSED_WIDTH,
      minLineWidth: ELAPSED_MIN_LINE_WIDTH,
      gap: DURATION_DELIMITER.length,
    },
  };
}

/** The selection prefix `› `, and the blank that stands in its place. */
const SELECTED_PREFIX = "› ";
const UNSELECTED_PREFIX = "  ";

/** The Label and the status word are separated by two spaces. */
const STATUS_DELIMITER = "  ";
/** The status word and the activity, by a dim dot. */
const ACTIVITY_DELIMITER = " · ";
/** The activity and the elapsed duration, by two spaces again. */
const DURATION_DELIMITER = "  ";

/** Elapsed duration takes this fixed column, once the row can afford it. */
const ELAPSED_WIDTH = 8;
const ELAPSED_MIN_LINE_WIDTH = 80;

/** Below these a clipped fragment says less than the Label alone. */
const STATUS_GATE = 24;
const ACTIVITY_GATE = 50;

/** The activity holds back this fraction of the row before the Label sizes. */
const ACTIVITY_SHARE = 0.45;

/** Broken work only. Delivery, diagnostics and Conversation maintenance are not inputs. */
export function historyCategory(subagent: SubagentSummary): HistoryCategory {
  if (subagent.current) return "Active";
  return runPresentationFromSummary(subagent.latest).executionNeedsAttention
    ? "Needs attention"
    : "Completed";
}

/**
 * How many Subagents sit in each category, counted by the one rule above.
 *
 * The overview's sections and its header report the same population, so they
 * read it through the same classifier: a second count written beside this one
 * could say a Subagent needs attention while the list files it under
 * completed.
 */
export function historyCategoryCounts(
  subagents: readonly SubagentSummary[],
): Readonly<Record<HistoryCategory, number>> {
  const counts: Record<HistoryCategory, number> = {
    Active: 0,
    "Needs attention": 0,
    Completed: 0,
  };
  for (const subagent of subagents) counts[historyCategory(subagent)] += 1;
  return counts;
}

/** Render one displayed list, including shared measurements and selection surface. */
export function historyRows(
  runs: readonly RunSummary[],
  selectedIdentity: RunId | SubagentId | undefined,
  width: number,
  theme: RenderableTheme,
  capturedAt: number,
): string[] {
  // One resolution per Run: the shared column widths and the rows they size
  // read the same presentation rather than deriving each Run's meaning three
  // times.
  const resolved = runs.map((run) => ({
    run,
    presentation: runPresentationFromSummary(run),
  }));
  const preferredColumns = historyColumnWidths(
    resolved.map(({ presentation }) => presentation),
  );
  return resolved.map(({ run, presentation }) => {
    const selected =
      run.runId === selectedIdentity || run.subagentId === selectedIdentity;
    const row = paintHistoryRow(
      presentation,
      width,
      theme,
      selected,
      capturedAt,
      preferredColumns,
    );
    return selected
      ? theme.bg("selectedBg", fitToWidth(row, width, { pad: true }))
      : row;
  });
}

/** One borderless table row. Widths depend on viewport and supplied content-sized columns, never selection. */
export function historyRow(
  run: RunSummary,
  width: number,
  theme: RenderableTheme,
  selected: boolean,
  now: number,
  preferredColumns: HistoryColumnWidths = {
    label: MAX_RUN_LABEL_WIDTH,
    status: 10,
  },
): string {
  return paintHistoryRow(
    runPresentationFromSummary(run),
    width,
    theme,
    selected,
    now,
    preferredColumns,
  );
}

/** Paint one already-resolved Run into the columns its list settled on. */
function paintHistoryRow(
  run: RunPresentation,
  width: number,
  theme: RenderableTheme,
  selected: boolean,
  now: number,
  preferredColumns: HistoryColumnWidths,
): string {
  const fitted = fitRunLine(
    { ...runLineParts(run, now), status: statusText(run) },
    historyRunLine(preferredColumns),
    width,
  );
  return fitToWidth(
    (selected ? theme.fg("accent", SELECTED_PREFIX) : UNSELECTED_PREFIX) +
      theme.fg(selected ? "accent" : "text", fitted.label) +
      (fitted.status === undefined
        ? ""
        : `${STATUS_DELIMITER}${theme.fg(run.status.tone, fitted.status)}`) +
      (fitted.activity === undefined
        ? ""
        : ` ${theme.fg("dim", "·")} ${theme.fg("muted", fitted.activity)}`) +
      (fitted.duration === undefined
        ? ""
        : `${" ".repeat(fitted.gap)}${theme.fg("dim", fitted.duration)}`),
    width,
  );
}
