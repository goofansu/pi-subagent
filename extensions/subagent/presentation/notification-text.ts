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
 * The body is the only place the statuses differ, and within each status the
 * one question is whether the notice carries the retained output value whole
 * ([ADR-0037](../../../docs/adr/0037-a-notice-carries-a-short-output-whole.md)):
 *
 * - **completed** carries that retained value when the notice has it, set off
 *   in a labelled block. The pointer says whether it is the complete produced
 *   output or a bounded prefix. Otherwise the notice carries the bounded
 *   preview, labelled and quoted, so a model can decide whether the answer is
 *   worth fetching without fetching it. A completed Run with nothing retained
 *   has no body; the pointer distinguishes absent from wholly removed output.
 * - **failed** carries the primary error, then the partial output whole when
 *   the notice has it. Otherwise the pointer says the partial output exists
 *   and `agent_result` has it.
 * - **cancelled** carries the partial output whole when the notice has it, and
 *   otherwise has no body: its reason is in the header.
 *
 * Quoting the preview and fencing the whole output are **not a security
 * boundary** and do not claim to be. They keep delegated output out of the
 * voice of the orchestration instructions, so a subagent that read hostile
 * repository text does not get to address the parent as if it were the
 * runtime.
 */

import type {
  NotificationAccounting,
  RunNotification,
} from "../domain/index.ts";
import { completionViewOfNotification } from "./completion-view.ts";
import {
  finalOutputSectionLines,
  notificationFinalOutputSection,
} from "./final-output-section.ts";
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
  // The label, the status and the duration through the completion view, which
  // is the same value the widget's settled row and the result card read.
  const completion = completionViewOfNotification(notice);
  return `Subagent "${completion.label}" ${runPhaseNoticeVerb(completion.status)} in ${formatDuration(completion.durationMillis)}${reason}.`;
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

/** What the model reads when one of its Runs finishes. */
export function formatNotificationText(notice: RunNotification): string {
  const output = notificationFinalOutputSection(notice);
  return [
    `${formatNotificationHeader(notice)}\n\n${formatNotificationIdentity(notice)}`,
    ...finalOutputSectionLines(output),
    notice.accounting === undefined
      ? undefined
      : formatNotificationAccounting(notice.accounting),
  ]
    .filter((section) => section !== undefined)
    .join("\n\n");
}
