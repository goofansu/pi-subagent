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
 * stored, terminal, and not in the handed-off set has not been announced.
 *
 * **A push the host accepted is not a notice the model has read**, and the
 * names here say so. Delivery knows four states — pending, handed off,
 * exhausted, unannounceable — and *handed off* is the strongest successful
 * one: the host took the
 * message. Whether that message ever reached the conversation is the Session
 * push sink's fact and nobody else's, so this file has no word for it, and a
 * boundary rule fails the suite if the sink's vocabulary appears here. A
 * reader who found it would conclude that an accepted push means the model
 * has the notice, which is the one wrong conclusion this module can cause.
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

/** Why the host would not take the message. Retryable by definition. */
export interface NotificationPushFailure {
  readonly reason: string;
}

/**
 * Where a notification goes.
 *
 * Three methods: one request and two reports. `push` asks the host to take a
 * message; `exhausted` tells it that this Run's budget is spent; and
 * `unannounceable` tells it that the settled Run had no Result from which a
 * message could be built. Delivery already knows those facts, and the host is
 * the only component that can show them, so reporting them gives the whole
 * hand-off state one owner instead of stranding states in runtime bookkeeping.
 *
 * It is still an interface about delivery and nothing else. Everything the
 * host knows beyond these states is the host's vocabulary, and boundary
 * rule 19 keeps it out of this file.
 * [ADR-0035](../../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)
 * is the decision.
 */
export interface NotificationSink {
  readonly push: (
    notification: RunNotification,
  ) => Effect.Effect<void, NotificationPushFailure>;
  /**
   * This Run's retry budget is spent, and delivery is done trying.
   *
   * Cannot fail: there is nothing a host could say that delivery would act
   * on, and a report that could fail would need a retry of its own.
   */
  readonly exhausted: (runId: RunId) => Effect.Effect<void>;
  /**
   * This Run settled, but the store has no Result from which to build a notice.
   *
   * Cannot fail for the same reason as {@link exhausted}: delivery has no
   * recovery action to take from the host's answer.
   */
  readonly unannounceable: (runId: RunId) => Effect.Effect<void>;
}

interface DeliveryState {
  /**
   * Ids this Session has taken responsibility for.
   *
   * Claimed *before* the push, and kept whatever the push did, because a Run
   * that was announced and a Run whose budget ran out are equally finished as
   * far as delivery is concerned. `handedOff` says which of the two it was.
   */
  readonly claimed: ReadonlySet<RunId>;
  /** Ids the host accepted the message for. What happens to it next is not ours. */
  readonly handedOff: ReadonlySet<RunId>;
  /** Ids whose complete retry budget ran out without a hand-off. */
  readonly exhausted: ReadonlySet<RunId>;
  /** Ids whose settled Run had no Result from which to build a notice. */
  readonly unannounceable: ReadonlySet<RunId>;
  readonly stopped: boolean;
}

const EMPTY_DELIVERY: DeliveryState = {
  claimed: new Set(),
  handedOff: new Set(),
  exhausted: new Set(),
  unannounceable: new Set(),
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
    const claim = (
      runId: RunId,
    ): Effect.Effect<"claimed" | "duplicate" | "stopped"> =>
      Ref.modify(state, (current) => {
        if (current.stopped) return ["stopped", current];
        if (current.claimed.has(runId)) return ["duplicate", current];
        return [
          "claimed",
          { ...current, claimed: new Set(current.claimed).add(runId) },
        ];
      });

    const push = (notification: RunNotification): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const { attempts, delayMillis } = policy.deliveryRetryBudget;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          // Stop is checked at every attempt boundary, including after a retry
          // sleep, so shutdown cannot let one last push escape.
          if ((yield* Ref.get(state)).stopped) return false;
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
        const claimed = yield* claim(runId);
        if (claimed === "stopped") {
          yield* store.releasePin(runId, "delivery");
          return;
        }
        if (claimed === "duplicate") return;
        const stored = yield* store.read(runId);
        if (stored.outcome !== "result") {
          // Release first: reports are terminal bookkeeping, and the host must
          // never be able to observe a report while delivery still pins output.
          yield* store.releasePin(runId, "delivery");
          if (!(yield* Ref.get(state)).stopped) {
            yield* Ref.update(state, (current) => ({
              ...current,
              unannounceable: new Set(current.unannounceable).add(runId),
            }));
            yield* sink.unannounceable(runId);
          }
          return;
        }
        const handedOff = yield* push(toRunNotification(stored.result));
        if (handedOff) {
          yield* Ref.update(state, (current) => ({
            ...current,
            handedOff: new Set(current.handedOff).add(runId),
          }));
        } else if (!(yield* Ref.get(state)).stopped) {
          counters.count("deliveryFailures");
          yield* Ref.update(state, (current) => ({
            ...current,
            exhausted: new Set(current.exhausted).add(runId),
          }));
          // Reported, not retried: the host is the only thing that can show a
          // Run whose notice is never coming.
          yield* sink.exhausted(runId);
        }
        // Either way the pin goes: a result held open for a notification the
        // host will never take is a result nothing can ever evict.
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
       * A notification the host has not taken is dropped rather than queued:
       * the next Session's model did not start these Runs.
       */
      stop: (): Effect.Effect<void> =>
        Ref.update(state, (current) => ({ ...current, stopped: true })),
      /** Ids whose notification the host accepted. Not ids whose notice arrived. */
      handedOff: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) => [...current.handedOff]),
      /** Ids this Session gave up announcing, after exhausting the budget. */
      exhausted: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) => [...current.exhausted]),
      /** Ids for which the store had no Result to announce. */
      unannounceable: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) => [...current.unannounceable]),
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
