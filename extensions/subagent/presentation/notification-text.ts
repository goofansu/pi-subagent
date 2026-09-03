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
 * Each terminal status then says a different thing, and the differences are
 * deliberate:
 *
 * - **completed** carries the bounded preview, so a model can decide whether
 *   the answer is worth fetching without fetching it.
 * - **failed** carries the primary error and nothing else. Partial output is
 *   not in the notice; it stays behind `agent_result`.
 * - **cancelled** is terse and carries no output at all. A cancelled Run's
 *   partial output is still retrievable, but a notice is not the place for it.
 *
 * All three point at `agent_result` by Run id, and all three carry the
 * accounting line when the Run reported anything to account for.
 */

import type { RunId, RunNotification, UsageSnapshot } from "../domain/index.ts";
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

/** How every notice tells a model where the rest of the answer is. */
export function formatResultPointer(runId: RunId): string {
  return `Use agent_result with id ${runId} to retrieve the full result.`;
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

function withAccounting(body: string, notice: RunNotification): string {
  const accounting = formatNotificationAccounting(notice.usage, notice.model);
  return accounting === undefined ? body : `${body}\n\n${accounting}`;
}

/** What the model reads when one of its Runs finishes. */
export function formatNotificationText(notice: RunNotification): string {
  const opening = `${formatNotificationHeader(notice)}\n\n${formatNotificationIdentity(notice)}`;
  const pointer = formatResultPointer(notice.runId);

  switch (notice.status) {
    case "completed": {
      const preview = notice.preview || "No output was produced.";
      return withAccounting(`${opening}\n\n${preview}\n\n${pointer}`, notice);
    }
    case "failed": {
      const reason = notice.errorMessage || "none reported.";
      return withAccounting(
        `${opening}\n\nReason: ${reason}\n\n${pointer}`,
        notice,
      );
    }
    case "cancelled":
      // The reason is in the header, so a cancelled notice has no body of its
      // own — and no partial output either: it stays behind `agent_result`.
      return withAccounting(opening, notice);
  }
}
