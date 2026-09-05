/**
 * The backend seam: where an observation becomes a domain value.
 *
 * `emit` is the function an adapter is handed, and it does three things in
 * order, each of which is a rule from an ADR rather than an implementation
 * detail:
 *
 * 1. **After sealing, it is a no-op.** The contract says emit never fails, and
 *    a Run that has captured its terminal candidate has nothing left to reduce
 *    — so a late emit is counted and dropped rather than throwing at an
 *    adapter that is on its way out. This is what makes "late events cannot
 *    mutate a terminal Run" true at the seam as well as at the reducer.
 * 2. **It decodes.** ADR-0024 says provider wire objects never cross the
 *    boundary, and ADR-0029 says decoding at the seam is how that becomes
 *    checked rather than trusted. A malformed observation is an adapter
 *    defect, so it becomes a bounded `backend-failure` diagnostic *on the
 *    Run* and the original is dropped: visible, survivable, and carrying the
 *    schema's own reason, which names what was expected and never the value.
 * 3. **It applies backpressure.** The queue is bounded, and offering to a full
 *    one waits. A semantic observation is never silently dropped, so a backend
 *    that outruns the reducer is slowed down rather than truncated.
 *
 * The third rule is the one an adapter cannot always honour, because a native
 * callback may not be able to wait. {@link offerWithoutWaiting} is what such a
 * bridge uses, and it fails the Run visibly rather than dropping — see the
 * bridge policy in the backend module.
 */

import { type Cause, Effect, Queue, type Scope } from "effect";
import {
  decodeRunObservation,
  type RunObservation,
  runDiagnostic,
} from "../domain/index.ts";
import type { RuntimeCounters } from "./counters.ts";

/** What a decode failure at the seam becomes, on the Run it happened to. */
export function seamFailureObservation(reason: string): RunObservation {
  return {
    kind: "diagnostic",
    // The reason is the formatted schema issue: what was expected and the key
    // path it failed at. It carries no part of the offending value, which is
    // what makes it safe to put on a Run at all.
    diagnostic: runDiagnostic(
      "backend-failure",
      `a backend emitted an observation the domain cannot read: ${reason}`,
    ),
  };
}

export interface ObservationIntake {
  /** What the adapter is handed. Never fails, whatever it is given. */
  readonly emit: (observation: RunObservation) => Effect.Effect<void>;
  /** Take the next accepted observation. Fails with `Done` once sealed. */
  readonly queue: Queue.Queue<RunObservation, Cause.Done>;
  /**
   * Stop accepting, and let the reducer drain what is already in.
   *
   * Idempotent, because settlement may reach it from more than one direction.
   */
  readonly seal: () => Effect.Effect<void>;
  readonly sealed: () => boolean;
}

/**
 * Build one Run's intake, bound to its scope.
 *
 * The queue is acquired into the caller's scope, so closing the Run Scope
 * closes the queue whether or not settlement got that far.
 */
export function makeIntake(
  bound: number,
  counters: RuntimeCounters,
): Effect.Effect<ObservationIntake, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      Effect.map(Queue.bounded<RunObservation, Cause.Done>(bound), (made) => {
        counters.acquired("openObservationQueues");
        return made;
      }),
      (made) =>
        Effect.sync(() => {
          counters.released("openObservationQueues");
          void made;
        }),
    );
    let sealed = false;

    const emit = (observation: RunObservation): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (sealed) {
          counters.count("lateEvents");
          return Effect.void;
        }
        const decoded = decodeRunObservation(observation);
        if (decoded._tag === "Failure") {
          counters.count("seamDecodeFailures");
          return Effect.asVoid(
            Queue.offer(queue, seamFailureObservation(decoded.failure.message)),
          );
        }
        return Effect.asVoid(Queue.offer(queue, decoded.success));
      });

    return {
      emit,
      queue,
      seal: () =>
        Effect.suspend(() => {
          if (sealed) return Effect.void;
          sealed = true;
          return Effect.asVoid(Queue.end(queue));
        }),
      sealed: () => sealed,
    };
  });
}

/**
 * Hand one observation over without waiting, for a bridge that cannot.
 *
 * The policy this serves is decided in the backend module, in
 * `backend/native-bridge.ts`, because it is a rule about what an adapter must
 * do. This is the half that belongs with the intake: it returns whether the
 * observation was taken, and a caller that gets `false` must emit
 * `bridgeOverflowObservations()` rather than carry on. Dropping is not on the
 * list.
 */
export function offerWithoutWaiting(
  intake: ObservationIntake,
  observation: RunObservation,
  counters: RuntimeCounters,
): boolean {
  if (intake.sealed()) {
    counters.count("lateEvents");
    return true;
  }
  const decoded = decodeRunObservation(observation);
  if (decoded._tag === "Failure") {
    counters.count("seamDecodeFailures");
    const taken = Queue.offerUnsafe(
      intake.queue,
      seamFailureObservation(decoded.failure.message),
    );
    if (!taken) counters.count("queueOverflows");
    return taken;
  }
  const taken = Queue.offerUnsafe(intake.queue, decoded.success);
  if (!taken) counters.count("queueOverflows");
  return taken;
}
