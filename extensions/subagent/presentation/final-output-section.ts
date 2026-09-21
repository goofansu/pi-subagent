/**
 * The one presentation owner of what a Run says about its final output.
 *
 * Callers provide the domain interpretation and only the framing their surface
 * knows: whether the capture is active or terminal, whether status belongs in
 * this section, and whether a notice carries the retained value whole or as a
 * preview. The returned value keeps prose separate from layout so plain-text
 * cards and TUI blocks can render the same section without reinterpreting
 * retention.
 */

import {
  type CancellationReason,
  type DiagnosticCategory,
  type FinalOutputInterpretation,
  type NotificationFinalOutput,
  notificationFinalOutputOf,
  type RunId,
  type RunNotification,
  type RunResult,
} from "../domain/index.ts";

type FinalOutputBlockKind = "markdown" | "literal";

interface FinalOutputBlock {
  readonly kind: FinalOutputBlockKind;
  readonly text: string;
}

/** The bounded final-output meaning needed by a collapsed Result row. */
export type CompactFinalOutputSummary =
  | { readonly kind: "none" }
  | { readonly kind: "removed" }
  | { readonly kind: "visible"; readonly characters: number };

export interface FinalOutputSection {
  /** A retention warning, placed immediately before the body or explanation. */
  readonly qualifier?: string;
  /** Retained output, or terminal status context that precedes an explanation. */
  readonly body?: FinalOutputBlock;
  /** Why no retained output body can be shown. */
  readonly explanation?: string;
  /** An inspection-only note about the retained record, after the explanation. */
  readonly recordNote?: FinalOutputBlock;
}

/** How a caller frames the retained value. */
type FinalOutputPresentation =
  | { readonly kind: "result" }
  | { readonly kind: "inspection" }
  | {
      readonly kind: "notice-inline";
      readonly runId: RunId;
    }
  | {
      readonly kind: "notice-preview";
      readonly runId: RunId;
      readonly preview: string;
    };

type FinalOutputFraming =
  | {
      readonly capture: "active";
      readonly status: "running" | "finalizing";
      readonly presentation: FinalOutputPresentation;
    }
  | ({
      readonly capture: "terminal";
      readonly presentation: FinalOutputPresentation;
    } & (
      | { readonly status: "completed" }
      | { readonly status: "failed"; readonly failure?: string }
      | {
          readonly status: "cancelled";
          readonly cancellationReason?: CancellationReason;
        }
    ));

const CANCELLED_WITHOUT_OUTPUT =
  "The Run was cancelled before producing output.";
const FAILED_WITHOUT_OUTPUT = "The Run failed before producing output.";
const COMPLETED_WITHOUT_OUTPUT = "The Run finished without output.";
const INSPECTION_WITHOUT_OUTPUT = "No final output was produced.";

/** The dedicated final-output field existed, but bounding removed all of it. */
const NO_FINAL_OUTPUT_REMAINS = "No final output remains in the Result.";

/** A byte count with stable thousands separators for presentation prose. */
export function formatByteCount(amount: number): string {
  return amount.toLocaleString("en-US");
}

function qualifier(removedBytes: number): string {
  return `${formatByteCount(removedBytes)} bytes of the final output were cut.`;
}

type FinalOutputValue = FinalOutputInterpretation | NotificationFinalOutput;
type RetainedFinalOutput = Extract<
  FinalOutputValue,
  { readonly kind: "retained" | "retained-prefix" }
>;

function retainedText(
  output: RetainedFinalOutput,
  framing: FinalOutputFraming,
): string {
  return framing.presentation.kind === "notice-preview"
    ? framing.presentation.preview
    : output.output;
}

function failedContext(failure: string | undefined): string {
  return [
    "This Run failed before completing.",
    ...(failure === undefined ? [] : [`Failure: ${failure}`]),
  ].join("\n\n");
}

function cancelledContext(reason: CancellationReason | undefined): string {
  return `This Run was cancelled before finishing${reason === undefined ? "" : ` (${reason})`}.`;
}

function statusBelongsInSection(framing: FinalOutputFraming): boolean {
  return framing.presentation.kind === "result";
}

function retainedBody(
  output: RetainedFinalOutput,
  framing: FinalOutputFraming,
): FinalOutputBlock {
  const value = retainedText(output, framing);
  if (
    !statusBelongsInSection(framing) ||
    framing.capture === "active" ||
    framing.status === "completed"
  ) {
    return { kind: "markdown", text: value };
  }
  if (framing.status === "failed") {
    return {
      kind: "markdown",
      text: `${failedContext(framing.failure)}\n\nOutput produced before failure:\n\n${value}`,
    };
  }
  return {
    kind: "markdown",
    text: `${cancelledContext(framing.cancellationReason)}\n\nOutput produced before cancellation:\n\n${value}`,
  };
}

function emptyRecordNote(
  output: Extract<FinalOutputValue, { readonly kind: "absent" }>,
  framing: FinalOutputFraming,
): FinalOutputBlock | undefined {
  if (
    output.kind !== "absent" ||
    output.hasTranscriptEvidence ||
    framing.presentation.kind !== "inspection"
  ) {
    return undefined;
  }
  return {
    kind: "literal",
    text:
      framing.capture === "active"
        ? "Active snapshot available but empty: no output or transcript retained yet."
        : "Result available but empty: no output or transcript was retained.",
  };
}

function outputBlock(label: string, output: string): FinalOutputBlock {
  return { kind: "literal", text: `${label}:\n"""\n${output}\n"""` };
}

type NoticePresentation = Extract<
  FinalOutputPresentation,
  { readonly kind: "notice-inline" | "notice-preview" }
>;
type NoticeFraming = FinalOutputFraming & {
  readonly presentation: NoticePresentation;
};

function noticeCall(framing: NoticeFraming): string {
  return `agent_result with {"id":"${framing.presentation.runId}"}`;
}

function noticeStatusBody(
  framing: NoticeFraming,
  retained?: { readonly output: string; readonly label: string },
): FinalOutputBlock | undefined {
  const inlined = framing.presentation.kind === "notice-inline";
  if (framing.status === "failed") {
    const reason = `Reason: ${framing.failure || "none reported."}`;
    return {
      kind: "literal",
      text:
        inlined && retained !== undefined
          ? `${reason}\n\n${outputBlock("Output produced before failure", retained.output).text}`
          : reason,
    };
  }
  if (framing.status === "cancelled") {
    return inlined && retained !== undefined
      ? outputBlock("Output produced before cancellation", retained.output)
      : undefined;
  }
  if (retained === undefined || (!inlined && retained.output === "")) {
    return undefined;
  }
  return inlined
    ? outputBlock("Output from the subagent", retained.output)
    : {
        kind: "literal",
        text: `${retained.label}:\n"${retained.output}"`,
      };
}

function noticeRetainedSection(
  output: RetainedFinalOutput,
  framing: NoticeFraming,
  prefixRemovedBytes?: number,
): FinalOutputSection {
  const value = retainedText(output, framing);
  const body = noticeStatusBody(framing, {
    output: value,
    label:
      prefixRemovedBytes === undefined
        ? "Preview from the subagent"
        : "Preview of the retained output prefix",
  });
  const call = noticeCall(framing);
  const inlined = framing.presentation.kind === "notice-inline";
  const explanation =
    prefixRemovedBytes === undefined
      ? inlined
        ? framing.status === "completed"
          ? `This is the complete output; nothing further to fetch. ${call} re-reads it with the transcript.`
          : `This is all the output the Run produced. ${call} re-reads it with the transcript.`
        : framing.status === "completed"
          ? `The result is available. Call ${call}.`
          : `Partial output is available. Call ${call}.`
      : inlined
        ? `This is the retained output prefix; ${formatByteCount(prefixRemovedBytes)} bytes were removed by retention bounds. ${call} re-reads it with the transcript.`
        : `A retained output prefix is available; ${formatByteCount(prefixRemovedBytes)} bytes were removed by retention bounds. Call ${call}.`;
  return { ...(body === undefined ? {} : { body }), explanation };
}

function noticeRemovedSection(
  output: Extract<FinalOutputValue, { readonly kind: "removed" }>,
  framing: NoticeFraming,
): FinalOutputSection {
  const body = noticeStatusBody(framing);
  return {
    ...(body === undefined ? {} : { body }),
    explanation: `Final output was produced, but none remains in the Run record; ${formatByteCount(output.removedBytes)} bytes were removed by retention bounds.${
      output.hasTranscriptEvidence
        ? " Supporting transcript evidence remains."
        : ""
    } Call ${noticeCall(framing)}.`,
  };
}

function noticeAbsentSection(
  output: Extract<FinalOutputValue, { readonly kind: "absent" }>,
  framing: NoticeFraming,
): FinalOutputSection {
  const body = noticeStatusBody(framing);
  return {
    ...(body === undefined ? {} : { body }),
    explanation: output.hasTranscriptEvidence
      ? `No final output was produced. Supporting transcript evidence is available. Call ${noticeCall(framing)}.`
      : `No output was produced. The Run record is available. Call ${noticeCall(framing)}.`,
  };
}

function isNoticeFraming(
  framing: FinalOutputFraming,
): framing is NoticeFraming {
  return (
    framing.presentation.kind === "notice-inline" ||
    framing.presentation.kind === "notice-preview"
  );
}

type FinalOutputDispatchMode =
  | { readonly kind: "summary" }
  | { readonly kind: "section"; readonly framing: FinalOutputFraming };

function dispatchFinalOutput(
  output: FinalOutputValue,
  mode: Extract<FinalOutputDispatchMode, { readonly kind: "summary" }>,
): CompactFinalOutputSummary;
function dispatchFinalOutput(
  output: FinalOutputValue,
  mode: Extract<FinalOutputDispatchMode, { readonly kind: "section" }>,
): FinalOutputSection;
function dispatchFinalOutput(
  output: FinalOutputValue,
  mode: FinalOutputDispatchMode,
): CompactFinalOutputSummary | FinalOutputSection {
  switch (output.kind) {
    case "retained": {
      if (mode.kind === "summary") {
        return { kind: "visible", characters: output.output.length };
      }
      const { framing } = mode;
      return isNoticeFraming(framing)
        ? noticeRetainedSection(output, framing)
        : { body: retainedBody(output, framing) };
    }
    case "retained-prefix": {
      if (mode.kind === "summary") {
        return { kind: "visible", characters: output.output.length };
      }
      const { framing } = mode;
      return isNoticeFraming(framing)
        ? noticeRetainedSection(output, framing, output.removedBytes)
        : {
            qualifier: qualifier(output.removedBytes),
            body: retainedBody(output, framing),
          };
    }
    case "removed": {
      if (mode.kind === "summary") return { kind: "removed" };
      const { framing } = mode;
      if (isNoticeFraming(framing)) {
        return noticeRemovedSection(output, framing);
      }
      const retentionQualifier = qualifier(output.removedBytes);
      if (framing.capture === "active") {
        return {
          qualifier: retentionQualifier,
          explanation: "No output remains in this snapshot.",
        };
      }
      if (!statusBelongsInSection(framing)) {
        return {
          qualifier: retentionQualifier,
          explanation: NO_FINAL_OUTPUT_REMAINS,
        };
      }
      if (framing.status === "failed") {
        return {
          qualifier: retentionQualifier,
          body: { kind: "literal", text: failedContext(framing.failure) },
          explanation: NO_FINAL_OUTPUT_REMAINS,
        };
      }
      if (framing.status === "cancelled") {
        return {
          qualifier: retentionQualifier,
          body: {
            kind: "literal",
            text: cancelledContext(framing.cancellationReason),
          },
          explanation: NO_FINAL_OUTPUT_REMAINS,
        };
      }
      return {
        qualifier: retentionQualifier,
        explanation: NO_FINAL_OUTPUT_REMAINS,
      };
    }
    case "absent": {
      if (mode.kind === "summary") return { kind: "none" };
      const { framing } = mode;
      if (isNoticeFraming(framing)) {
        return noticeAbsentSection(output, framing);
      }
      const recordNote = emptyRecordNote(output, framing);
      if (framing.capture === "active") {
        return {
          explanation: "No output produced yet.",
          ...(recordNote === undefined ? {} : { recordNote }),
        };
      }
      if (!statusBelongsInSection(framing)) {
        return {
          explanation: INSPECTION_WITHOUT_OUTPUT,
          ...(recordNote === undefined ? {} : { recordNote }),
        };
      }
      if (framing.status === "failed") {
        return {
          body: { kind: "literal", text: failedContext(framing.failure) },
          explanation: FAILED_WITHOUT_OUTPUT,
        };
      }
      if (framing.status === "cancelled") {
        const reason =
          framing.cancellationReason === undefined
            ? ""
            : ` (${framing.cancellationReason})`;
        return {
          explanation: `${CANCELLED_WITHOUT_OUTPUT.slice(0, -1)}${reason}.`,
        };
      }
      return { explanation: COMPLETED_WITHOUT_OUTPUT };
    }
  }
}

/** Build the bounded summary used by compact final-output surfaces. */
export function finalOutputSummary(
  output: FinalOutputInterpretation,
): CompactFinalOutputSummary {
  return dispatchFinalOutput(output, { kind: "summary" });
}

/** Build the qualifier, body, and explanation for one final-output section. */
export function finalOutputSection(
  output: FinalOutputValue,
  framing: FinalOutputFraming,
): FinalOutputSection {
  return dispatchFinalOutput(output, { kind: "section", framing });
}

/** Build the self-contained answer section carried by a Notification. */
export function notificationFinalOutputSection(
  notice: RunNotification,
): FinalOutputSection {
  const presentation: FinalOutputPresentation =
    notice.output === undefined
      ? { kind: "notice-preview", runId: notice.runId, preview: notice.preview }
      : { kind: "notice-inline", runId: notice.runId };
  const framing: FinalOutputFraming =
    notice.status === "completed"
      ? { capture: "terminal", status: "completed", presentation }
      : notice.status === "failed"
        ? {
            capture: "terminal",
            status: "failed",
            presentation,
            ...(notice.errorMessage === undefined
              ? {}
              : { failure: notice.errorMessage }),
          }
        : {
            capture: "terminal",
            status: "cancelled",
            presentation,
            ...(notice.cancellationReason === undefined
              ? {}
              : { cancellationReason: notice.cancellationReason }),
          };
  return finalOutputSection(notificationFinalOutputOf(notice), framing);
}

/** Plain lines for callers that do not preserve semantic block kinds. */
export function finalOutputSectionLines(
  section: FinalOutputSection,
): readonly string[] {
  return [
    section.qualifier,
    section.body?.text,
    section.explanation,
    section.recordNote?.text,
  ].filter((line): line is string => line !== undefined);
}

const FAILURE_CATEGORIES: readonly DiagnosticCategory[] = [
  "backend-failure",
  "transport-loss",
  "cleanup-escalation",
];

function primaryFailure(result: RunResult): string | undefined {
  if (result.errorMessage !== undefined && result.errorMessage !== "") {
    return result.errorMessage;
  }
  return result.diagnostics.find((diagnostic) =>
    FAILURE_CATEGORIES.includes(diagnostic.category),
  )?.message;
}

/** Build terminal status framing from the authoritative Result. */
export function resultFinalOutputFraming(
  result: RunResult,
  presentation: FinalOutputPresentation = { kind: "result" },
): FinalOutputFraming {
  switch (result.status) {
    case "completed":
      return { capture: "terminal", status: "completed", presentation };
    case "failed": {
      const failure = primaryFailure(result);
      return {
        capture: "terminal",
        status: "failed",
        presentation,
        ...(failure === undefined ? {} : { failure }),
      };
    }
    case "cancelled":
      return {
        capture: "terminal",
        status: "cancelled",
        presentation,
        ...(result.cancellationReason === undefined
          ? {}
          : { cancellationReason: result.cancellationReason }),
      };
  }
}
