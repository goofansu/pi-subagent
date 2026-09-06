/** Internal ResultStore state and eviction; not part of the service interface. */
import type {
  RunId,
  SubagentId,
  TerminalRunPhase,
} from "../../domain/index.ts";
import type { RuntimeCounters } from "../counters.ts";

/**
 * Who is still holding a result open.
 *
 * Three named holders rather than a count, so a release cannot be attributed
 * to the wrong one and a double release cannot free a pin twice.
 */
export const PIN_HOLDERS = ["publication", "waiters", "delivery"] as const;
export type PinHolder = (typeof PIN_HOLDERS)[number];

/**
 * One entry, which outlives its output.
 *
 * Eviction removes the output and keeps the entry, because operation semantics
 * section 8 says a spent identifier and a wrong identifier are different
 * mistakes and get different answers. Without the entry there would be nothing
 * to answer `ResultExpired` with.
 */
export interface StoredEntry {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
  readonly status: TerminalRunPhase;
  /** Encoded JSON. Absent once evicted. */
  readonly encoded?: string;
  readonly bytes: number;
  readonly pins: ReadonlySet<PinHolder>;
  /** Whether this stored form has already counted as unreadable. */
  readonly unreadableObserved?: boolean;
}

export interface StoreState {
  readonly entries: ReadonlyMap<RunId, StoredEntry>;
  readonly reservations: ReadonlyMap<RunId, number>;
}

/** Reserved plus stored, which is what the budget is measured against. */
export function committedBytes(state: StoreState): number {
  let total = 0;
  for (const size of state.reservations.values()) total += size;
  for (const entry of state.entries.values()) total += entry.bytes;
  return total;
}

/**
 * Free space in one commit-ordered pass over a private entries copy.
 *
 * A Map preserves insertion order, and replacing an existing value does not
 * move its key. Commit order therefore remains intact when pins change. The
 * just-committed result is pinned, so this can never evict the newest result
 * it was called to make room for.
 *
 * Owns the copy it mutates; the input state remains unchanged.
 */
export function evict(
  state: StoreState,
  budget: number,
  counters: RuntimeCounters,
): StoreState {
  let accounted = committedBytes(state);
  if (accounted <= budget) return state;

  const entries = new Map(state.entries);
  for (const [runId, entry] of entries) {
    if (entry.encoded === undefined || entry.pins.size > 0) continue;
    const { encoded: _dropped, ...kept } = entry;
    entries.set(runId, { ...kept, bytes: 0 });
    accounted -= entry.bytes;
    counters.count("evictions");
    if (accounted <= budget) break;
  }
  return { ...state, entries };
}
