/**
 * The text of a completion Notification.
 *
 * Built from the domain `RunNotification` and nothing else, which is what
 * makes the prose backend-independent: the notice is derived from the stored
 * Result, so two backends running the same work produce the same sentence and
 * only the model string differs. The compatibility matrix's Notification row
 * is that statement, and the golden tests below it are the proof.
 *
 * Every notice opens the same way, whatever happened: a sentence naming the
 * work and how long it took, then an identity block. A parent model running
 * several Subagents reads the label to know *which* delegation finished, and
 * reads an id only when it is about to make a tool call with one — so the
 * label comes first and the ids come after it, rather than the reader having
 * to map two identifiers back to an intention.
 *
 * The text is four sections in a fixed order — **header, status body,
 * pointer, accounting** — separated by blank lines, and only the body varies
 * by status. Three structural branches became one, which is what makes the
 * pointer *universal*: it is a section rather than something each branch
 * remembers to append, so no status can be the one that forgets it.
 *
 * The body is the only place the statuses differ:
 *
 * - **completed** carries the bounded preview, labelled and quoted as the
 *   subagent's, so a model can decide whether the answer is worth fetching
 *   without fetching it.
 * - **failed** carries the primary error. Partial output is not in the
 *   notice; the pointer says it exists and `agent_result` has it.
 * - **cancelled** has no body: its reason is in the header, and a cancelled
 *   Run's partial output stays behind `agent_result` too.
 *
 * Quoting the preview is **not a security boundary** and does not claim to
 * be. It keeps delegated output out of the voice of the orchestration
 * instructions, so a subagent that read hostile repository text does not get
 * to address the parent as if it were the runtime.
 */

import type {
  ResultAvailability,
  RunId,
  RunNotification,
  UsageSnapshot,
} from "../domain/index.ts";
import {
  formatDuration,
  formatTokenCount,
  formatTurns,
  runPhaseNoticeVerb,
} from "./status.ts";

/**
 * The opening sentence: what finished, how it ended, and how long it took.
 *
 * The label is quoted so that a description containing a verb cannot be read
 * as part of the runtime's own sentence. A cancelled Run's reason follows in
 * parentheses, because a timeout and a shutdown cancel Runs nobody asked to
 * cancel and a parent told plain `was cancelled` would conclude its own
 * request had taken effect.
 */
function formatNotificationHeader(notice: RunNotification): string {
  const reason =
    notice.status === "cancelled" && notice.cancellationReason !== undefined
      ? ` (${notice.cancellationReason})`
      : "";
  return `Subagent "${notice.label}" ${runPhaseNoticeVerb(notice.status)} in ${formatDuration(notice.durationMillis)}${reason}.`;
}

/**
 * The three identifiers, one per line, in ownership order.
 *
 * Always present and always in the same place, so a model that needs the Run
 * id for `agent_result` finds it where it found it last time.
 */
function formatNotificationIdentity(notice: RunNotification): string {
  return [
    `Agent: ${notice.agent}`,
    `Run: ${notice.runId}`,
    `Subagent: ${notice.subagentId}`,
  ].join("\n");
}

/**
 * How every notice tells a model where the rest of the answer is.
 *
 * Two sentences: how much is there, then the exact call that fetches it. The
 * argument shape is spelled out so the parent copies rather than composes —
 * a model that has to assemble `{"id": …}` from prose is a model that can
 * assemble it wrongly.
 *
 * Present for every terminal status, `cancelled` included. That is the one
 * behaviourally observable change of this phase: a cancelled Run keeps the
 * output it produced before it was stopped, and a timeout or a shutdown
 * cancels Runs the parent never asked to cancel, so "you already know the id
 * you cancelled" was never true of every cancellation.
 */
export function formatResultPointer(
  runId: RunId,
  availability: ResultAvailability,
): string {
  const call = `Call agent_result with {"id":"${runId}"}`;
  switch (availability) {
    case "full":
      return `Full result is available. ${call}.`;
    case "partial":
      return `Partial result is available. ${call}.`;
    case "metadata-only":
      return `No output was produced. ${call} for the Run's record.`;
  }
}

/**
 * The trailing accounting line, when the Run reported usage.
 *
 * Cost, tokens, turns, then the model. A model identifies reported accounting
 * and is not accounting by itself, so it appears only alongside something
 * else — a line reading just the model name would say nothing about what the
 * Run spent.
 *
 * Cache figures and the context gauge are deliberately absent: they are not
 * fields of this line, and a Run whose only reported usage was a cache read
 * must not produce an accounting line at all.
 */
export function formatNotificationAccounting(
  usage: UsageSnapshot,
  model: string | undefined,
): string | undefined {
  const parts: string[] = [];
  const roundedCost = Math.round(usage.totals.cost * 10_000) / 10_000;
  if (roundedCost !== 0) parts.push(`cost $${roundedCost.toFixed(4)}`);
  if (usage.totals.input !== 0 || usage.totals.output !== 0) {
    const tokens: string[] = [];
    if (usage.totals.input !== 0) {
      tokens.push(`${formatTokenCount(usage.totals.input)} in`);
    }
    if (usage.totals.output !== 0) {
      tokens.push(`${formatTokenCount(usage.totals.output)} out`);
    }
    parts.push(tokens.join(" / "));
  }
  // `formatTurns` is the one place turn grammar is decided, and it renders a
  // zero as a dash — which is right for a widget column and wrong here, so the
  // guard is what keeps both readings honest rather than a second format.
  if (usage.turns !== 0) parts.push(formatTurns(usage.turns));
  if (parts.length > 0 && model !== undefined && model !== "") {
    parts.push(model);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The one section that varies, and the only place a status is asked about.
 *
 * `undefined` rather than an empty string, so an absent body leaves no blank
 * line behind it: a cancelled notice reads as three sections and not as four
 * with a hole in the middle.
 */
function formatNotificationBody(notice: RunNotification): string | undefined {
  switch (notice.status) {
    case "completed":
      return notice.preview === ""
        ? "No output was produced."
        : `Preview from the subagent:\n"${notice.preview}"`;
    case "failed":
      return `Reason: ${notice.errorMessage || "none reported."}`;
    case "cancelled":
      // The reason is in the header, and a cancelled Run's partial output
      // stays behind `agent_result`, which the pointer now says.
      return undefined;
  }
}

/** What the model reads when one of its Runs finishes. */
export function formatNotificationText(notice: RunNotification): string {
  return [
    `${formatNotificationHeader(notice)}\n\n${formatNotificationIdentity(notice)}`,
    formatNotificationBody(notice),
    formatResultPointer(notice.runId, notice.resultAvailability),
    formatNotificationAccounting(notice.usage, notice.model),
  ]
    .filter((section) => section !== undefined)
    .join("\n\n");
}
