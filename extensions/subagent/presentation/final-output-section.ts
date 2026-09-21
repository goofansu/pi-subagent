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

import type {
  CancellationReason,
  DiagnosticCategory,
  FinalOutputInterpretation,
  RunResult,
} from "../domain/index.ts";

export type FinalOutputBlockKind = "markdown" | "literal";

export interface FinalOutputBlock {
  readonly kind: FinalOutputBlockKind;
  readonly text: string;
}

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
export type FinalOutputPresentation =
  | { readonly kind: "result" }
  | {
      readonly kind: "inspection";
      /** Preserve whether this capture currently shows an empty retained record. */
      readonly showEmptyRecordNote: boolean;
    }
  | { readonly kind: "notice-inline" }
  | { readonly kind: "notice-preview"; readonly preview: string };

export type FinalOutputFraming =
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
export const NO_FINAL_OUTPUT_REMAINS = "No final output remains in the Result.";

/** A byte count with stable thousands separators for presentation prose. */
export function formatByteCount(amount: number): string {
  return amount.toLocaleString("en-US");
}

function qualifier(removedBytes: number): string {
  return `${formatByteCount(removedBytes)} bytes of the final output were cut.`;
}

function retainedText(
  output: Extract<
    FinalOutputInterpretation,
    { readonly kind: "retained" | "retained-prefix" }
  >,
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
  output: Extract<
    FinalOutputInterpretation,
    { readonly kind: "retained" | "retained-prefix" }
  >,
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
  output: FinalOutputInterpretation,
  framing: FinalOutputFraming,
): FinalOutputBlock | undefined {
  if (
    output.kind !== "absent" ||
    framing.presentation.kind !== "inspection" ||
    !framing.presentation.showEmptyRecordNote
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

/** Build the qualifier, body, and explanation for one final-output section. */
export function finalOutputSection(
  output: FinalOutputInterpretation,
  framing: FinalOutputFraming,
): FinalOutputSection {
  switch (output.kind) {
    case "retained":
    case "retained-prefix":
      return {
        ...(output.kind === "retained-prefix"
          ? { qualifier: qualifier(output.removedBytes) }
          : {}),
        body: retainedBody(output, framing),
      };
    case "removed": {
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
