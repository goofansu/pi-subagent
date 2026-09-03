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
import type { RunResult } from "./result.ts";
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

export const RunNotification = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  backendId: BackendId,
  agent: Schema.String,
  description: Schema.String,
  status: TerminalRunPhase,
  /** One line of the final output, or empty when there was none. */
  preview: Schema.String,
  /** The bounded primary error, present only for a failed Run that had one. */
  errorMessage: Schema.optionalKey(Schema.String),
  /** Present exactly when the status is `cancelled`. */
  cancellationReason: Schema.optionalKey(CancellationReason),
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
    description: result.description,
    status: result.status,
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
    usage: result.usage,
    ...(result.model === undefined ? {} : { model: result.model }),
    retrieveWith: "agent_result",
  };
}
