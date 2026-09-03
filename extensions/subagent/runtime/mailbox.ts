/**
 * One Run's Control mailbox.
 *
 * ADR-0026's rule is that admission is **synchronous and bounded**, and never
 * blocks the caller's turn. `agent_steer` is a tool call inside somebody's
 * turn, and a mailbox that made it wait would make steering a way to stall the
 * model that was trying to steer.
 *
 * Bounded on three axes, because one is not enough: sixteen Controls of a
 * megabyte each is not a bounded mailbox, and neither is one Control of a
 * gigabyte. The three are v1's, unchanged — a caller who learned v1's steering
 * rhythm finds v2 behaves the same way.
 *
 * `accepted` is a statement about *this mailbox* and nothing else. It does not
 * mean the adapter dequeued the message, the provider accepted it, or a model
 * consumed it. Only authoritative provider evidence of the guidance becomes an
 * observation on the Run, which is why nothing here writes one.
 *
 * Closure discards what was never sent. A Control admitted to a Run that is
 * settling must never reach the Subagent's *next* Run, and the cheapest way to
 * guarantee that is for there to be nothing left to reach it with.
 */

import { type Cause, Effect, Queue } from "effect";
import type { ControlFeed, RunControl } from "../backend/contract.ts";
import { byteLength } from "../domain/index.ts";
import type { RuntimeCounters } from "./counters.ts";
import type { ControlBounds } from "./policy.ts";

/** What admission answers. The public `SteerOutcome` adds the Run's own cases. */
export type MailboxAdmission =
  | "accepted"
  | "mailbox full"
  | "invalid"
  | "mailbox closed";

export interface ControlMailbox {
  /** Synchronous, bounded, and never blocking. */
  readonly admit: (control: RunControl) => Effect.Effect<MailboxAdmission>;
  /** What the adapter takes from: one consumer, one at a time, in order. */
  readonly feed: ControlFeed;
  /** Close and discard. Idempotent. */
  readonly close: () => Effect.Effect<void>;
  readonly isClosed: () => boolean;
  /** Admitted and not yet taken. */
  readonly pending: () => number;
}

/** Why a Control is not admissible at all, whatever the mailbox holds. */
function isUsable(control: RunControl, bounds: ControlBounds): boolean {
  if (control.text.trim() === "") return false;
  return byteLength(control.text) <= bounds.maxMessageBytes;
}

export function makeMailbox(
  bounds: ControlBounds,
  counters: RuntimeCounters,
): Effect.Effect<ControlMailbox, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      Effect.map(
        Queue.bounded<RunControl, Cause.Done>(bounds.maxPending),
        (made) => {
          counters.acquired("openMailboxes");
          return made;
        },
      ),
      () => Effect.sync(() => counters.released("openMailboxes")),
    );
    let closed = false;
    let pendingBytes = 0;

    /**
     * The whole admission decision, in one synchronous step.
     *
     * Both bounds and the handoff are read and written without an interruption
     * point between them, so two concurrent steers cannot both see the same
     * last free slot.
     */
    const admit = (control: RunControl): Effect.Effect<MailboxAdmission> =>
      Effect.sync(() => {
        if (closed) return "mailbox closed" as const;
        if (!isUsable(control, bounds)) return "invalid" as const;
        const size = byteLength(control.text);
        if (pendingBytes + size > bounds.maxPendingBytes) {
          return "mailbox full" as const;
        }
        // Nothing is truncated and nothing is dropped silently: a Control that
        // does not fit is refused whole.
        if (!Queue.offerUnsafe(queue, control)) return "mailbox full" as const;
        pendingBytes += size;
        return "accepted" as const;
      });

    const feed: ControlFeed = {
      take: Effect.gen(function* () {
        const next = yield* Effect.exit(Queue.take(queue));
        if (next._tag !== "Success") return undefined;
        pendingBytes -= byteLength(next.value.text);
        return next.value;
      }),
    };

    return {
      admit,
      feed,
      close: () =>
        Effect.gen(function* () {
          if (closed) return;
          closed = true;
          // Discard first, end second. What was admitted and never taken is
          // gone, so it cannot reach this Run's adapter on its way out and it
          // cannot reach the Subagent's next Run at all.
          yield* Effect.ignore(Queue.clear(queue));
          pendingBytes = 0;
          yield* Queue.end(queue);
        }),
      isClosed: () => closed,
      pending: () => Queue.sizeUnsafe(queue),
    };
  });
}
