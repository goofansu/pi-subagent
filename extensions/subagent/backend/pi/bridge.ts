/**
 * Pi's callback bridge overflow policy.
 *
 * Pi hands events to a synchronous listener while the adapter's observation
 * intake applies backpressure. Effect's bounded Queue owns the ordering and
 * wake-up mechanics. This module owns only the callback-side offer and the
 * policy for the one thing a synchronous producer cannot do: wait for room.
 */

import { Effect, type Option, Queue } from "effect";
import type { RunObservation } from "../../domain/index.ts";
import { bridgeOverflowObservations } from "../native-bridge.ts";

/** How many observations may wait for the reducer inside the adapter. */
export const BRIDGE_BUFFER_BOUND = 4096;

export interface CallbackBridge {
  /** Whether the callback is still taking events. */
  readonly accepting: () => boolean;
  /** Whether an offer exhausted the bounded Queue. */
  readonly overflowed: () => boolean;
  /** Buffer one observation synchronously. False means this offer overflowed. */
  readonly offer: (observation: RunObservation) => boolean;
  /** Take the next observation, waiting when the Queue is empty. */
  readonly take: Effect.Effect<RunObservation>;
  /** Poll one observation without waiting. */
  readonly poll: Effect.Effect<Option.Option<RunObservation>>;
  /** Overflow observations that could not themselves fit in the full Queue. */
  readonly takeOverflowPolicy: () => readonly RunObservation[];
  /** Stop taking events. Whatever is buffered can still be drained. */
  readonly stop: () => void;
}

export function createCallbackBridge(
  bound: number = BRIDGE_BUFFER_BOUND,
): Effect.Effect<CallbackBridge> {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<RunObservation>(bound);
    let accepting = true;
    let overflowed = false;
    let overflowPolicy: readonly RunObservation[] = [];

    return {
      accepting: () => accepting,
      overflowed: () => overflowed,
      offer: (observation) => {
        if (!accepting) return false;
        if (Queue.offerUnsafe(queue, observation)) return true;

        accepting = false;
        overflowed = true;
        const policy = bridgeOverflowObservations();
        const firstRefused = policy.findIndex(
          (overflowObservation) =>
            !Queue.offerUnsafe(queue, overflowObservation),
        );
        if (firstRefused >= 0) overflowPolicy = policy.slice(firstRefused);
        return false;
      },
      take: Queue.take(queue),
      poll: Queue.poll(queue),
      takeOverflowPolicy: () => {
        const pending = overflowPolicy;
        overflowPolicy = [];
        return pending;
      },
      stop: () => {
        accepting = false;
      },
    };
  });
}
