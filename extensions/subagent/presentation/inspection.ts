import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToolEntry, TranscriptItem } from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import type { RenderableTheme } from "./rows.ts";
import {
  formatDiagnosticLine,
  formatResultLinkLine,
  formatToolStatus,
  formatTranscriptItem,
  formatTruncation,
} from "./run-card.ts";
import { formatDuration, resolveRunPresentation } from "./status.ts";
import type { HandoffStatus } from "./views.ts";

export interface InspectionBlock {
  readonly kind: "heading" | "literal" | "muted" | "markdown";
  readonly text: string;
}

/** Capture semantic blocks once; wrapping and Markdown rendering belong to the viewport. */
export function inspectionBlocks(
  capture: RunInspection,
  handoff: HandoffStatus,
): readonly InspectionBlock[] {
  const blocks: InspectionBlock[] = [];
  const add = (kind: InspectionBlock["kind"], ...texts: string[]) => {
    blocks.push(...texts.map((text) => ({ kind, text })));
  };
  const section = (title: string) => {
    add("literal", "");
    add("heading", `${title}:`);
  };
  if (capture.outcome === "unknown Run") {
    add(
      "muted",
      `Run: ${capture.runId}`,
      `Captured at: ${new Date(capture.capturedAt).toISOString()}`,
    );
    add("literal", "Unknown/unavailable run in this session.");
    return blocks;
  }
  const { summary, subagent } = capture;
  const result = capture.outcome === "result" ? capture.result : undefined;
  const stored =
    capture.outcome === "result"
      ? capture.result
      : capture.outcome === "active"
        ? capture.content
        : undefined;
  const cancellation = result?.cancellationReason ?? summary.cancellationReason;
  const presentation = resolveRunPresentation({
    phase: result?.status ?? summary.phase,
    cancellationRequested: cancellation !== undefined,
    cancellationReason: cancellation,
    activity: summary.activity,
    lastActivity: summary.lastActivity,
  });
  add("heading", `Label: ${result?.description ?? summary.label}`);
  add(
    "literal",
    `Profile: ${summary.profile} · backend: ${summary.backend}`,
    `Run status: ${presentation.status.text}${cancellation ? ` (${cancellation})` : ""}`,
  );

  // The answer is the primary reason to inspect; accounting and tool history follow it.
  if (stored) {
    section(capture.outcome === "active" ? "Output so far" : "Final output");
    if (stored.finalOutput) add("markdown", stored.finalOutput);
    else {
      add(
        "literal",
        capture.outcome === "active"
          ? "No output produced yet."
          : "No final output was produced.",
      );
      if (stored.transcript.length === 0)
        add(
          "literal",
          capture.outcome === "active"
            ? "Active snapshot available but empty: no output or transcript retained yet."
            : "Result available but empty: no output or transcript was retained.",
        );
    }
    if (stored.errorMessage !== undefined) {
      section("Error");
      add("literal", stored.errorMessage);
    }
  } else {
    add(
      "literal",
      "",
      capture.outcome === "ResultExpired"
        ? "Result expired: output is gone; retained metadata is shown below."
        : summary.phase === "running" || summary.phase === "finalizing"
          ? "Run unavailable: active snapshot could not be captured."
          : "Result unavailable: the stored result is missing or unreadable.",
    );
    if (capture.outcome === "unavailable" && capture.diagnostic)
      add("literal", formatDiagnosticLine(capture.diagnostic));
  }

  section("Metadata");
  const startedAt = result?.startedAt ?? summary.startedAt;
  const settledAt = result?.settledAt ?? summary.settledAt;
  add(
    "muted",
    `Run: ${capture.runId}`,
    `Subagent: ${summary.subagentId}`,
    `Captured at: ${new Date(capture.capturedAt).toISOString()}`,
  );
  if (subagent) add("literal", `Subagent phase: ${subagent.phase}`);
  add("literal", `Started at: ${new Date(startedAt).toISOString()}`);
  if (presentation.currentActivity)
    add("literal", `Current activity: ${presentation.currentActivity}`);
  if (presentation.lastActivity)
    add(
      "literal",
      `Last activity: ${presentation.lastActivity.summary} · changed ${formatDuration(capture.capturedAt - presentation.lastActivity.changedAt)} ago`,
    );
  if (settledAt !== undefined)
    add(
      "literal",
      `Settled at: ${new Date(settledAt).toISOString()}`,
      `Duration: ${formatDuration(Math.max(0, settledAt - startedAt))}`,
    );
  if (subagent?.conversationLost)
    add("literal", "Conversation unavailable for resume");
  if (handoff === "exhausted")
    add("literal", "Completion hand-off: notification failed (exhausted)");
  if (handoff === "unannounceable")
    add("literal", "Completion hand-off: unannounceable");
  if (stored?.model !== undefined) add("literal", `Model: ${stored.model}`);
  const usage = result?.usage ?? capture.usage;
  section("Usage");
  add(
    "literal",
    `Turns: ${usage.turns}`,
    ...Object.entries(usage.totals).map(([name, count]) => `${name}: ${count}`),
    `Context tokens: ${usage.context.tokens}${usage.context.window === undefined ? "" : ` / ${usage.context.window}`}`,
  );
  if (!stored) return blocks;

  if (stored.transcript.length) {
    section("Transcript");
    for (const item of stored.transcript) {
      add(
        "muted",
        `${item.role}${item.model === undefined ? "" : ` (model: ${item.model})`}:`,
      );
      blocks.push(...transcriptBlocks(item));
    }
  }
  if (stored.tools.length) {
    section("Tools");
    for (const tool of stored.tools) blocks.push(...toolBlocks(tool));
  }
  for (const [title, values] of [
    ["Diagnostics", stored.diagnostics.map(formatDiagnosticLine)],
    ["Links", stored.links.map(formatResultLinkLine)],
  ] as const) {
    if (values.length) {
      section(title);
      add("literal", ...values);
    }
  }
  const truncation = formatTruncation(stored);
  if (truncation) {
    section("Truncation");
    add("literal", truncation);
  }
  return blocks;
}

/** Render complete Markdown blocks before slicing, so fences/lists survive scrolling. */
export function renderInspection(
  blocks: readonly InspectionBlock[],
  width: number,
  theme: RenderableTheme,
): readonly string[] {
  return blocks
    .flatMap((block) => {
      if (block.kind === "markdown")
        return new Markdown(block.text, 0, 0, getMarkdownTheme()).render(
          Math.max(1, width),
        );
      const text =
        block.kind === "heading"
          ? theme.fg("accent", theme.bold(block.text))
          : block.kind === "muted"
            ? theme.fg("dim", block.text)
            : theme.fg("text", block.text);
      return wrapTextWithAnsi(text, Math.max(1, width));
    })
    .map((line) => truncateToWidth(line, Math.max(0, width), "…"));
}

function transcriptBlocks(item: TranscriptItem): readonly InspectionBlock[] {
  return item.parts.map((part) => ({
    kind:
      part.kind === "text" && item.role === "assistant"
        ? "markdown"
        : "literal",
    text:
      part.kind === "text"
        ? part.text
        : `${formatTranscriptItem({ role: item.role, parts: [part] })}${part.callId === undefined ? "" : ` · call ID: ${part.callId}`}`,
  }));
}
function toolBlocks(entry: ToolEntry): readonly InspectionBlock[] {
  return [
    { kind: "literal", text: formatToolStatus(entry) },
    ...(entry.callId === undefined
      ? []
      : [{ kind: "muted" as const, text: `Call ID: ${entry.callId}` }]),
    ...(entry.outputSummary === undefined
      ? []
      : [{ kind: "literal" as const, text: entry.outputSummary }]),
  ];
}
