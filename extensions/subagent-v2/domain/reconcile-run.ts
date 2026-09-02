/**
 * Terminal reconciliation: healing streamed drift without double counting.
 *
 * A backend that has an authoritative terminal snapshot gets one chance to
 * correct what it streamed. The rule is per field and has exactly two cases: a
 * field present in the snapshot **replaces** its projected value, and a field
 * absent from the snapshot **retains** the streamed one. There is no merge, no
 * append, and no addition — adding a terminal usage figure to a streamed sum
 * is how a Run comes to report twice what it spent.
 *
 * Replaying the same reconciliation is a no-op. That is not a nicety: the
 * supervisor's settlement path may retry, and a reconciliation that
 * accumulated would turn a retry into a wrong answer. Every field is replaced
 * rather than accumulated, and the two byte counts a replacement affects are
 * *set* rather than added, which is what makes replay safe.
 *
 * See docs/adr/0025-v2-terminal-settlement.md and
 * docs/adr/0027-v2-usage-normalization.md.
 */

import {
  boundProjectionText,
  boundTranscript,
  type TruncationEvent,
} from "./bounding.ts";
import {
  DEFAULT_PROJECTION_BOUNDS,
  type ProjectionBounds,
  type RunProjection,
} from "./projection.ts";
import type { TerminalReconciliation } from "./reconciliation.ts";
import {
  contextGaugeProblem,
  raiseTurns,
  replaceContextGauge,
  replaceUsageTotals,
} from "./usage.ts";

export interface ReconcileOutcome {
  readonly projection: RunProjection;
  /** What bounding the replacement itself removed, for the caller's report. */
  readonly dropped: readonly TruncationEvent[];
}

/**
 * Apply a terminal snapshot to a projection.
 *
 * The projection's terminality is not changed here. Reconciliation happens
 * *before* settlement, as the last ordered observation of the Run, so it is
 * not a late event healing a terminal Run — the ending that follows it is what
 * makes the Run terminal.
 */
export function reconcileRun(
  projection: RunProjection,
  reconciliation: TerminalReconciliation,
  bounds: ProjectionBounds = DEFAULT_PROJECTION_BOUNDS,
): ReconcileOutcome {
  const dropped: TruncationEvent[] = [];
  let next = projection;

  if (reconciliation.transcript !== undefined) {
    const replaced = boundTranscript(reconciliation.transcript, bounds);
    dropped.push(...replaced.dropped);
    next = {
      ...next,
      transcript: replaced.transcript,
      truncation: {
        ...next.truncation,
        // Set rather than add: the snapshot supersedes every streamed item, so
        // what was dropped from the streamed transcript is no longer true of
        // the transcript that is there now. Setting is also what makes a
        // replayed reconciliation produce the same record.
        droppedTranscriptItems: replaced.droppedItems,
        truncatedTranscriptBytes: replaced.cutBytes,
      },
    };
  }

  if (reconciliation.finalOutput !== undefined) {
    const bounded = boundProjectionText(
      reconciliation.finalOutput,
      bounds.maxFinalOutputBytes,
      "final-output",
    );
    dropped.push(...bounded.dropped);
    next = {
      ...next,
      finalOutput: bounded.text,
      truncation: {
        ...next.truncation,
        truncatedOutputBytes: bounded.cutBytes,
      },
    };
  }

  if (reconciliation.usage !== undefined) {
    next = {
      ...next,
      usage: replaceUsageTotals(next.usage, reconciliation.usage),
    };
  }

  if (
    reconciliation.context !== undefined &&
    contextGaugeProblem(reconciliation.context) === undefined
  ) {
    // An absent *or unusable* gauge leaves the streamed one in place. A gauge
    // never resets to zero, and never becomes nonsense, because a snapshot
    // said something the domain cannot read. Same rule as the turn count
    // below, and the reason a bad gauge does not invalidate the whole
    // reconciliation.
    next = {
      ...next,
      usage: replaceContextGauge(next.usage, reconciliation.context),
    };
  }

  if (reconciliation.turns !== undefined) {
    // Raise, never lower, and ignore an unusable total: a cancelled Run has
    // already observed real turns, and a short terminal figure must not erase
    // that progress.
    next = { ...next, usage: raiseTurns(next.usage, reconciliation.turns) };
  }

  if (reconciliation.model !== undefined) {
    next = { ...next, model: reconciliation.model };
  }

  return { projection: next, dropped };
}
