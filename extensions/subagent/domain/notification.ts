/**
 * The completion Notification: a notice, not the answer.
 *
 * When a Run settles, the model that started it is told — but what it is told
 * is deliberately small. A Notification identifies the owning Subagent and the
 * specific Run, says how it ended, gives a bounded preview so the model can
 * decide whether to look, and points at `agent_result` for the rest. It is not
 * the Result, and a caller that treats it as one is reading a preview.
 *
 * The preview is bounded here rather than at the point of delivery, because a
 * bound that lives at one of several call sites is a bound that one of them
 * will forget.
 *
 * Every terminal notice points at `agent_result`, whatever happened, and says
 * how much is there — because the alternative is a model that has to remember
 * which statuses keep output. A cancelled Run's Result may hold half an
 * answer, and a model that was never told so would either fetch every Result
 * on the chance or fetch none of them.
 *
 * A notice is **self-sufficient**: everything the host needs to write the
 * notice a model reads is on this value. That is why the accounting figures
 * and the primary error are here rather than looked up again at the host. A
 * push that has to re-read the store to say what it is about is a push that
 * can say something different from what was stored, which is the one thing
 * "storage precedes notification" exists to prevent.
 */

import { Schema } from "effect";
import { BackendId, RunId, SubagentId } from "./ids.ts";
import { CancellationReason, TerminalRunPhase } from "./phases.ts";
import { RUN_LABEL_MAX_BYTES, type RunResult } from "./result.ts";
import { boundOneLine } from "./text.ts";
import { UsageSnapshot } from "./usage.ts";

/** Long enough to recognize the answer, short enough not to be it. */
export const NOTIFICATION_PREVIEW_MAX_BYTES = 500;

/**
 * The bound on the primary error a failed notice carries.
 *
 * Bounded like the preview, and for the same reason: the primary error is
 * normally short, nothing upstream guarantees it, and the whole message stays
 * behind `agent_result` either way.
 */
export const NOTIFICATION_ERROR_MAX_BYTES = 500;

/**
 * How much of a Result there is, which is what a model needs to decide
 * whether fetching it is worth a tool call.
 *
 * It describes the **stored Result**, not the Run's success: a completed Run
 * whose output was cut by Result bounding is still `full`, because the Result
 * is the whole of what was stored and its own truncation record says what
 * bounding removed.
 */
export const ResultAvailability = Schema.Literals([
  "full",
  "partial",
  "metadata-only",
]);

export type ResultAvailability = typeof ResultAvailability.Type;

/**
 * Read availability off a stored Result.
 *
 * A failed or cancelled Run counts as `partial` on either kind of evidence —
 * a final output or a transcript — because either is something a model can
 * read, and a Run that was interrupted mid-answer often has the second
 * without the first.
 */
export function resultAvailabilityOf(result: RunResult): ResultAvailability {
  if (result.status === "completed") return "full";
  return result.finalOutput !== "" || result.transcript.length > 0
    ? "partial"
    : "metadata-only";
}

export const RunNotification = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  backendId: BackendId,
  agent: Schema.String,
  /**
   * The Run's label: the bounded one-line description the caller gave.
   *
   * Bounded at admission, so this is already the stored Result's
   * `description`. The bound is applied again here rather than trusted,
   * because the invariant a notice depends on should not depend on a call
   * site having remembered it.
   */
  label: Schema.String,
  status: TerminalRunPhase,
  /** How much of the Result is there. See {@link resultAvailabilityOf}. */
  resultAvailability: ResultAvailability,
  /** One line of the final output, or empty when there was none. */
  preview: Schema.String,
  /** The bounded primary error, present only for a failed Run that had one. */
  errorMessage: Schema.optionalKey(Schema.String),
  /** Present exactly when the status is `cancelled`. */
  cancellationReason: Schema.optionalKey(CancellationReason),
  /**
   * How long the Run took, settled instant less started instant.
   *
   * The same reading the widget's settled row and the result card use, so the
   * notice, the row, and the card print one number.
   */
  durationMillis: Schema.Number,
  /** What the Run spent, for the notice's accounting line. */
  usage: UsageSnapshot,
  /** The model the Run reported, when it reported one. */
  model: Schema.optionalKey(Schema.String),
  /**
   * How to get the rest.
   *
   * A literal string rather than a computed one, so what a model is told to
   * call cannot drift from what the host registers.
   */
  retrieveWith: Schema.Literal("agent_result"),
});

export type RunNotification = typeof RunNotification.Type;

/** Build the notice for one stored result. Nothing is invented. */
export function toRunNotification(result: RunResult): RunNotification {
  return {
    runId: result.runId,
    subagentId: result.subagentId,
    backendId: result.backendId,
    agent: result.agent,
    label: boundOneLine(result.description, RUN_LABEL_MAX_BYTES),
    status: result.status,
    resultAvailability: resultAvailabilityOf(result),
    preview: boundOneLine(result.finalOutput, NOTIFICATION_PREVIEW_MAX_BYTES),
    ...(result.errorMessage === undefined
      ? {}
      : {
          errorMessage: boundOneLine(
            result.errorMessage,
            NOTIFICATION_ERROR_MAX_BYTES,
          ),
        }),
    ...(result.cancellationReason === undefined
      ? {}
      : { cancellationReason: result.cancellationReason }),
    durationMillis: Math.max(0, result.settledAt - result.startedAt),
    usage: result.usage,
    ...(result.model === undefined ? {} : { model: result.model }),
    retrieveWith: "agent_result",
  };
}
