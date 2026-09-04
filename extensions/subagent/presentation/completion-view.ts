/**
 * One terminal Run, as the three surfaces that describe it need it.
 *
 * A Run that has finished is readable from three places, each for a good
 * reason: the published `RunSnapshot` (the widget's row, which must not hold a
 * transcript), the immutable `RunResult` (the card, which has everything), and
 * the `RunNotification` (the notice, which is self-sufficient so a push never
 * re-reads the store). Presentation can therefore pick the wrong one, and it
 * has: a row and a result card once printed two different durations for one
 * Run, because one measured against the draw's clock and the other against the
 * instant the Run settled.
 *
 * So the six facts all three agree on are named once, and each source gets one
 * derivation into them. What the surfaces then do is unchanged — they still
 * format through `runPhaseTone`, `NOTICE_VERB` and `formatDuration`, which are
 * the one place tone, verb and duration are decided — but they read the same
 * two fields to format, so two of them cannot disagree about what a Run cost.
 *
 * **A view, not a service and not a schema.** Nothing constructs one to keep
 * it; it is derived where it is read and thrown away. No source gains a field
 * for it: every one of the six is something all three already carry, which is
 * why the equality test below can build one Run three ways and compare.
 */

import type {
  RunId,
  RunNotification,
  RunResult,
  SubagentId,
  TerminalRunPhase,
} from "../domain/index.ts";
import { elapsedMillis, type RunRowView } from "./views.ts";

/** What a terminal Run is, to anything that prints its status and duration. */
export interface RunCompletionView {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
  readonly agent: string;
  /** The Run's label: the bounded one-line description its caller gave. */
  readonly label: string;
  readonly status: TerminalRunPhase;
  /** Settled instant less started instant. Never a reading of the draw's clock. */
  readonly durationMillis: number;
}

/**
 * The view for a published row, or nothing when the Run has not settled.
 *
 * `undefined` rather than a guess, because a running Run has no completion to
 * describe: its row prints `running` and no duration at all, and a view that
 * invented a status for it would be inviting one to be printed.
 *
 * `now` is taken and is normally unused — a terminal row carries the instant
 * it settled at, and that is what {@link elapsedMillis} prefers. It is here
 * for the row the repository has published as terminal in the instant before
 * its settled instant is on it, so that this function has no case in which it
 * cannot answer.
 */
export function completionViewOfSnapshot(
  row: RunRowView,
  now: number,
): RunCompletionView | undefined {
  const status = row.terminalStatus;
  if (status === undefined) return undefined;
  return {
    runId: row.identity.runId,
    subagentId: row.identity.subagentId,
    agent: row.identity.agent,
    label: row.identity.description,
    status,
    durationMillis: elapsedMillis(row, now),
  };
}

/** The view for a stored Result, which carries all six directly. */
export function completionViewOfResult(result: RunResult): RunCompletionView {
  return {
    runId: result.runId,
    subagentId: result.subagentId,
    agent: result.agent,
    label: result.description,
    status: result.status,
    durationMillis: Math.max(0, result.settledAt - result.startedAt),
  };
}

/** The view for a completion notice, which is derived from a Result. */
export function completionViewOfNotification(
  notice: RunNotification,
): RunCompletionView {
  return {
    runId: notice.runId,
    subagentId: notice.subagentId,
    agent: notice.agent,
    label: notice.label,
    status: notice.status,
    durationMillis: notice.durationMillis,
  };
}
