/**
 * The text of a completion Notification.
 *
 * Built from the domain `RunNotification` and nothing else, which is what
 * makes the prose backend-independent: the notice is derived from the stored
 * Result, so two backends running the same work produce the same sentence and
 * only the model string differs. The compatibility matrix's Notification row
 * is that statement, and the golden tests below it are the proof.
 *
 * Each terminal status says a different thing, and the differences are
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
import { formatTokenCount, formatTurns } from "./status.ts";

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
  const name = `${notice.agent} (${notice.subagentId}), run ${notice.runId}`;
  const pointer = formatResultPointer(notice.runId);

  switch (notice.status) {
    case "completed": {
      const preview = notice.preview || "No output was produced.";
      return withAccounting(
        `Subagent ${name} completed.\n\n${preview}\n\n${pointer}`,
        notice,
      );
    }
    case "failed": {
      const reason = notice.errorMessage || "no reason reported";
      return withAccounting(
        `Subagent ${name} failed: ${reason}\n\n${pointer}`,
        notice,
      );
    }
    case "cancelled": {
      const reason =
        notice.cancellationReason === undefined
          ? ""
          : ` (${notice.cancellationReason})`;
      return withAccounting(`Subagent ${name} was cancelled${reason}.`, notice);
    }
  }
}
