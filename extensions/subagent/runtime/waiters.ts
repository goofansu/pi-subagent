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

/**
 * One waiter's registration, and the only thing it can do with it.
 *
 * A value rather than a bare `Effect<void>` because the two would be
 * indistinguishable at the call site and mean opposite things: registering is
 * what the *call* does, and the Effect that comes back is the *release*. A
 * `register` typed as `(runId) => Effect<void>` would make
 * `yield* register(runId)` register a waiter and immediately let it go, which
 * reads like the obvious thing to write.
 */
export interface WaiterRegistration {
  /**
   * Give up this waiter's registration. Run it once, however the wait ended.
   *
   * Idempotent: running it again does nothing.
   */
  readonly release: Effect.Effect<void>;
}

export interface WaiterLedger {
  /**
   * Register one waiter, and hand back the release for that waiter alone.
   *
   * Synchronous — a count and a counter — because it happens between deciding
   * to wait and starting to wait, and nothing may interleave there.
   */
  readonly register: (runId: RunId) => WaiterRegistration;
  /**
   * Let go of the waiters' pin if no waiter is registered.
   *
   * Settlement calls this, which is how a Run nobody waited on releases its
   * pin at once rather than at a read that never comes.
   */
  readonly releaseIfIdle: (runId: RunId) => Effect.Effect<void>;
}

export function makeWaiterLedger(
  pin: WaiterPin,
  counters: RuntimeCounters,
): WaiterLedger {
  /** How many waiters are registered for each Run. */
  const registered = new Map<RunId, number>();

  const releaseIfIdle = (runId: RunId): Effect.Effect<void> =>
    Effect.suspend(() =>
      (registered.get(runId) ?? 0) > 0 ? Effect.void : pin.release(runId),
    );

  return {
    register: (runId) => {
      registered.set(runId, (registered.get(runId) ?? 0) + 1);
      counters.acquired("unresolvedWaiters");
      let released = false;
      return {
        release: Effect.suspend(() => {
          // Idempotent for the same reason the admission lease is: a
          // registration given up twice would give up another waiter's, and
          // the pin would go with it while somebody was still entitled to
          // read.
          if (released) return Effect.void;
          released = true;
          counters.released("unresolvedWaiters");
          const left = (registered.get(runId) ?? 1) - 1;
          if (left <= 0) registered.delete(runId);
          else registered.set(runId, left);
          return releaseIfIdle(runId);
        }),
      };
    },
    releaseIfIdle,
  };
}
