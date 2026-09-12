import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  isTerminalRunPhase,
  type ToolEntry,
  type TranscriptItem,
} from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import type { RenderableTheme } from "./rows.ts";
import {
  formatDiagnosticLine,
  formatOutputTruncation,
  formatResultLinkLine,
  formatToolStatus,
  formatTruncation,
} from "./run-card.ts";
import { runPresentationFromSummary } from "./run-presentation.ts";
import { fitToWidth } from "./text-width.ts";
import type { HandoffStatus } from "./views.ts";

export interface InspectionBlock {
  readonly kind: "heading" | "literal" | "muted" | "markdown";
  readonly text: string;
  /** Rendered-line budget used for compact transcript text. */
  readonly transcriptPreviewLines?: number;
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
    add("heading", title);
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
  // The stored Result is the authoritative account of a Run that has one, and
  // `run-presentation.ts` is where that preference and the Run's meaning are
  // decided.
  const run = runPresentationFromSummary(summary, result);
  add("heading", run.label);
  add("literal", "");

  const usage = result?.usage ?? capture.usage;
  const { input, output, cacheRead, cacheWrite, cost } = usage.totals;
  const totalTokens = input + output + cacheRead + cacheWrite;
  const fact = (label: string, value: string | number) =>
    `${`${label}:`.padEnd(20)}${value}`;
  const instant = (milliseconds: number) => {
    const iso = new Date(milliseconds).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  };
  add(
    "literal",
    fact("profile", summary.profile),
    fact("backend", summary.backend),
    ...(stored?.model === undefined ? [] : [fact("model", stored.model)]),
    fact(
      "status",
      `${run.status.text}${run.cancellationReason ? ` (${run.cancellationReason})` : ""}`,
    ),
    fact("created", instant(run.startedAt)),
    ...(run.settledAt === undefined
      ? []
      : [fact("settled", instant(run.settledAt))]),
    "",
    fact("input tokens", input.toLocaleString("en-US")),
    fact("output tokens", output.toLocaleString("en-US")),
    fact("cache read tokens", cacheRead.toLocaleString("en-US")),
    fact("cache write tokens", cacheWrite.toLocaleString("en-US")),
    fact("total tokens", totalTokens.toLocaleString("en-US")),
    "",
    fact("turns", usage.turns),
    fact("cost", `$${cost.toFixed(4)}`),
  );

  section("Metadata");
  add("muted", `Subagent: ${summary.subagentId}`, `Run: ${capture.runId}`);
  if (subagent?.conversationLost)
    add("literal", "Conversation unavailable for resume");
  if (handoff === "exhausted")
    add("literal", "Completion hand-off: notification failed (exhausted)");
  if (handoff === "unannounceable")
    add("literal", "Completion hand-off: unannounceable");

  // Put the Run's answer after the quick operational facts, then its supporting
  // tool and transcript evidence. Any retention warning stays with the answer
  // it qualifies instead of becoming a disconnected section.
  if (stored) {
    section(capture.outcome === "active" ? "Output so far" : "Final output");
    const outputTruncation = formatOutputTruncation(
      stored.truncation.truncatedOutputBytes,
    );
    const truncation = formatTruncation(stored);
    if (outputTruncation !== undefined) add("literal", outputTruncation);
    if (stored.finalOutput) add("markdown", stored.finalOutput);
    else if (stored.truncation.truncatedOutputBytes > 0)
      add(
        "literal",
        capture.outcome === "active"
          ? "No output remains in this snapshot."
          : "No final output remains in the Result.",
      );
    else {
      add(
        "literal",
        capture.outcome === "active"
          ? "No output produced yet."
          : "No final output was produced.",
      );
      if (stored.transcript.length === 0 && truncation === undefined)
        add(
          "literal",
          capture.outcome === "active"
            ? "Active snapshot available but empty: no output or transcript retained yet."
            : "Result available but empty: no output or transcript was retained.",
        );
    }
    if (truncation) add("literal", truncation);
    if (stored.errorMessage !== undefined) {
      section("Error");
      add("literal", stored.errorMessage);
    }
    if (stored.diagnostics.length) {
      section("Diagnostics");
      add("literal", ...stored.diagnostics.map(formatDiagnosticLine));
    }
    if (stored.tools.length) {
      section("Tools");
      for (const tool of stored.tools) blocks.push(...toolBlocks(tool));
    }
  } else {
    add(
      "literal",
      "",
      capture.outcome === "ResultExpired"
        ? "Result expired: output is gone; retained metadata is shown below."
        : isTerminalRunPhase(run.phase)
          ? "Result unavailable: the stored result is missing or unreadable."
          : "Run unavailable: active snapshot could not be captured.",
    );
    if (capture.outcome === "unavailable" && capture.diagnostic)
      add("literal", formatDiagnosticLine(capture.diagnostic));
  }

  if (stored?.links.length) {
    section("Links");
    add("literal", ...stored.links.map(formatResultLinkLine));
  }

  // The unbounded-on-screen evidence appendix comes after every concise
  // operational section, without changing any retained item or part.
  if (stored?.transcript.length) {
    section("Transcript");
    let comparedModel = stored.model;
    for (const item of stored.transcript) {
      if (item.model !== undefined) {
        if (item.model !== comparedModel)
          add("muted", `Reported model: ${item.model}`);
        comparedModel = item.model;
      }
      blocks.push(...transcriptBlocks(item));
    }
  }
  return blocks;
}

/** Render complete Markdown blocks before slicing, so fences/lists survive scrolling. */
export function renderInspection(
  blocks: readonly InspectionBlock[],
  width: number,
  theme: RenderableTheme,
  transcriptExpanded: boolean,
): readonly string[] {
  return blocks
    .flatMap((block) => {
      const rendered =
        block.kind === "markdown"
          ? new Markdown(block.text, 0, 0, getMarkdownTheme()).render(
              Math.max(1, width),
            )
          : wrapTextWithAnsi(
              block.kind === "heading"
                ? theme.fg("accent", theme.bold(block.text))
                : block.kind === "muted"
                  ? theme.fg("dim", block.text)
                  : theme.fg("text", block.text),
              Math.max(1, width),
            );
      const limit = block.transcriptPreviewLines;
      if (transcriptExpanded || limit === undefined || rendered.length <= limit)
        return rendered;
      const headLines = Math.ceil((limit - 1) * 0.75);
      const tailLines = limit - headLines - 1;
      const hiddenLines = rendered.length - headLines - tailLines;
      return [
        ...rendered.slice(0, headLines),
        theme.fg(
          "dim",
          `… ${hiddenLines.toLocaleString()} wrapped lines hidden; press t to expand transcript …`,
        ),
        ...rendered.slice(-tailLines),
      ];
    })
    .map((line) => fitToWidth(line, width));
}

const ROLE_LABELS = {
  assistant: "Assistant:",
  user: "User:",
  tool: "Tool output:",
} as const satisfies Record<TranscriptItem["role"], string>;

const TRANSCRIPT_PREVIEW_LINES = 33;

function transcriptBlocks(item: TranscriptItem): readonly InspectionBlock[] {
  const blocks: InspectionBlock[] = [];
  let textAttributed = false;
  for (const part of item.parts) {
    if (part.kind === "tool_call") {
      blocks.push({ kind: "literal", text: `Tool call · ${part.name}` });
      textAttributed = false;
      continue;
    }
    if (!textAttributed) {
      blocks.push({ kind: "muted", text: ROLE_LABELS[item.role] });
      textAttributed = true;
    }
    blocks.push({
      kind: item.role === "assistant" ? "markdown" : "literal",
      text: part.text,
      transcriptPreviewLines: TRANSCRIPT_PREVIEW_LINES,
    });
  }
  if (item.parts.length === 0)
    blocks.push({ kind: "muted", text: ROLE_LABELS[item.role] });
  return blocks;
}
function toolBlocks(entry: ToolEntry): readonly InspectionBlock[] {
  return [
    { kind: "literal", text: formatToolStatus(entry) },
    ...(entry.outputSummary === undefined
      ? []
      : [{ kind: "literal" as const, text: entry.outputSummary }]),
  ];
}
