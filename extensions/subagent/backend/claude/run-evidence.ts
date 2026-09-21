/**
 * In-process meaning accumulated from translated Claude readings for one Run.
 *
 * Translation has already consumed Claude wire shapes before a reading arrives
 * here. This fold performs no I/O, owns no resource lifetime, and never settles
 * a Run: it synchronously returns ordered Observations and the next step for
 * execution and core Arbitration to act on later.
 */
import {
  answeredEnding,
  failedEnding,
  type RunObservation,
  type TerminalReconciliation,
} from "../../domain/index.ts";
import type { TerminalBundle } from "../contract.ts";
import {
  type ClaudeFrameReading,
  type ClaudeTranslator,
  confined,
  confinedControl,
} from "./translate.ts";

export const MISSING_CLAUDE_RESULT_MESSAGE =
  "the Claude query ended without a terminal result";
export const RESULT_ERROR_CATEGORY = "Claude query reported an error";
export const QUERY_FAILED_CATEGORY = "Claude query failed";
export const CONTROL_NOT_DELIVERED_CATEGORY =
  "Claude guidance was not delivered";
export const CLAUDE_ATTACHMENT_FAILED_MESSAGE =
  "the retained Claude conversation could not be attached to this Run";

/** Facts execution can witness without interpreting provider wire shapes. */
export type ClaudeRunReading =
  | { readonly kind: "frame"; readonly frame: ClaudeFrameReading }
  | {
      readonly kind: "control-visible";
      readonly uuid: string;
      readonly text: string;
    }
  | { readonly kind: "control-refused" }
  | { readonly kind: "turn-boundary-timeout" }
  | { readonly kind: "query-ended" }
  | { readonly kind: "query-threw" }
  | {
      /** A decision still owned by execution in this slice, such as identity. */
      readonly kind: "external-fatal";
      readonly bundle: TerminalBundle;
      readonly observations?: readonly RunObservation[];
    };

export type ClaudeRunStep =
  | { readonly step: "continue" }
  | { readonly step: "await-turn-boundary" }
  | { readonly step: "decided"; readonly bundle: TerminalBundle }
  | { readonly step: "fatal"; readonly bundle: TerminalBundle };

export interface ClaudeRunReport {
  readonly observations: readonly RunObservation[];
  readonly next: ClaudeRunStep;
  /** True only on the one report that closes this Run's input. */
  readonly inputClosed: boolean;
}

export interface ClaudeRunEvidenceOptions {
  readonly promptUuid: string;
  readonly resumed: boolean;
  readonly translator: ClaudeTranslator;
}

/** The synchronous, total interface of one Run's Claude evidence fold. */
export interface ClaudeRunEvidence {
  readonly read: (reading: ClaudeRunReading) => ClaudeRunReport;
  /** Whether the steering consumer may take another Control from the mailbox. */
  readonly controlSlotFree: () => boolean;
  /** Whether a Control already taken from the mailbox may still be pushed. */
  readonly takenControlProducesAnything: () => boolean;
}

interface VisibleControl {
  readonly uuid: string;
  readonly text: string;
}

function reconciliation(translator: ClaudeTranslator): TerminalReconciliation {
  const model = translator.primaryModel();
  const finalOutput = translator.finalOutput();
  return {
    turns: translator.turns(),
    ...(model === undefined ? {} : { model }),
    ...(finalOutput === undefined ? {} : { finalOutput }),
  };
}

export function createClaudeRunEvidence(
  options: ClaudeRunEvidenceOptions,
): ClaudeRunEvidence {
  const owned = new Set([options.promptUuid]);
  let visible: VisibleControl | undefined;
  let sawSuccessfulResult = false;
  let terminal:
    | Extract<ClaudeRunStep, { step: "decided" | "fatal" }>
    | undefined;
  let inputOpen = true;

  const current = (): ClaudeRunStep => terminal ?? { step: "continue" };

  const report = (
    observations: readonly RunObservation[],
    next: ClaudeRunStep = current(),
    closeInput = false,
  ): ClaudeRunReport => {
    const inputClosed = closeInput && inputOpen;
    if (inputClosed) inputOpen = false;
    return { observations, next, inputClosed };
  };

  const finish = (
    next: Extract<ClaudeRunStep, { step: "decided" | "fatal" }>,
    observations: readonly RunObservation[] = [],
  ): ClaudeRunReport => {
    if (terminal === undefined) {
      terminal = next;
      visible = undefined;
      return report(observations, next, true);
    }
    return report([], terminal);
  };

  /** Snapshot answered evidence at the boundary that actually decides the Run. */
  const answeredBundle = (): TerminalBundle => ({
    ending: answeredEnding(),
    reconciliation: reconciliation(options.translator),
  });

  const confirm = (uuid: unknown): readonly RunObservation[] => {
    if (
      typeof uuid !== "string" ||
      visible === undefined ||
      visible.uuid !== uuid
    ) {
      return [];
    }
    const confirmed = visible;
    visible = undefined;
    owned.add(confirmed.uuid);
    return [
      {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: confirmed.text }],
      },
    ];
  };

  const readFrame = (reading: ClaudeFrameReading): ClaudeRunReport => {
    if (terminal !== undefined) return report([], terminal);

    const observations: RunObservation[] = [];
    if (reading.kind === "user") {
      observations.push(...confirm(reading.uuid));
      // A steering echo is confirmation and nothing else. Non-tool user
      // frames are input echoes, including ones this Run does not own.
      if (!reading.isToolResult) return report(observations);
    }
    if (reading.kind === "result") {
      observations.push(...confirm(reading.correlation));
    }
    observations.push(...options.translator.frame(reading).observations);

    if (reading.kind !== "result") return report(observations);
    if (reading.isError) {
      const diagnostic = confined(RESULT_ERROR_CATEGORY);
      return finish(
        { step: "fatal", bundle: { ending: failedEnding(diagnostic.message) } },
        [...observations, { kind: "diagnostic", diagnostic }],
      );
    }

    sawSuccessfulResult = true;
    const correlated =
      typeof reading.correlation === "string" && owned.has(reading.correlation);
    if (visible !== undefined && !correlated) {
      // An uncorrelated answer cannot prove this guidance belongs to a later
      // turn. Keep the answer and discard the unsupported claim.
      visible = undefined;
    }
    if (visible !== undefined) {
      return report(observations, { step: "await-turn-boundary" });
    }
    return finish({ step: "decided", bundle: answeredBundle() }, observations);
  };

  return {
    read: (reading) => {
      if (terminal !== undefined) return report([], terminal);
      switch (reading.kind) {
        case "frame":
          return readFrame(reading.frame);
        case "control-visible":
          visible = { uuid: reading.uuid, text: reading.text };
          return report([]);
        case "control-refused":
          return report([
            {
              kind: "diagnostic",
              diagnostic: confinedControl(CONTROL_NOT_DELIVERED_CATEGORY),
            },
          ]);
        case "turn-boundary-timeout": {
          visible = undefined;
          const diagnostic: RunObservation = {
            kind: "diagnostic",
            diagnostic: confinedControl(CONTROL_NOT_DELIVERED_CATEGORY),
          };
          const bundle = sawSuccessfulResult
            ? answeredBundle()
            : { ending: failedEnding(MISSING_CLAUDE_RESULT_MESSAGE) };
          return finish({ step: "decided", bundle }, [diagnostic]);
        }
        case "query-ended":
          if (sawSuccessfulResult) {
            return finish({ step: "decided", bundle: answeredBundle() });
          }
          return finish({
            step: "fatal",
            bundle: { ending: failedEnding(MISSING_CLAUDE_RESULT_MESSAGE) },
          });
        case "query-threw": {
          const diagnostic = confined(QUERY_FAILED_CATEGORY);
          return finish(
            {
              step: "fatal",
              bundle: {
                ending: failedEnding(
                  options.resumed
                    ? CLAUDE_ATTACHMENT_FAILED_MESSAGE
                    : diagnostic.message,
                ),
              },
            },
            [{ kind: "diagnostic", diagnostic }],
          );
        }
        case "external-fatal":
          return finish(
            { step: "fatal", bundle: reading.bundle },
            reading.observations,
          );
      }
    },
    controlSlotFree: () => visible === undefined,
    takenControlProducesAnything: () => terminal === undefined,
  };
}
