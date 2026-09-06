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

import { Schema } from "effect";
import {
  boundList,
  boundObservation,
  droppedAmount,
  type TruncationEvent,
} from "./bounding.ts";
import { type RunDiagnostic, runDiagnostic } from "./diagnostics.ts";
import type { ReconciliationObservation } from "./observations.ts";
import {
  DEFAULT_PROJECTION_BOUNDS,
  type ProjectionBounds,
  type RunProjection,
} from "./projection.ts";
import type { TerminalReconciliation } from "./reconciliation.ts";
import { TranscriptItem } from "./transcript.ts";
import {
  ContextGauge,
  isUsableContextGauge,
  raiseTurns,
  replaceContextGauge,
  replaceUsageTotals,
  UsageTotals,
} from "./usage.ts";

/**
 * The projection fields a snapshot can change, in the order they are reported.
 *
 * The order is the order this module applies them in, and it is fixed so that
 * the diagnostic a difference produces reads the same way every time.
 */
export const RECONCILED_FIELDS = [
  "transcript",
  "finalOutput",
  "usage",
  "context",
  "turns",
  "model",
] as const;

export type ReconciledField = (typeof RECONCILED_FIELDS)[number];

export interface ReconcileOutcome {
  readonly projection: RunProjection;
  /** What bounding the replacement itself removed, for the caller's report. */
  readonly dropped: readonly TruncationEvent[];
  /**
   * Which fields the snapshot actually altered, in {@link RECONCILED_FIELDS}
   * order.
   *
   * Compared *after* bounding, against what the projection already held, so a
   * snapshot that restates the stream — including one whose only effect is to
   * re-truncate identical content — reports nothing. That is what lets a
   * caller distinguish "a snapshot was applied" from "a snapshot disagreed",
   * and it is why replaying a reconciliation reports an empty set.
   */
  readonly changed: readonly ReconciledField[];
}

/** The diagnostic a Run carries when its terminal snapshot disagreed. */
export function reconciliationDifference(
  changed: readonly ReconciledField[],
): RunDiagnostic {
  return runDiagnostic(
    "reconciliation-difference",
    `terminal snapshot changed ${changed.join(", ")}`,
  );
}

/**
 * Structural comparison, derived from the schemas rather than written out.
 *
 * A hand-written comparison would have to enumerate the fields of
 * {@link UsageTotals}, {@link ContextGauge}, and {@link TranscriptItem}, and a
 * field added to any of them later would silently stop being compared — which
 * here means a real disagreement that stops being reported, stops being
 * counted, and stops producing a diagnostic. Deriving the comparison from the
 * schema makes that impossible: the schema is already the one place those
 * fields are declared.
 *
 * Built once rather than per call, like the reducer's decoder: these are
 * compiled from a schema, and rebuilding them for every settling Run would be
 * the one place this function does real work.
 */
const sameTranscript = Schema.toEquivalence(Schema.Array(TranscriptItem));
const sameTotals = Schema.toEquivalence(UsageTotals);
const sameGauge = Schema.toEquivalence(ContextGauge);

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
  const bounded = boundObservation(
    { kind: "reconciliation", reconciliation },
    bounds,
  );
  const boundedReconciliation =
    bounded.observation as ReconciliationObservation;
  const reconciled = reconcileBoundedRun(
    projection,
    boundedReconciliation.reconciliation,
    bounds,
    bounded.dropped,
  );
  return {
    ...reconciled,
    dropped: [...bounded.dropped, ...reconciled.dropped],
  };
}

/** Apply an already text-bounded snapshot; used by the reducer's one bound. */
export function reconcileBoundedRun(
  projection: RunProjection,
  reconciliation: TerminalReconciliation,
  bounds: ProjectionBounds,
  textDropped: readonly TruncationEvent[],
): ReconcileOutcome {
  const dropped: TruncationEvent[] = [];
  const changed: ReconciledField[] = [];
  let next = projection;

  if (reconciliation.transcript !== undefined) {
    const replaced = boundList(
      reconciliation.transcript,
      bounds.maxTranscriptItems,
      "transcript",
    );
    dropped.push(...replaced.dropped);
    // Bounded value against bounded value: a snapshot that carried more items
    // than fit and a stream that did are the same transcript afterwards, and
    // the truncation record the replacement rewrites is bookkeeping about the
    // bound rather than something the snapshot disagreed about.
    if (!sameTranscript([...replaced.items], [...next.transcript])) {
      changed.push("transcript");
    }
    next = {
      ...next,
      transcript: replaced.items,
      truncation: {
        ...next.truncation,
        // Set rather than add: the snapshot supersedes every streamed item, so
        // what was dropped from the streamed transcript is no longer true of
        // the transcript that is there now. Setting is also what makes a
        // replayed reconciliation produce the same record.
        droppedTranscriptItems: replaced.droppedItems,
        truncatedTranscriptBytes: droppedAmount(textDropped, "transcript-text"),
      },
    };
  }

  if (reconciliation.finalOutput !== undefined) {
    if (reconciliation.finalOutput !== next.finalOutput) {
      changed.push("finalOutput");
    }
    next = {
      ...next,
      finalOutput: reconciliation.finalOutput,
      truncation: {
        ...next.truncation,
        truncatedOutputBytes: droppedAmount(textDropped, "final-output"),
      },
    };
  }

  if (reconciliation.usage !== undefined) {
    const replaced = replaceUsageTotals(next.usage, reconciliation.usage);
    if (!sameTotals(replaced.totals, next.usage.totals)) changed.push("usage");
    next = { ...next, usage: replaced };
  }

  if (
    reconciliation.context !== undefined &&
    isUsableContextGauge(reconciliation.context)
  ) {
    // An absent *or unusable* gauge leaves the streamed one in place. A gauge
    // never resets to zero, and never becomes nonsense, because a snapshot
    // said something the domain cannot read. Same rule as the turn count
    // below, and the reason a bad gauge does not invalidate the whole
    // reconciliation.
    const replaced = replaceContextGauge(next.usage, reconciliation.context);
    if (!sameGauge(replaced.context, next.usage.context)) {
      changed.push("context");
    }
    next = { ...next, usage: replaced };
  }

  if (reconciliation.turns !== undefined) {
    // Raise, never lower, and ignore an unusable total: a cancelled Run has
    // already observed real turns, and a short terminal figure must not erase
    // that progress. A total that raised nothing changed nothing, and an
    // unusable one is the same case.
    const raised = raiseTurns(next.usage, reconciliation.turns);
    if (raised.turns !== next.usage.turns) changed.push("turns");
    next = { ...next, usage: raised };
  }

  if (reconciliation.model !== undefined) {
    if (reconciliation.model !== next.model) changed.push("model");
    next = { ...next, model: reconciliation.model };
  }

  return { projection: next, dropped, changed };
}
