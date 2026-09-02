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
 * integers. A delta that fails those rules is rejected at construction rather
 * than coerced, because a coerced counter is a wrong number that no later
 * reader can distinguish from a right one.
 */
export interface UsageDelta {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
  readonly turns?: number;
}

export class UsageValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`invalid usage field '${field}': ${reason}`);
    this.name = "UsageValidationError";
    this.field = field;
  }
}

function countReason(value: unknown): string | undefined {
  if (typeof value !== "number") return "not a number";
  if (!Number.isFinite(value)) return "not finite";
  if (!Number.isInteger(value)) return "not an integer";
  if (value < 0) return "negative";
  return undefined;
}

function costReason(value: unknown): string | undefined {
  if (typeof value !== "number") return "not a number";
  if (!Number.isFinite(value)) return "not finite";
  if (value < 0) return "negative";
  return undefined;
}

/**
 * Why a value is not a usable delta, or `undefined` when it is.
 *
 * The reducer needs this as a predicate rather than as an exception: an
 * adapter that emits a malformed delta gets its observation reported as
 * invalid, and the Run carries on.
 */
export function usageDeltaProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!(USAGE_DELTA_FIELDS as readonly string[]).includes(field)) {
      return `unknown field '${field}'`;
    }
  }
  for (const field of USAGE_COUNT_FIELDS) {
    if (record[field] === undefined) continue;
    const reason = countReason(record[field]);
    if (reason) return `${field} is ${reason}`;
  }
  if (record.cost !== undefined) {
    const reason = costReason(record.cost);
    if (reason) return `cost is ${reason}`;
  }
  return undefined;
}

/**
 * Build a validated delta carrying only the fields that were supplied, so two
 * deltas meaning the same thing compare deep-equal.
 */
export function usageDelta(fields: UsageDelta): UsageDelta {
  const problem = usageDeltaProblem(fields);
  if (problem) {
    const [field] = problem.split(" ");
    throw new UsageValidationError(field ?? "usage", problem);
  }
  const delta: Record<string, number> = {};
  for (const field of USAGE_DELTA_FIELDS) {
    const value = fields[field];
    if (value !== undefined) delta[field] = value;
  }
  return delta as UsageDelta;
}

/**
 * How much of a Conversation's context window is occupied right now.
 *
 * `window` is the denominator when a backend reports one; occupancy is
 * meaningful without it.
 */
export interface ContextGauge {
  readonly tokens: number;
  readonly window?: number;
}

export const EMPTY_CONTEXT_GAUGE: ContextGauge = { tokens: 0 };

export function contextGaugeProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (field !== "tokens" && field !== "window") {
      return `unknown field '${field}'`;
    }
  }
  const tokens = countReason(record.tokens);
  if (tokens) return `tokens is ${tokens}`;
  if (record.window !== undefined) {
    const window = countReason(record.window);
    if (window) return `window is ${window}`;
  }
  return undefined;
}

export function contextGauge(tokens: number, window?: number): ContextGauge {
  const gauge: ContextGauge =
    window === undefined ? { tokens } : { tokens, window };
  const problem = contextGaugeProblem(gauge);
  if (problem) {
    const [field] = problem.split(" ");
    throw new UsageValidationError(field ?? "context", problem);
  }
  return gauge;
}

/** The summed counters, with every field present because they start at zero. */
export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

/** The fields a terminal reconciliation may replace, each independently. */
export type UsageTotalsPatch = Partial<UsageTotals>;

/** What a Run spent: summed totals, the current gauge, and the turn count. */
export interface UsageSnapshot {
  readonly totals: UsageTotals;
  readonly context: ContextGauge;
  readonly turns: number;
}

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
  if (countReason(turns)) return snapshot;
  const raised = turns as number;
  if (raised <= snapshot.turns) return snapshot;
  return { ...snapshot, turns: raised };
}
