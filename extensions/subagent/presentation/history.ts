import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import { padBrowserLine } from "./browser-panel.ts";
import { MAX_RUN_LABEL_WIDTH } from "./labels.ts";
import type { RenderableTheme } from "./rows.ts";
import { formatRunElapsed, runPhaseTone } from "./status.ts";

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

const statusText = (run: RunSummary) =>
  run.phase[0].toUpperCase() + run.phase.slice(1);

/** Content-sized columns shared by every row in one displayed list. */
function historyColumnWidths(runs: readonly RunSummary[]): HistoryColumnWidths {
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
  const latest = subagent.latest;
  return latest.phase === "failed" ||
    (latest.phase === "cancelled" && latest.cancellationReason === "timeout")
    ? "Needs attention"
    : "Completed";
}

/** Render one displayed list, including shared measurements and selection surface. */
export function historyRows(
  runs: readonly RunSummary[],
  selectedIdentity: RunId | SubagentId | undefined,
  width: number,
  theme: RenderableTheme,
  capturedAt: number,
): string[] {
  const preferredColumns = historyColumnWidths(runs);
  return runs.map((run) => {
    const selected =
      run.runId === selectedIdentity || run.subagentId === selectedIdentity;
    const row = historyRow(
      run,
      width,
      theme,
      selected,
      capturedAt,
      preferredColumns,
    );
    return selected ? theme.bg("selectedBg", padBrowserLine(row, width)) : row;
  });
}

/** One borderless table row. Widths depend on the viewport, never on selection or content. */
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
  const status = statusText(run);
  const tone =
    run.phase === "cancelled"
      ? run.cancellationReason === "timeout"
        ? "error"
        : "muted"
      : runPhaseTone(run.phase);
  // A terminal Run's last tool activity is not its result. Keep that in inspection.
  const activity =
    run.phase === "running" || run.phase === "finalizing"
      ? (run.activity ?? run.lastActivity?.summary ?? "—")
      : (run.cancellationReason ?? "—");
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
