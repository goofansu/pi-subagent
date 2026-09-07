import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RenderableTheme } from "./rows.ts";
import { formatDuration, runPhaseTone } from "./status.ts";

export const HISTORY_CATEGORIES = [
  "Active",
  "Needs attention",
  "Completed",
] as const;
export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];

/** Broken work only. Delivery, diagnostics and Conversation maintenance are not inputs. */
export function historyCategory(subagent: SubagentSummary): HistoryCategory {
  if (subagent.current) return "Active";
  const latest = subagent.latest;
  return latest.phase === "failed" ||
    (latest.phase === "cancelled" && latest.cancellationReason === "timeout")
    ? "Needs attention"
    : "Completed";
}

/** One borderless table row. Widths depend on the viewport, never on selection or content. */
export function historyRow(
  run: RunSummary,
  width: number,
  theme: RenderableTheme,
  selected: boolean,
  now: number,
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
  const statusWidth = available >= 24 ? 10 : 0;
  const activityWidth = available >= 50 ? Math.floor(available * 0.45) : 0;
  const labelWidth = Math.max(
    0,
    available -
      statusWidth -
      activityWidth -
      (statusWidth ? 2 : 0) -
      (activityWidth ? 2 : 0),
  );
  const status = run.phase[0].toUpperCase() + run.phase.slice(1);
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
  const end =
    run.phase === "running" || run.phase === "finalizing" ? now : run.settledAt;
  const elapsed =
    end === undefined ? "—" : formatDuration(Math.max(0, end - run.startedAt));
  const elapsedCell = clip(elapsed, elapsedWidth);
  return clip(
    (selected ? theme.fg("accent", "› ") : "  ") +
      theme.fg(selected ? "accent" : "text", cell(run.label, labelWidth)) +
      (statusWidth ? `  ${theme.fg(tone, cell(status, statusWidth))}` : "") +
      (activityWidth
        ? `  ${theme.fg("muted", cell(activity, activityWidth))}`
        : "") +
      (elapsedWidth
        ? `  ${theme.fg("dim", " ".repeat(Math.max(0, elapsedWidth - visibleWidth(elapsedCell))) + elapsedCell)}`
        : ""),
    width,
  );
}
