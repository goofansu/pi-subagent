import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import { MAX_RUN_LABEL_WIDTH } from "./labels.ts";
import type { RenderableTheme } from "./rows.ts";
import { formatRunElapsed, resolveRunPresentation } from "./status.ts";

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

const presentation = (run: RunSummary) =>
  resolveRunPresentation({
    phase: run.phase,
    cancellationRequested: run.cancellationReason !== undefined,
    ...(run.cancellationReason === undefined
      ? {}
      : { cancellationReason: run.cancellationReason }),
    ...(run.activity === undefined ? {} : { activity: run.activity }),
    ...(run.lastActivity === undefined
      ? {}
      : { lastActivity: run.lastActivity }),
  });

const statusText = (run: RunSummary) => {
  const text = presentation(run).status.text;
  return text[0].toUpperCase() + text.slice(1);
};

/** Content-sized columns shared by every row in one displayed list. */
export function historyColumnWidths(
  runs: readonly RunSummary[],
): HistoryColumnWidths {
  return {
    label: Math.min(
      MAX_RUN_LABEL_WIDTH,
      Math.max(0, ...runs.map((run) => visibleWidth(run.label))),
    ),
    status: Math.max(0, ...runs.map((run) => visibleWidth(statusText(run)))),
  };
}

/** Broken work only. Delivery, diagnostics and Conversation maintenance are not inputs. */
export function historyCategory(subagent: SubagentSummary): HistoryCategory {
  if (subagent.current) return "Active";
  return presentation(subagent.latest).executionNeedsAttention
    ? "Needs attention"
    : "Completed";
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
  const resolved = presentation(run);
  const status = statusText(run);
  const tone = resolved.status.tone;
  // A terminal Run's last tool activity is not its result. Keep that in inspection.
  const activity =
    run.phase === "completed" ||
    run.phase === "failed" ||
    run.phase === "cancelled"
      ? (run.cancellationReason ?? "—")
      : (resolved.currentActivity ?? "—");
  const elapsedCell = clip(formatRunElapsed(run, now), elapsedWidth);
  return clip(
    (selected ? theme.fg("accent", "› ") : "  ") +
      theme.fg(selected ? "accent" : "text", cell(run.label, labelWidth)) +
      (statusWidth ? `  ${theme.fg(tone, cell(status, statusWidth))}` : "") +
      (activityWidth
        ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", cell(activity, activityWidth))}`
        : "") +
      (elapsedWidth
        ? `  ${theme.fg("dim", " ".repeat(Math.max(0, elapsedWidth - visibleWidth(elapsedCell))) + elapsedCell)}`
        : ""),
    width,
  );
}
