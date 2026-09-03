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
  /**
   * Ids this Session has taken responsibility for.
   *
   * Claimed *before* the push, and kept whatever the push did, because a Run
   * that was announced and a Run whose budget ran out are equally finished as
   * far as delivery is concerned. `delivered` says which of the two it was.
   */
  readonly claimed: ReadonlySet<RunId>;
  /** Ids that actually landed. */
  readonly delivered: ReadonlySet<RunId>;
  readonly stopped: boolean;
}

const EMPTY_DELIVERY: DeliveryState = {
  claimed: new Set(),
  delivered: new Set(),
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
        if (current.stopped || current.claimed.has(runId)) {
          return [false, current];
        }
        return [
          true,
          { ...current, claimed: new Set(current.claimed).add(runId) },
        ];
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
        if (landed) {
          yield* Ref.update(state, (current) => ({
            ...current,
            delivered: new Set(current.delivered).add(runId),
          }));
        } else {
          counters.count("deliveryFailures");
        }
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
          stored.filter((runId) => !current.claimed.has(runId)),
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
      /** Ids whose notification landed. */
      delivered: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) => [...current.delivered]),
      /** Ids this Session gave up announcing, after exhausting the budget. */
      exhausted: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) =>
          [...current.claimed].filter((runId) => !current.delivered.has(runId)),
        ),
    };
  });

export type CompletionDeliveryApi = Effect.Success<
  ReturnType<typeof makeDelivery>
>;

export class CompletionDelivery extends Context.Service<
  CompletionDelivery,
  CompletionDeliveryApi
>()("pi-subagent/runtime/CompletionDelivery") {
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
