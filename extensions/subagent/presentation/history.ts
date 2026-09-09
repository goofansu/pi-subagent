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
  fitHistoryRunLines,
  type ResolvedRunLineContent,
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

/** Standalone structural seam for the optional failed terminal summary detail. */
type HistoryRunSummary = RunSummary & {
  readonly failureDetail?: string | undefined;
};

/** Resolve the history-only frozen outcome detail without changing shared activity. */
function historyOutcomeDetail(run: HistoryRunSummary): string {
  if (run.phase === "failed") {
    return run.failureDetail?.trim() ? run.failureDetail : "-";
  }
  if (run.phase === "cancelled") return run.cancellationReason ?? "-";
  return "-";
}

/** Supply geometric fitting only already-resolved text and elapsed duration. */
function historyContent(
  run: RunPresentation,
  outcomeDetail: string,
  now: number,
  prefix: string,
): ResolvedRunLineContent & { readonly prefix: string } {
  // This intentionally remains separate from widget assembly: history uses
  // heading case and contributes a selection prefix to shared measurement.
  // Its detail is a terminal outcome, not RunPresentation's shared activity.
  return {
    prefix,
    label: run.label,
    status: statusText(run),
    activity: outcomeDetail,
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

/** Render the overview with the shared live activity presentation unchanged. */
export function overviewRows(
  runs: readonly RunSummary[],
  selectedIdentity: RunId | SubagentId | undefined,
  width: number,
  theme: RenderableTheme,
  capturedAt: number,
): string[] {
  return renderRows(
    runs,
    selectedIdentity,
    width,
    theme,
    capturedAt,
    (_run, presentation) => presentation.activity,
  );
}

/** Render one Subagent's Run history with frozen outcome details. */
export function historyRows(
  runs: readonly HistoryRunSummary[],
  selectedIdentity: RunId | SubagentId | undefined,
  width: number,
  theme: RenderableTheme,
  capturedAt: number,
): string[] {
  return renderRows(
    runs,
    selectedIdentity,
    width,
    theme,
    capturedAt,
    historyOutcomeDetail,
  );
}

/** Render one displayed list, including shared measurements and selection surface. */
function renderRows<T extends RunSummary>(
  runs: readonly T[],
  selectedIdentity: RunId | SubagentId | undefined,
  width: number,
  theme: RenderableTheme,
  capturedAt: number,
  detail: (run: T, presentation: RunPresentation) => string,
): string[] {
  // One resolution per Run: the shared column widths and the rows they size
  // read the same presentation rather than deriving each Run's meaning three
  // times.
  const resolved = runs.map((run) => {
    const selected =
      run.runId === selectedIdentity || run.subagentId === selectedIdentity;
    const presentation = runPresentationFromSummary(run);
    return {
      presentation,
      outcomeDetail: detail(run, presentation),
      selected,
      prefix: selected ? SELECTED_PREFIX : UNSELECTED_PREFIX,
    };
  });
  const fittedRows = fitHistoryRunLines(
    resolved.map(({ presentation, outcomeDetail, prefix }) =>
      historyContent(presentation, outcomeDetail, capturedAt, prefix),
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
