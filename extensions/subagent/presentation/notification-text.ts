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
 *   without fetching it. A completed Run with nothing to preview has no body
 *   at all; the pointer is where "no output was produced" is said.
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
  NotificationAccounting,
  ResultAvailability,
  RunId,
  RunNotification,
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
 * Two sentences: what it will find, then the exact call that fetches it. The
 * argument shape is spelled out so the parent copies rather than composes —
 * a model that has to assemble `{"id": …}` from prose is a model that can
 * assemble it wrongly — and the call keeps its own sentence in all three, so
 * the habit reads the same whatever the availability.
 *
 * The record-only sentence **owns** "no output was produced". It is the one
 * place that says it, which is why a completed Run with an empty preview has
 * no body: saying it in the body and then promising a full result in the
 * pointer is what this wording replaced.
 *
 * Present for every terminal status, `cancelled` included: a cancelled Run
 * keeps the output it produced before it was stopped, and a timeout or a
 * shutdown cancels Runs the parent never asked to cancel, so "you already know
 * the id you cancelled" was never true of every cancellation.
 */
export function formatResultPointer(
  runId: RunId,
  availability: ResultAvailability,
): string {
  const call = `Call agent_result with {"id":"${runId}"}`;
  switch (availability) {
    case "complete":
      return `The result is available. ${call}.`;
    case "partial":
      return `Partial output is available. ${call}.`;
    case "record-only":
      return `No output was produced. The Run record is available. ${call}.`;
  }
}

/**
 * The trailing accounting line, from the notice's accounting value.
 *
 * Cost, tokens, turns, then the model. Whether there was anything to account
 * for is decided where the notice is derived — the notice simply has no
 * accounting when there was not — so this function has one job, which is how
 * the four figures read.
 *
 * Cache figures and the context gauge are absent because they are not fields
 * of this line and are not on the value it is given. A model identifies
 * accounting and is not accounting by itself; it cannot appear alone here,
 * because a notice with an accounting value has at least one non-zero figure.
 */
export function formatNotificationAccounting(
  accounting: NotificationAccounting,
): string {
  const parts: string[] = [];
  if (accounting.cost !== 0) parts.push(`cost $${accounting.cost.toFixed(4)}`);
  if (accounting.inputTokens !== 0 || accounting.outputTokens !== 0) {
    const tokens: string[] = [];
    if (accounting.inputTokens !== 0) {
      tokens.push(`${formatTokenCount(accounting.inputTokens)} in`);
    }
    if (accounting.outputTokens !== 0) {
      tokens.push(`${formatTokenCount(accounting.outputTokens)} out`);
    }
    parts.push(tokens.join(" / "));
  }
  // `formatTurns` is the one place turn grammar is decided, and it renders a
  // zero as a dash — which is right for a widget column and wrong here, so the
  // guard is what keeps both readings honest rather than a second format.
  if (accounting.turns !== 0) parts.push(formatTurns(accounting.turns));
  if (accounting.model !== undefined) parts.push(accounting.model);
  return parts.join(" · ");
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
      // No body when there is nothing to preview. The pointer says a Run
      // record is available and says "no output was produced" once, which is
      // the whole reason this branch has an absence rather than a sentence.
      return notice.preview === ""
        ? undefined
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
    notice.accounting === undefined
      ? undefined
      : formatNotificationAccounting(notice.accounting),
  ]
    .filter((section) => section !== undefined)
    .join("\n\n");
}
