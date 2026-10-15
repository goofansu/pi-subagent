/**
 * What a delivered Run said and how it ended, as facts for external readers.
 *
 * The prose beside a delivered Result — the Notification's content and the
 * `agent_result` and wait texts — fences the answer for the model and wraps it
 * in status context. A reader outside the TUI that wants only the answer, or
 * only the status note, would have to parse that prose back apart. These facts
 * are the same answer and the same reasons, carried structured on both
 * channels' `details`, keyed by Run id exactly as the usage is
 * ([ADR-0040](../../../docs/adr/0040-delivered-results-carry-the-final-output-for-external-readers.md)).
 *
 * Nothing here decides retention or status: the retention kind and the
 * transcript-evidence flag come from the domain's one interpretation, and the
 * failure and cancellation reasons come from the same framing the final-output
 * section prints. This module only reshapes them, so a fact and the sentence
 * beside it cannot disagree.
 */

import { Schema } from "effect";
import {
  CancellationReason,
  type FinalOutputInterpretation,
  interpretFinalOutput,
  type NotificationFinalOutput,
  notificationFinalOutputOf,
  type RunNotification,
  type RunResult,
} from "../domain/index.ts";
import {
  type FinalOutputFraming,
  notificationFinalOutputFraming,
  resultFinalOutputFraming,
} from "./final-output-section.ts";

/**
 * Final output retention, with the retained value where there is one.
 *
 * The four kinds are the domain's four words. A retained kind carries either
 * `text` — the whole retained value, exactly what the prose fences — or
 * `preview`, the bounded one-line preview a Notification carries when the
 * value was too long to inline ([ADR-0037](../../../docs/adr/0037-a-notice-carries-a-short-output-whole.md)).
 * Presence is the discriminant, as it is on the notice itself: a reader that
 * finds `preview` knows the whole value is in the Result and nowhere else.
 * Transcript evidence is stated only where no output remains, where it is the
 * one thing left to say; for retained output it is not inferable and is not
 * invented.
 */
export const RunFinalOutputFacts = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("absent"),
    hasTranscriptEvidence: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed"),
    removedBytes: Schema.Number,
    hasTranscriptEvidence: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("retained"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("retained"), preview: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("retained-prefix"),
    removedBytes: Schema.Number,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("retained-prefix"),
    removedBytes: Schema.Number,
    preview: Schema.String,
  }),
]);

export type RunFinalOutputFacts = typeof RunFinalOutputFacts.Type;

/**
 * The fields a delivered-Run payload spreads in beside identity and usage.
 *
 * `finalOutput` is optional on read so a payload persisted before it existed
 * still decodes; every payload built here carries it. `failure` is present
 * for a failed Run that reported a reason, `cancellationReason` exactly when
 * the Run was cancelled — the same values the prose prints as `Reason:` and
 * in parentheses after `cancelled`.
 */
export const DeliveredRunFactsFields = {
  finalOutput: Schema.optionalKey(RunFinalOutputFacts),
  failure: Schema.optionalKey(Schema.String),
  cancellationReason: Schema.optionalKey(CancellationReason),
} as const;

const DeliveredRunFacts = Schema.Struct(DeliveredRunFactsFields);

export type DeliveredRunFacts = typeof DeliveredRunFacts.Type;

type CarriedAs = "text" | "preview";

function finalOutputFactsOf(
  output: FinalOutputInterpretation | NotificationFinalOutput,
  carriedAs: CarriedAs,
): RunFinalOutputFacts {
  switch (output.kind) {
    case "absent":
      return {
        kind: "absent",
        hasTranscriptEvidence: output.hasTranscriptEvidence,
      };
    case "removed":
      return {
        kind: "removed",
        removedBytes: output.removedBytes,
        hasTranscriptEvidence: output.hasTranscriptEvidence,
      };
    case "retained":
      return carriedAs === "text"
        ? { kind: "retained", text: output.output }
        : { kind: "retained", preview: output.output };
    case "retained-prefix":
      return carriedAs === "text"
        ? {
            kind: "retained-prefix",
            removedBytes: output.removedBytes,
            text: output.output,
          }
        : {
            kind: "retained-prefix",
            removedBytes: output.removedBytes,
            preview: output.output,
          };
  }
}

/** The reasons the framing prints, as facts; nothing for a completed Run. */
function endingFacts(
  framing: FinalOutputFraming,
): Pick<DeliveredRunFacts, "failure" | "cancellationReason"> {
  if (framing.capture === "active" || framing.status === "completed") return {};
  if (framing.status === "failed") {
    // An empty reason is no reason: the prose says "none reported." for it.
    return framing.failure === undefined || framing.failure === ""
      ? {}
      : { failure: framing.failure };
  }
  return framing.cancellationReason === undefined
    ? {}
    : { cancellationReason: framing.cancellationReason };
}

/**
 * The facts for a Result delivered by `agent_result` or a wait.
 *
 * The retained value is always whole here: the Result is the authoritative
 * store and its final output is already bounded by retention.
 */
export function deliveredRunFactsOfResult(
  result: RunResult,
): DeliveredRunFacts {
  return {
    finalOutput: finalOutputFactsOf(interpretFinalOutput(result), "text"),
    ...endingFacts(resultFinalOutputFraming(result)),
  };
}

/**
 * The facts for a Run announced by its Notification.
 *
 * The notice carries the value whole only when it fits the inline bound;
 * otherwise it carries the preview, and so do these facts. The reasons are
 * the notice's own bounded ones, which is what its prose prints.
 */
export function deliveredRunFactsOfNotification(
  notice: RunNotification,
): DeliveredRunFacts {
  return {
    finalOutput: finalOutputFactsOf(
      notificationFinalOutputOf(notice),
      notice.output === undefined ? "preview" : "text",
    ),
    ...endingFacts(notificationFinalOutputFraming(notice)),
  };
}
