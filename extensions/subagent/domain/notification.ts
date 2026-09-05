/**
 * The completion Notification: the answer when it is short, a notice when it
 * is not.
 *
 * When a Run settles, the model that started it is told. A Notification
 * identifies the owning Subagent and the specific Run, says how it ended, and
 * then does one of two things with the output
 * ([ADR-0037](../../../docs/adr/0037-a-notice-carries-a-short-output-whole.md)):
 * an output that fits {@link NOTIFICATION_INLINE_MAX_BYTES} travels **whole**,
 * so the common case is one message and no fetch; a longer one is
 * **previewed**, bounded, with a pointer at `agent_result` for the rest. The
 * two are told apart by the shape — `output` is present exactly when the
 * whole output is here — so a formatter cannot mistake a preview for the
 * answer.
 *
 * Both bounds are applied here rather than at the point of delivery, because
 * a bound that lives at one of several call sites is a bound that one of them
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
 *
 * Self-sufficient is not the same as complete. The notice carries **only what
 * its formatter reads**, which is why it holds a small accounting summary
 * rather than the Result's whole `UsageSnapshot`, and why it holds no backend
 * identity at all. The absence is what makes "two backends, one sentence"
 * structural rather than merely true today: a notice with nowhere to put a
 * backend id cannot start mentioning one.
 */

import { Schema } from "effect";
import { RunId, SubagentId } from "./ids.ts";
import { CancellationReason, TerminalRunPhase } from "./phases.ts";
import { RUN_LABEL_MAX_BYTES, type RunResult } from "./result.ts";
import { boundOneLine, byteLength } from "./text.ts";
import type { UsageSnapshot } from "./usage.ts";

/** Long enough to recognize the answer, short enough not to be it. */
export const NOTIFICATION_PREVIEW_MAX_BYTES = 500;

/**
 * The largest final output a notice carries whole.
 *
 * Sixteen kibibytes — the same bound the projection puts on one text part
 * and the mailbox puts on one steering message, so "fits one message" means
 * one thing across the extension. It is a few thousand tokens: room for the
 * summary, finding, or plan a delegated task usually returns, and small
 * enough that a fan-out of ten completions costs the parent long messages
 * rather than a context window. Past it the notice previews and points, which
 * is ADR-0006's original shape and the reason the fetch tool still exists. A
 * chosen default, not a measured one.
 */
export const NOTIFICATION_INLINE_MAX_BYTES = 16 * 1024;

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
 * whose output was cut by Result bounding is still `complete`, because the
 * Result is the whole of what was stored and its own truncation record says
 * what bounding removed.
 *
 * The three values say what a model will *find*. Phase A's three were keyed to
 * the status alone, so every completed Run promised a whole result whatever
 * its output — coherent, and misleading to a reader for whom that promise
 * means an answer is waiting. A completed Run with nothing to show has no
 * answer, so it is `record-only` and says so once.
 * [ADR-0035](../../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)
 * records the amendment.
 */
export const ResultAvailability = Schema.Literals([
  "complete",
  "partial",
  "record-only",
]);

export type ResultAvailability = typeof ResultAvailability.Type;

/**
 * Read availability off a stored Result.
 *
 * The **output** decides it rather than the status alone. A completed Run that
 * produced no final answer but left a transcript is `partial`, which is fair:
 * readable work, no answer. A failed or cancelled Run counts as `partial` on
 * either kind of evidence — a final output or a transcript — because either is
 * something a model can read, and a Run that was interrupted mid-answer often
 * has the second without the first.
 */
export function resultAvailabilityOf(result: RunResult): ResultAvailability {
  if (result.status === "completed" && result.finalOutput !== "") {
    return "complete";
  }
  return result.finalOutput !== "" || result.transcript.length > 0
    ? "partial"
    : "record-only";
}

/**
 * The bound on the model name an accounting line may carry.
 *
 * A model string is provider-authored and normally short; nothing upstream
 * guarantees it. A hundred bytes is more than any real identifier and less
 * than a paragraph.
 */
export const NOTIFICATION_MODEL_MAX_BYTES = 100;

/**
 * What a Run spent, in the four figures the accounting line prints.
 *
 * A presentation-shaped value rather than a copy of the Result's usage: the
 * line reads tokens, cost, turns, and the model, and knows nothing about cache
 * figures or the context gauge. Carrying the whole `UsageSnapshot` made the
 * formatter depend on a schema it read four fields of, so a change to the
 * gauge was a change that reached the notice.
 *
 * The cost is already rounded to the four places the line prints, because the
 * rounding decides something the domain owns: whether there was anything to
 * account for at all.
 */
export const NotificationAccounting = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cost: Schema.Number,
  turns: Schema.Number,
  /** The model the Run reported, when it reported one. */
  model: Schema.optionalKey(Schema.String),
});

export type NotificationAccounting = typeof NotificationAccounting.Type;

/**
 * The accounting for one Run's usage, or nothing to account for.
 *
 * `undefined` when every figure the line would print is zero — which is what
 * keeps the rule that a Run whose only reported usage was a cache read
 * produces no accounting line, and what makes a line reading nothing but a
 * model name impossible rather than merely unwanted. A model identifies
 * accounting and is not accounting.
 *
 * Takes a usage snapshot rather than a Result, because the result card shows
 * the same four figures for a Run that has not settled and has no Result yet.
 * One place decides whether there is anything to account for; two surfaces
 * read the answer.
 */
export function toNotificationAccounting(
  usage: UsageSnapshot,
  model?: string,
): NotificationAccounting | undefined {
  const { totals, turns } = usage;
  const cost = Math.round(totals.cost * 10_000) / 10_000;
  if (cost === 0 && totals.input === 0 && totals.output === 0 && turns === 0) {
    return undefined;
  }
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cost,
    turns,
    ...(model === undefined || model === ""
      ? {}
      : { model: boundOneLine(model, NOTIFICATION_MODEL_MAX_BYTES) }),
  };
}

export const RunNotification = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
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
  /**
   * The whole final output, present exactly when it is non-empty and fits
   * {@link NOTIFICATION_INLINE_MAX_BYTES}.
   *
   * Presence is the discriminant: a notice with `output` *is* the answer and
   * its pointer says so; a notice without one is a preview and points at the
   * Result. Carried untouched — line breaks and all — because it is the
   * agent's Markdown and the parent reads it as such.
   */
  output: Schema.optionalKey(Schema.String),
  /**
   * One line of the final output, or empty when there was none.
   *
   * Always built, read only when `output` is absent: the collapsed line and
   * the preview body need it then, and building it unconditionally keeps the
   * notice's shape independent of which branch the formatter takes.
   */
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
  /**
   * What the Run spent, when it reported anything to account for.
   *
   * Absent rather than zeroed, so the notice says "nothing to account for"
   * with its shape instead of leaving the formatter to infer it.
   */
  accounting: Schema.optionalKey(NotificationAccounting),
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
  const accounting = toNotificationAccounting(result.usage, result.model);
  return {
    runId: result.runId,
    subagentId: result.subagentId,
    agent: result.agent,
    label: boundOneLine(result.description, RUN_LABEL_MAX_BYTES),
    status: result.status,
    resultAvailability: resultAvailabilityOf(result),
    ...(result.finalOutput !== "" &&
    byteLength(result.finalOutput) <= NOTIFICATION_INLINE_MAX_BYTES
      ? { output: result.finalOutput }
      : {}),
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
    ...(accounting === undefined ? {} : { accounting }),
    retrieveWith: "agent_result",
  };
}
