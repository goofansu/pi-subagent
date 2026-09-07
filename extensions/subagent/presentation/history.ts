import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import { padBrowserLine } from "./browser-panel.ts";
import { MAX_RUN_LABEL_WIDTH } from "./labels.ts";
import type { RenderableTheme } from "./rows.ts";
import { type RunFacts, runElapsed, runFactsFromSummary } from "./run-facts.ts";

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
const statusText = (facts: RunFacts) =>
  facts.status.text[0].toUpperCase() + facts.status.text.slice(1);

/** Content-sized columns shared by every row in one displayed list. */
function historyColumnWidths(facts: readonly RunFacts[]): HistoryColumnWidths {
  return {
    label: Math.min(
      MAX_RUN_LABEL_WIDTH,
      Math.max(0, ...facts.map((run) => visibleWidth(run.label))),
    ),
    status: Math.max(0, ...facts.map((run) => visibleWidth(statusText(run)))),
  };
}

/** Broken work only. Delivery, diagnostics and Conversation maintenance are not inputs. */
export function historyCategory(subagent: SubagentSummary): HistoryCategory {
  if (subagent.current) return "Active";
  return runFactsFromSummary(subagent.latest).executionNeedsAttention
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
  // read the same facts rather than deriving each Run's meaning three times.
  const resolved = runs.map((run) => ({
    run,
    facts: runFactsFromSummary(run),
  }));
  const preferredColumns = historyColumnWidths(
    resolved.map(({ facts }) => facts),
  );
  return resolved.map(({ run, facts }) => {
    const selected =
      run.runId === selectedIdentity || run.subagentId === selectedIdentity;
    const row = paintHistoryRow(
      facts,
      width,
      theme,
      selected,
      capturedAt,
      preferredColumns,
    );
    return selected ? theme.bg("selectedBg", padBrowserLine(row, width)) : row;
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
    runFactsFromSummary(run),
    width,
    theme,
    selected,
    now,
    preferredColumns,
  );
}

/** Paint one already-resolved Run into the columns its list settled on. */
function paintHistoryRow(
  facts: RunFacts,
  width: number,
  theme: RenderableTheme,
  selected: boolean,
  now: number,
  preferredColumns: HistoryColumnWidths,
): string {
  const clip = (text: string, columns: number) =>
    truncateToWidth(text, Math.max(0, columns), "…");
  const cell = (text: string, columns: number) => {
    const clipped = clip(text, columns);
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
  };
  const columns = Math.max(0, width - 2);
  const elapsedWidth = width >= 80 ? 8 : 0;
  const available = Math.max(
    0,
    columns - (elapsedWidth ? elapsedWidth + 2 : 0),
  );
  const statusWidth = available >= 24 ? preferredColumns.status : 0;
  const hasActivity = available >= 50;
  const separators = (statusWidth ? 2 : 0) + (hasActivity ? 3 : 0);
  const preferredActivityWidth = hasActivity ? Math.floor(available * 0.45) : 0;
  const labelWidth = Math.min(
    preferredColumns.label,
    Math.max(0, available - statusWidth - preferredActivityWidth - separators),
  );
  const activityWidth = hasActivity
    ? Math.max(0, available - statusWidth - labelWidth - separators)
    : 0;
  const status = statusText(facts);
  const elapsedCell = clip(runElapsed(facts, now), elapsedWidth);
  return clip(
    (selected ? theme.fg("accent", "› ") : "  ") +
      theme.fg(selected ? "accent" : "text", cell(facts.label, labelWidth)) +
      (statusWidth
        ? `  ${theme.fg(facts.status.tone, cell(status, statusWidth))}`
        : "") +
      (activityWidth
        ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", cell(facts.activity, activityWidth))}`
        : "") +
      (elapsedWidth
        ? `  ${theme.fg("dim", " ".repeat(Math.max(0, elapsedWidth - visibleWidth(elapsedCell))) + elapsedCell)}`
        : ""),
    width,
  );
}
