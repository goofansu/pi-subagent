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
 */

import { Schema } from "effect";
import { BackendId, RunId, SubagentId } from "./ids.ts";
import { TerminalRunPhase } from "./phases.ts";
import type { RunResult } from "./result.ts";
import { boundOneLine } from "./text.ts";

/** Long enough to recognize the answer, short enough not to be it. */
export const NOTIFICATION_PREVIEW_MAX_BYTES = 500;

export const RunNotification = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  backendId: BackendId,
  agent: Schema.String,
  description: Schema.String,
  status: TerminalRunPhase,
  /** One line of the final output, or empty when there was none. */
  preview: Schema.String,
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
    retrieveWith: "agent_result",
  };
}
