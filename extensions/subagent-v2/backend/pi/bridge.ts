/**
 * The callback bridge: Pi's synchronous listener, and the Effect that drains
 * it.
 *
 * Pi hands events to a plain JavaScript callback that cannot wait, and the
 * intake an adapter emits into can. Something has to sit between them, and
 * what it must **not** do is drop: a Run that quietly lost half its transcript
 * is indistinguishable from a Run that had nothing more to say. So the bridge
 * buffers, the execution drains with backpressure, and a buffer that fills
 * anyway fails the Run out loud with the two observations the backend module's
 * bridge policy decided on.
 *
 * The version counter is the whole reason this is a module rather than three
 * lines in the execution. A waiter that checked "is anything buffered", found
 * nothing, and then registered would miss an event pushed in between — and the
 * Run would hang with its answer sitting in an array. Registering against the
 * version seen at the check closes that window without a lock.
 *
 * Nothing here is Pi-specific. It is here rather than shared because it is one
 * adapter's answer to one provider's callback shape, and the next adapter's
 * provider may not need one.
 */

import { Effect } from "effect";
import type { RunObservation } from "../../domain/index.ts";
import { bridgeOverflowObservations } from "../native-bridge.ts";

/**
 * How many observations may wait for the reducer inside the adapter.
 *
 * Generous: the reducer is drained continuously by the execution, so anything
 * in here is a momentary burst rather than a backlog. Small enough that a
 * runaway provider fails the Run instead of taking the heap.
 */
export const BRIDGE_BUFFER_BOUND = 4096;

export interface CallbackBridge {
  /** Whether the callback is still taking events. */
  readonly accepting: () => boolean;
  /** Take one buffered observation, or nothing. */
  readonly take: () => RunObservation | undefined;
  readonly size: () => number;
  /** Buffer one observation. Never throws, never waits. */
  readonly push: (observation: RunObservation) => void;
  /** Wake anything waiting, without buffering anything. */
  readonly signal: () => void;
  /** Stop taking events. Whatever is buffered can still be drained. */
  readonly stop: () => void;
  /** What the caller saw last, so a wait cannot miss a push. */
  readonly version: () => number;
  /** Wait until the version moves past `seen`. */
  readonly waitPast: (seen: number) => Effect.Effect<void>;
}

export function createCallbackBridge(
  bound: number = BRIDGE_BUFFER_BOUND,
): CallbackBridge {
  const buffered: RunObservation[] = [];
  const waiters = new Set<() => void>();
  let accepting = true;
  let overflowed = false;
  let version = 0;

  const bump = (): void => {
    version += 1;
    for (const wake of [...waiters]) wake();
  };

  return {
    accepting: () => accepting,
    size: () => buffered.length,
    take: () => buffered.shift(),
    version: () => version,
    push: (observation) => {
      if (!accepting) return;
      if (buffered.length >= bound) {
        // Never drop silently. The policy says the Run must say it could not
        // keep up, and the two observations that say so are the last things
        // this bridge accepts.
        if (overflowed) return;
        overflowed = true;
        accepting = false;
        buffered.push(...bridgeOverflowObservations());
        bump();
        return;
      }
      buffered.push(observation);
      bump();
    },
    signal: bump,
    stop: () => {
      accepting = false;
      bump();
    },
    waitPast: (seen) =>
      Effect.callback<void>((resume) => {
        if (version !== seen) {
          resume(Effect.void);
          return;
        }
        const wake = (): void => {
          waiters.delete(wake);
          resume(Effect.void);
        };
        waiters.add(wake);
        return Effect.sync(() => {
          waiters.delete(wake);
        });
      }),
  };
}
