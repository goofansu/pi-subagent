import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import { formatTurns, runPhaseVerb } from "./status.ts";

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

/** A Label gets its own line, so optional activity cannot replace task identity. */
export function historyRow(
  run: RunSummary,
  width: number,
  identity: string,
  subagentPhase?: string,
  now?: number,
): readonly string[] {
  const clip = (text: string, columns = width) =>
    truncateToWidth(text, Math.max(0, columns), "…");
  const status =
    [subagentPhase, runPhaseVerb(run.phase)].filter(Boolean).join(" · ") +
    (run.cancellationReason ? ` (${run.cancellationReason})` : "");
  const profileWidth = Math.max(1, Math.floor(width / 3));
  const activity = now === undefined ? run.activity : run.lastActivity?.summary;
  const age =
    now !== undefined && run.lastActivity
      ? ` · changed ${Math.max(0, Math.floor((now - run.lastActivity.changedAt) / 1000))}s ago`
      : "";
  return [
    clip(
      `${clip(run.profile, profileWidth)}  ${status}  ${formatTurns(run.turns)}  ${run.backend}  ${identity}`,
    ),
    clip(`Label: ${run.label}${activity ? ` · ${activity}${age}` : ""}`),
  ];
}
