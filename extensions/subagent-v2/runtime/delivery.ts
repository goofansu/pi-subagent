/**
 * `CompletionDelivery`: telling the model, from what was stored.
 *
 * The one rule that shapes everything here is that **storage precedes
 * notification**, and delivery reads what was stored rather than being handed
 * it. That is what makes a notification failure survivable: a retry re-reads
 * the same immutable result, so it cannot deliver something different from
 * what `agent_result` would return, and it cannot alter settlement because it
 * has nothing to alter it with. Delivery never calls the repository writer,
 * never re-enters settlement, and never touches a stored result — the only
 * thing it does to the store is let go of the pin it was given.
 *
 * Deduplication is by Run id, because a Run has exactly one completion and a
 * model told twice would act twice. Both a settlement wake-up and a sweep can
 * reach the same Run, and the set is what makes that harmless.
 *
 * The sweep exists because a wake-up can be missed — a fiber interrupted
 * between publication and delivery, a subscription that dropped an event — and
 * the store is the source of truth that makes recovery possible: whatever is
 * stored, terminal, and not in the delivered set has not been announced.
 */

import { Context, Effect, Layer, Ref } from "effect";
import {
  type RunId,
  type RunNotification,
  toRunNotification,
} from "../domain/index.ts";
import type { RuntimeCounters } from "./counters.ts";
import type { RuntimePolicy } from "./policy.ts";
import { ResultStore } from "./result-store.ts";

/** Why a push did not land. Retryable by definition; nothing else is. */
export interface NotificationPushFailure {
  readonly reason: string;
}

/**
 * Where a notification goes.
 *
 * An interface with one method, because M3 supplies the real Session push and
 * nothing about delivery should change when it does. In M2 the only
 * implementation is the fake the tests use.
 */
export interface NotificationSink {
  readonly push: (
    notification: RunNotification,
  ) => Effect.Effect<void, NotificationPushFailure>;
}

interface DeliveryState {
  /** Ids that must never be pushed again: delivered, or given up on. */
  readonly done: ReadonlySet<RunId>;
  /** Ids that actually landed. */
  readonly delivered: ReadonlySet<RunId>;
  /** Ids whose retry budget ran out. */
  readonly exhausted: ReadonlySet<RunId>;
  readonly stopped: boolean;
}

const EMPTY_DELIVERY: DeliveryState = {
  done: new Set(),
  delivered: new Set(),
  exhausted: new Set(),
  stopped: false,
};

const makeDelivery = (
  policy: RuntimePolicy,
  sink: NotificationSink,
  counters: RuntimeCounters,
) =>
  Effect.gen(function* () {
    const store = yield* ResultStore;
    const state = yield* Ref.make(EMPTY_DELIVERY);

    /**
     * Claim one Run id for delivery.
     *
     * The claim and the check are one atomic step, so a settlement wake-up and
     * a sweep arriving together produce one push rather than two.
     */
    const claim = (runId: RunId): Effect.Effect<boolean> =>
      Ref.modify(state, (current) => {
        if (current.stopped || current.done.has(runId)) return [false, current];
        return [true, { ...current, done: new Set(current.done).add(runId) }];
      });

    const push = (notification: RunNotification): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const { attempts, delayMillis } = policy.deliveryRetryBudget;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const pushed = yield* Effect.exit(sink.push(notification));
          if (pushed._tag === "Success") return true;
          // The budget is on the runtime clock, so a test advances it rather
          // than waiting for it.
          if (attempt < attempts) yield* Effect.sleep(delayMillis);
        }
        return false;
      });

    /**
     * Deliver one settled Run, if it has not been dealt with already.
     *
     * A Run whose stored output is gone is *not* an error and is not retried:
     * there is nothing to preview, and the model can still ask for it and be
     * told it expired.
     */
    const deliver = (runId: RunId): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!(yield* claim(runId))) return;
        const stored = yield* store.read(runId);
        if (stored.outcome !== "result") {
          yield* store.releasePin(runId, "delivery");
          return;
        }
        const landed = yield* push(toRunNotification(stored.result));
        yield* Ref.update(state, (current) =>
          landed
            ? {
                ...current,
                delivered: new Set(current.delivered).add(runId),
              }
            : {
                ...current,
                exhausted: new Set(current.exhausted).add(runId),
              },
        );
        if (!landed) counters.count("deliveryFailures");
        // Either way the pin goes: a result held open for a notification that
        // is never going to land is a result nothing can ever evict.
        yield* store.releasePin(runId, "delivery");
      });

    /**
     * Deliver anything stored that was never announced.
     *
     * Called by settlement after publication as well as on demand, so a missed
     * wake-up costs one extra pass rather than a lost notification.
     */
    const sweep = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.stopped) return;
        const stored = yield* store.stored();
        yield* Effect.forEach(
          stored.filter((runId) => !current.done.has(runId)),
          deliver,
          { discard: true },
        );
      });

    return {
      deliver,
      sweep,
      /**
       * Stop delivering, at shutdown.
       *
       * A notification that has not landed is dropped rather than queued: the
       * next Session's model did not start these Runs.
       */
      stop: (): Effect.Effect<void> =>
        Ref.update(state, (current) => ({ ...current, stopped: true })),
      delivered: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) => [...current.delivered]),
      exhausted: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) => [...current.exhausted]),
    };
  });

export type CompletionDeliveryApi = Effect.Success<
  ReturnType<typeof makeDelivery>
>;

export class CompletionDelivery extends Context.Service<
  CompletionDelivery,
  CompletionDeliveryApi
>()("pi-subagent-v2/runtime/CompletionDelivery") {
  static layerOf(
    policy: RuntimePolicy,
    sink: NotificationSink,
    counters: RuntimeCounters,
  ): Layer.Layer<CompletionDelivery, never, ResultStore> {
    return Layer.effect(
      CompletionDelivery,
      Effect.map(makeDelivery(policy, sink, counters), (api) =>
        CompletionDelivery.of(api),
      ),
    );
  }
}

/**
 * A sink that records what it was given, and can be told to fail.
 *
 * Lives beside the interface rather than in the test tree because both the
 * conformance rig and the race tests need one, and two copies of it would
 * drift.
 */
export interface FakeNotificationSink extends NotificationSink {
  readonly received: () => readonly RunNotification[];
  /** How many pushes were attempted, including the ones that failed. */
  readonly attempts: () => number;
  /** Fail the next `count` pushes. `Infinity` fails every one. */
  readonly failNext: (count: number) => void;
}

export function createFakeNotificationSink(): FakeNotificationSink {
  const received: RunNotification[] = [];
  let attempts = 0;
  let failing = 0;
  return {
    push: (notification) =>
      Effect.suspend(() => {
        attempts += 1;
        if (failing > 0) {
          failing -= 1;
          return Effect.fail<NotificationPushFailure>({
            reason: "the sink refused the push",
          });
        }
        received.push(notification);
        return Effect.void;
      }),
    received: () => [...received],
    attempts: () => attempts,
    failNext: (count) => {
      failing = count;
    },
  };
}
