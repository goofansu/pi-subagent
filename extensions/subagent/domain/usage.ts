/**
 * Usage: additive deltas, a latest-value gauge, and the snapshot they fold
 * into.
 *
 * ADR-0027 splits what a backend reports into two kinds with two different
 * fold rules, and summing the wrong one is the single easiest mistake to make
 * when porting an adapter. Keeping the kinds in different types with different
 * functions is what makes that mistake a compile error rather than a wrong
 * number.
 *
 * - A {@link UsageDelta} is **additive**: tokens, cost, and turns a backend
 *   reports for the Run it is executing, which the core sums.
 * - A {@link ContextGauge} is a **gauge**: the most recent observed occupancy
 *   wins, intermediate values may be dropped, and a missing value leaves the
 *   previous one in place. It is never summed.
 *
 * Reconciliation *replaces* a usage field rather than adding to it, so healing
 * streamed drift cannot double count. Turn counts are the one refinement: a
 * terminal total may raise an observed count but never lower it.
 *
 * See docs/adr/0027-v2-usage-normalization.md.
 */

import { Schema } from "effect";
import { EXACT_KEYS } from "./decoding.ts";

/** A whole unit of something a backend counted. */
const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

/**
 * A real-valued amount, which cost is and no counter is.
 *
 * Split from {@link Count} rather than shared with it because a fractional
 * token total is a wrong number and a fractional cost is the normal case.
 */
const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Counters a backend reports as whole units. */
export const USAGE_COUNT_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "turns",
] as const;

/** Every field a delta may carry, counters plus the one real-valued one. */
export const USAGE_DELTA_FIELDS = [...USAGE_COUNT_FIELDS, "cost"] as const;

export type UsageDeltaField = (typeof USAGE_DELTA_FIELDS)[number];

/**
 * One Run-local additive usage report.
 *
 * Every field is optional because backends report different subsets, and every
 * present field is a nonnegative finite number — the counters additionally
 * integers. A delta that fails those rules is rejected rather than coerced,
 * because a coerced counter is a wrong number that no later reader can
 * distinguish from a right one.
 */
export const UsageDelta = Schema.Struct({
  input: Schema.optionalKey(Count),
  output: Schema.optionalKey(Count),
  cacheRead: Schema.optionalKey(Count),
  cacheWrite: Schema.optionalKey(Count),
  cost: Schema.optionalKey(Amount),
  turns: Schema.optionalKey(Count),
});

export type UsageDelta = typeof UsageDelta.Type;

/**
 * How much of a Conversation's context window is occupied right now.
 *
 * `window` is the denominator when a backend reports one; occupancy is
 * meaningful without it.
 */
export const ContextGauge = Schema.Struct({
  tokens: Schema.Number,
  /** Optional; explicit `undefined` is accepted. */
  window: Schema.optional(Schema.Number),
});

export type ContextGauge = typeof ContextGauge.Type;

/**
 * The same shape with the domain's numeric rules applied.
 *
 * The two exist separately because a gauge is read in two situations with two
 * honest answers. A `context` *observation* that fails these rules is a
 * malformed observation and is reported as one. A gauge inside a terminal
 * reconciliation that fails them is one bad field of a snapshot that may also
 * carry a transcript, an output, and a usage total — so it is ignored on its
 * own and the rest of the snapshot still heals. {@link ContextGauge} is what
 * both accept; this is what both check against.
 */
export const UsableContextGauge = Schema.Struct({
  tokens: Count,
  window: Schema.optional(Count),
});

const decodeUsableContextGauge = Schema.decodeUnknownResult(
  UsableContextGauge,
  EXACT_KEYS,
);

/** Whether a gauge's numbers are ones the domain can use. */
export function isUsableContextGauge(value: unknown): boolean {
  return decodeUsableContextGauge(value)._tag === "Success";
}

export const EMPTY_CONTEXT_GAUGE: ContextGauge = { tokens: 0 };

const decodeUsageDelta = Schema.decodeUnknownSync(UsageDelta, EXACT_KEYS);

const decodeUsableGauge = Schema.decodeUnknownSync(
  UsableContextGauge,
  EXACT_KEYS,
);

/**
 * Build a validated delta carrying only the fields that were supplied, so two
 * deltas meaning the same thing compare deep-equal.
 */
export function usageDelta(fields: UsageDelta): UsageDelta {
  // A field explicitly set to `undefined` is dropped so that two deltas
  // meaning the same thing compare deep-equal; every other key is carried
  // through, so an unlisted one reaches the decoder and is rejected there.
  const supplied: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) supplied[field] = value;
  }
  return decodeUsageDelta(supplied);
}

export function contextGauge(tokens: number, window?: number): ContextGauge {
  return decodeUsableGauge(
    window === undefined ? { tokens } : { tokens, window },
  );
}

/** The summed counters, with every field present because they start at zero. */
export const UsageTotals = Schema.Struct({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  cost: Amount,
});

export type UsageTotals = typeof UsageTotals.Type;

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

/** The fields a terminal reconciliation may replace, each independently. */
export const UsageTotalsPatch = Schema.Struct({
  input: Schema.optionalKey(Count),
  output: Schema.optionalKey(Count),
  cacheRead: Schema.optionalKey(Count),
  cacheWrite: Schema.optionalKey(Count),
  cost: Schema.optionalKey(Amount),
});

export type UsageTotalsPatch = typeof UsageTotalsPatch.Type;

/** What a Run spent: summed totals, the current gauge, and the turn count. */
export const UsageSnapshot = Schema.Struct({
  totals: UsageTotals,
  context: ContextGauge,
  turns: Count,
});

export type UsageSnapshot = typeof UsageSnapshot.Type;

export const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = {
  totals: EMPTY_USAGE_TOTALS,
  context: EMPTY_CONTEXT_GAUGE,
  turns: 0,
};

/** Add one delta. The gauge is untouched: a gauge is never summed. */
export function addUsageDelta(
  snapshot: UsageSnapshot,
  delta: UsageDelta,
): UsageSnapshot {
  return {
    totals: {
      input: snapshot.totals.input + (delta.input ?? 0),
      output: snapshot.totals.output + (delta.output ?? 0),
      cacheRead: snapshot.totals.cacheRead + (delta.cacheRead ?? 0),
      cacheWrite: snapshot.totals.cacheWrite + (delta.cacheWrite ?? 0),
      cost: snapshot.totals.cost + (delta.cost ?? 0),
    },
    context: snapshot.context,
    turns: snapshot.turns + (delta.turns ?? 0),
  };
}

/** Replace the gauge with the latest observed occupancy. */
export function replaceContextGauge(
  snapshot: UsageSnapshot,
  context: ContextGauge,
): UsageSnapshot {
  return { ...snapshot, context };
}

/**
 * Replace present totals and retain absent ones.
 *
 * This is reconciliation's rule, and the reason it is a separate function from
 * {@link addUsageDelta}: an authoritative terminal figure supersedes what was
 * streamed, and adding it to the streamed sum would double count.
 */
export function replaceUsageTotals(
  snapshot: UsageSnapshot,
  patch: UsageTotalsPatch,
): UsageSnapshot {
  const totals: UsageTotals = {
    input: patch.input ?? snapshot.totals.input,
    output: patch.output ?? snapshot.totals.output,
    cacheRead: patch.cacheRead ?? snapshot.totals.cacheRead,
    cacheWrite: patch.cacheWrite ?? snapshot.totals.cacheWrite,
    cost: patch.cost ?? snapshot.totals.cost,
  };
  return { ...snapshot, totals };
}

/**
 * Raise the turn count, never lower it, and ignore an unusable total.
 *
 * A cancelled or failed Run has already observed real turns. A terminal figure
 * that is smaller — because the backend counts differently, or because the
 * execution was cut short before its last turn was counted — must not erase
 * that progress.
 */
export function raiseTurns(
  snapshot: UsageSnapshot,
  turns: unknown,
): UsageSnapshot {
  if (!Schema.is(Count)(turns)) return snapshot;
  if (turns <= snapshot.turns) return snapshot;
  return { ...snapshot, turns };
}
