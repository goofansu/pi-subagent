/**
 * The waiter ledger: how many callers registered at a Run's settlement have
 * yet to read it, and the Result-store pin they collectively hold.
 *
 * `agent_wait` is the one operation whose caller can walk away. Contributing
 * invariant 13 says aborting a waiter stops only that waiter — the Run
 * continues, still settles exactly once, and still stores its result — so the
 * bookkeeping has to come back whether the wait resolved, timed out, or was
 * interrupted. That is why `register` hands back a release rather than being
 * paired with a second call somebody has to remember: the release goes
 * straight into the wait's own `ensuring`, where all three endings pass
 * through it.
 *
 * The pin is what stops eviction reaching a result before its registered
 * readers have had it. It is held by *the ledger*, not by any one waiter, so
 * it is let go at exactly two moments: when the last waiter releases, and
 * when settlement finds there were none. The second is not an optimisation —
 * without it a Run nobody waited on would hold a result open for a reader who
 * never arrives.
 */

import { Effect } from "effect";
import type { RunId } from "../domain/index.ts";
import type { RuntimeCounters } from "./counters.ts";

/**
 * The one thing the ledger does to the Result store.
 *
 * Narrow on purpose: the store keeps three *named* pin holders so that a
 * release is attributable to one of them, and the ledger is the `waiters`
 * holder. Handing it a `release` its caller already bound to that name keeps
 * the holder vocabulary where the freeze put it, and keeps this module from
 * knowing anything else about how results are stored.
 */
export interface WaiterPin {
  readonly release: (runId: RunId) => Effect.Effect<void>;
}

export interface WaiterLedger {
  /**
   * Take a place in the ledger for one waiter, and hand back its release.
   *
   * Registering is synchronous — a count and a counter — because it happens
   * between deciding to wait and starting to wait, and nothing may interleave
   * there. What comes back is the release for *this* waiter alone, to be run
   * once when its wait ends however it ends. Running it again does nothing.
   */
  readonly register: (runId: RunId) => Effect.Effect<void>;
  /**
   * Let go of the waiters' pin if nobody is holding a place.
   *
   * Settlement calls this, which is how a Run nobody waited on releases its
   * pin at once rather than at a read that never comes.
   */
  readonly releaseIfIdle: (runId: RunId) => Effect.Effect<void>;
  /** Places currently held for this Run. */
  readonly waiting: (runId: RunId) => number;
}

export function makeWaiterLedger(
  pin: WaiterPin,
  counters: RuntimeCounters,
): WaiterLedger {
  const places = new Map<RunId, number>();

  const releaseIfIdle = (runId: RunId): Effect.Effect<void> =>
    Effect.suspend(() =>
      (places.get(runId) ?? 0) > 0 ? Effect.void : pin.release(runId),
    );

  return {
    register: (runId) => {
      places.set(runId, (places.get(runId) ?? 0) + 1);
      counters.acquired("unresolvedWaiters");
      let released = false;
      return Effect.suspend(() => {
        // Idempotent for the same reason the admission lease is: a place given
        // up twice would free another waiter's, and the pin would go with it
        // while somebody was still entitled to read.
        if (released) return Effect.void;
        released = true;
        counters.released("unresolvedWaiters");
        const left = (places.get(runId) ?? 1) - 1;
        if (left <= 0) places.delete(runId);
        else places.set(runId, left);
        return releaseIfIdle(runId);
      });
    },
    releaseIfIdle,
    waiting: (runId) => places.get(runId) ?? 0,
  };
}
