/**
 * The dashboard history's table of Runs: one borderless row each.
 *
 * The fitting is `run-line.ts`'s history-list operation; what is left here is
 * paint and grouping. The layout is content-sized shared
 * columns — a list measures its own widest Label and status word once, so the
 * rows below each other line up — with a selection prefix at the left and a
 * duration once the screen is wide enough to spend eight columns on one.
 */

import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import type { RenderableTheme } from "./rows.ts";
import {
  type FittedRunLine,
  fitHistoryRunLine,
  fitHistoryRunLines,
  type ResolvedHistoryRunLineContent,
  RUN_STATUS_SEPARATOR,
  runActivitySeparator,
} from "./run-line.ts";
import {
  type RunPresentation,
  runElapsed,
  runPresentationFromSummary,
} from "./run-presentation.ts";
import { fitToWidth } from "./text-width.ts";

export const HISTORY_CATEGORIES = [
  "Active",
  "Needs attention",
  "Completed",
] as const;
export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];

/** A table column reads as a heading; the shared status word does not. */
const statusText = (run: RunPresentation) =>
  run.status.text[0].toUpperCase() + run.status.text.slice(1);

/** Supply geometric fitting only already-resolved text and elapsed duration. */
function historyContent(
  run: RunPresentation,
  now: number,
  prefix: string,
): ResolvedHistoryRunLineContent {
  return {
    prefix,
    label: run.label,
    status: statusText(run),
    activity: run.activity,
    duration: runElapsed(run, now),
  };
}

/** The selection prefix `› `, and the blank that stands in its place. */
const SELECTED_PREFIX = "› ";
const UNSELECTED_PREFIX = "  ";

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
  const resolved = runs.map((run) => {
    const selected =
      run.runId === selectedIdentity || run.subagentId === selectedIdentity;
    return {
      presentation: runPresentationFromSummary(run),
      selected,
      prefix: selected ? SELECTED_PREFIX : UNSELECTED_PREFIX,
    };
  });
  const fittedRows = fitHistoryRunLines(
    resolved.map(({ presentation, prefix }) =>
      historyContent(presentation, capturedAt, prefix),
    ),
    width,
  );
  return resolved.map(({ presentation, selected, prefix }, index) => {
    const row = paintHistoryRow(
      presentation,
      fittedRows[index] ?? { label: "", gap: 0 },
      width,
      theme,
      selected,
      prefix,
    );
    return selected
      ? theme.bg("selectedBg", fitToWidth(row, width, { pad: true }))
      : row;
  });
}

/** One borderless standalone row with the history surface's fixed fallback columns. */
export function historyRow(
  run: RunSummary,
  width: number,
  theme: RenderableTheme,
  selected: boolean,
  now: number,
): string {
  const presentation = runPresentationFromSummary(run);
  const prefix = selected ? SELECTED_PREFIX : UNSELECTED_PREFIX;
  return paintHistoryRow(
    presentation,
    fitHistoryRunLine(historyContent(presentation, now, prefix), width),
    width,
    theme,
    selected,
    prefix,
  );
}

/** Paint one already-resolved Run into the columns its list settled on. */
function paintHistoryRow(
  run: RunPresentation,
  fitted: FittedRunLine,
  width: number,
  theme: RenderableTheme,
  selected: boolean,
  prefix: string,
): string {
  return fitToWidth(
    (selected ? theme.fg("accent", prefix) : prefix) +
      theme.fg(selected ? "accent" : "text", fitted.label) +
      (fitted.status === undefined
        ? ""
        : `${RUN_STATUS_SEPARATOR}${theme.fg(run.status.tone, fitted.status)}`) +
      (fitted.activity === undefined
        ? ""
        : `${runActivitySeparator(theme.fg("dim", "·"))}${theme.fg("muted", fitted.activity)}`) +
      (fitted.duration === undefined
        ? ""
        : `${" ".repeat(fitted.gap)}${theme.fg("dim", fitted.duration)}`),
    width,
  );
}
