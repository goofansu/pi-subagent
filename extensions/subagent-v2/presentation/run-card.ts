/**
 * `RunCard`: one Run, presented, from a snapshot or from a stored Result.
 *
 * The card is where Run presentation grows. Today it carries identity, status,
 * duration, accounting, and the final output; M4 adds the recent transcript,
 * the tool list, diagnostics, and native links. Having one place for that
 * means the tool-result renderer, the notification renderer, and whatever the
 * Pi adapter milestone adds all read the same card rather than each assembling
 * their own lines from the same fields in slightly different orders.
 *
 * There are exactly two sources, and the distinction is the point. A **live**
 * card comes from the published Run index and knows nothing about output,
 * because the index deliberately does not carry it. A **terminal** card comes
 * from the immutable stored Result and knows everything. Nothing else is a
 * source: a card built from a projection, a backend event, or a half-folded
 * observation would be presentation folding state, which is the thing the
 * layer is forbidden to do.
 */

import type { RunResult } from "../domain/index.ts";
import { formatNotificationAccounting } from "./notification-text.ts";
import { formatResultBody } from "./result-body.ts";
import { formatRunPhase, runPhaseTone, type Tone } from "./status.ts";
import { elapsedMillis, type RunRowView } from "./views.ts";

export type RunCardSource =
  /** A Run that is still going, read from the published index. */
  | { readonly from: "live"; readonly row: RunRowView; readonly now: number }
  /** A Run that settled, read from its one immutable Result. */
  | { readonly from: "result"; readonly result: RunResult };

export interface RunCard {
  readonly runId: string;
  readonly subagentId: string;
  readonly agent: string;
  readonly description: string;
  readonly backendId: string;
  /** The status phrase, with the duration where the phase has one. */
  readonly status: string;
  readonly tone: Tone;
  /** Present when the Run reported anything to account for. */
  readonly accounting?: string;
  /**
   * The Run's answer, present only for a terminal card.
   *
   * A live card has none, and that is not a gap: the published index does not
   * carry output, so a live card that claimed to have it would be reading
   * something it is not allowed to read.
   */
  readonly output?: string;
}

/** Build the card for one Run. */
export function runCard(source: RunCardSource): RunCard {
  if (source.from === "live") {
    const { row, now } = source;
    const accounting = formatNotificationAccounting(row.usage, undefined);
    return {
      runId: row.identity.runId,
      subagentId: row.identity.subagentId,
      agent: row.identity.agent,
      description: row.identity.description,
      backendId: row.identity.backendId,
      status: formatRunPhase({
        phase: row.phase,
        elapsedMillis: elapsedMillis(row, now),
      }),
      tone: runPhaseTone(row.phase),
      ...(accounting === undefined ? {} : { accounting }),
    };
  }

  const { result } = source;
  const accounting = formatNotificationAccounting(result.usage, result.model);
  return {
    runId: result.runId,
    subagentId: result.subagentId,
    agent: result.agent,
    description: result.description,
    backendId: result.backendId,
    status: formatRunPhase({
      phase: result.status,
      elapsedMillis: Math.max(0, result.settledAt - result.startedAt),
    }),
    tone: runPhaseTone(result.status),
    ...(accounting === undefined ? {} : { accounting }),
    output: formatResultBody(result),
  };
}

/**
 * How a card names the Run it is about.
 *
 * One line, and the same line wherever a Run is identified: the agent a caller
 * asked for, the Subagent that owns the work, and the Run this particular
 * answer belongs to. A reader who has three ids in front of them and no idea
 * which is which has been given three strings.
 */
export function runCardIdentity(card: RunCard): string {
  return `${card.agent} (subagent ${card.subagentId}), run ${card.runId}`;
}

/**
 * The card as plain lines, for an expanded view.
 *
 * One blank line separates the header block from the body, because the body is
 * agent-authored Markdown and two adjacent paragraphs of different voices read
 * as one.
 */
export function runCardLines(card: RunCard): readonly string[] {
  const header = [
    runCardIdentity(card),
    `${card.description} · ${card.backendId} · ${card.status}`,
    ...(card.accounting === undefined ? [] : [card.accounting]),
  ];
  if (card.output === undefined) return header;
  return [...header, "", card.output];
}

/**
 * The complete `agent_result` text: the Run's identity, then its answer.
 *
 * Built from the card rather than from the Result directly, which is what
 * makes the card the one place Run presentation grows. M3's text is v1's — the
 * identity line and the body, and nothing else — and the fields M4 adds
 * (recent transcript, tools, diagnostics, native links) arrive by widening
 * this function's view of the card rather than by a second assembly of the
 * same fields somewhere else.
 */
export function formatResult(result: RunResult): string {
  const card = runCard({ from: "result", result });
  return `${runCardIdentity(card)}:\n\n${card.output ?? ""}`;
}
