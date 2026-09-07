import type { ToolEntry, TranscriptItem } from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import {
  formatDiagnosticLine,
  formatResultLinkLine,
  formatToolEntry,
  formatTranscriptItem,
  formatTruncation,
} from "./run-card.ts";
import { formatDuration } from "./status.ts";
import type { HandoffStatus } from "./views.ts";

/** All retained normalized content, not the compact RunCard preview. */
export function inspectionLines(
  capture: RunInspection,
  handoff: HandoffStatus,
): readonly string[] {
  const lines = [
    `Run: ${capture.runId}`,
    `Captured at: ${new Date(capture.capturedAt).toISOString()}`,
  ];
  if (capture.outcome === "unknown Run")
    return [...lines, "Unknown/unavailable Run in this Session."];
  const { summary, subagent } = capture;
  const result = capture.outcome === "result" ? capture.result : undefined;
  const startedAt = result?.startedAt ?? summary.startedAt;
  const settledAt = result?.settledAt ?? summary.settledAt;
  const cancellation = result?.cancellationReason ?? summary.cancellationReason;
  lines.push(
    `Subagent: ${summary.subagentId}`,
    `Profile: ${summary.profile} · backend: ${summary.backend}`,
    `Label: ${result?.description ?? summary.label}`,
    `Run status: ${result?.status ?? summary.phase}${cancellation ? ` (${cancellation})` : ""}`,
    ...(subagent ? [`Subagent phase: ${subagent.phase}`] : []),
    `Started at: ${new Date(startedAt).toISOString()}`,
    ...(settledAt === undefined
      ? []
      : [
          `Settled at: ${new Date(settledAt).toISOString()}`,
          `Duration: ${formatDuration(Math.max(0, settledAt - startedAt))}`,
        ]),
    ...(subagent?.conversationLost
      ? ["Conversation unavailable for Resume"]
      : []),
    ...(handoff === "exhausted"
      ? ["Completion hand-off: notification failed (exhausted)"]
      : []),
    ...(handoff === "unannounceable"
      ? ["Completion hand-off: unannounceable"]
      : []),
  );
  const usage = result?.usage ?? capture.usage;
  lines.push(
    "",
    "Usage:",
    `Turns: ${usage.turns}`,
    ...Object.entries(usage.totals).map(([name, count]) => `${name}: ${count}`),
    `context tokens: ${usage.context.tokens}${usage.context.window === undefined ? "" : ` / ${usage.context.window}`}`,
  );
  if (capture.outcome !== "result") {
    lines.push(
      "",
      capture.outcome === "ResultExpired"
        ? "Result expired: output is gone; retained metadata is shown above."
        : capture.outcome === "RunNotTerminal"
          ? "Run is not terminal; terminal Result unavailable."
          : "Result unavailable: the stored Result is missing or unreadable.",
    );
    if (capture.outcome === "unavailable" && capture.diagnostic)
      lines.push(formatDiagnosticLine(capture.diagnostic));
    return lines;
  }
  const stored = capture.result;
  const section = (title: string, values: readonly string[]) => {
    if (values.length) lines.push("", `${title}:`, ...values);
  };
  if (stored.model !== undefined) lines.push(`Model: ${stored.model}`);
  if (stored.errorMessage !== undefined)
    section("Error", [stored.errorMessage]);
  section("Transcript", stored.transcript.flatMap(transcriptLines));
  section("Tools", stored.tools.flatMap(toolLines));
  section("Diagnostics", stored.diagnostics.map(formatDiagnosticLine));
  section("Links", stored.links.map(formatResultLinkLine));
  const truncation = formatTruncation(stored);
  if (truncation) section("Truncation", [truncation]);
  section("Final output", [
    stored.finalOutput || "No final output was produced.",
  ]);
  if (!stored.finalOutput && stored.transcript.length === 0)
    lines.push(
      "Result available but empty: no output or transcript was retained.",
    );
  return lines;
}

function transcriptLines(item: TranscriptItem): readonly string[] {
  return [
    `${item.role}${item.model === undefined ? "" : ` (model: ${item.model})`}:`,
    ...item.parts.map((part) =>
      part.kind === "text"
        ? part.text
        : `${formatTranscriptItem({ role: item.role, parts: [part] })}${part.callId === undefined ? "" : ` · callId: ${part.callId}`}`,
    ),
  ];
}
function toolLines(entry: ToolEntry): readonly string[] {
  return [
    formatToolEntry({ ...entry, outputSummary: undefined }),
    ...(entry.callId === undefined ? [] : [`callId: ${entry.callId}`]),
    ...(entry.outputSummary === undefined ? [] : [entry.outputSummary]),
  ];
}
