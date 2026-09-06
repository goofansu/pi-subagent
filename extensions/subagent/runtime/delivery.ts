/**
 * CompletionDelivery reads immutable stored Results and hands notices to the
 * host. A claim deduplicates settlement wake-ups and sweeps.
 * Storage precedes notification, so a failed push cannot lose or alter a Result.
 *
 * A successful push means the host accepted the message, not that the notice
 * reached the conversation. Only the Session push sink observes that later
 * event, so this module has no word for it: hand-off is its strongest success.
 *
 * See [ADR-0035](../../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md);
 * the boundary tests enforce the separation from host-only delivery vocabulary.
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

export interface NotificationPushFailure {
  readonly reason: string;
}

/** Push may be retried; terminal reports have no recovery action. */
export interface NotificationSink {
  readonly push: (
    notification: RunNotification,
  ) => Effect.Effect<void, NotificationPushFailure>;
  readonly exhausted: (runId: RunId) => Effect.Effect<void>;
  readonly unannounceable: (runId: RunId) => Effect.Effect<void>;
}

type DeliveryStatus = "pending" | "handedOff" | "exhausted" | "unannounceable";

interface DeliveryState {
  /** Presence is the claim; one status replaces overlapping bookkeeping sets. */
  readonly runs: ReadonlyMap<RunId, DeliveryStatus>;
  readonly stopped: boolean;
}

const makeDelivery = (
  policy: RuntimePolicy,
  sink: NotificationSink,
  counters: RuntimeCounters,
) =>
  Effect.gen(function* () {
    const store = yield* ResultStore;
    const state = yield* Ref.make<DeliveryState>({
      runs: new Map(),
      stopped: false,
    });

    // Claim before pushing, atomically: a concurrent sweep must not also push.
    const claim = (
      runId: RunId,
    ): Effect.Effect<"claimed" | "duplicate" | "stopped"> =>
      Ref.modify(state, (current) => {
        if (current.stopped) return ["stopped", current];
        if (current.runs.has(runId)) return ["duplicate", current];
        return [
          "claimed",
          { ...current, runs: new Map(current.runs).set(runId, "pending") },
        ];
      });

    const record = (runId: RunId, status: DeliveryStatus) =>
      Ref.update(state, (current) => {
        const runs = new Map(current.runs);
        // Diagnostic lists retain terminal-report order, not claim order.
        runs.delete(runId);
        runs.set(runId, status);
        return { ...current, runs };
      });

    const idsWithStatus = (status: DeliveryStatus) =>
      Effect.map(Ref.get(state), (current) =>
        [...current.runs]
          .filter(([, value]) => value === status)
          .map(([id]) => id),
      );

    const push = (notification: RunNotification): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const { attempts, delayMillis } = policy.deliveryRetryBudget;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          // Recheck after every sleep so shutdown cannot allow another push.
          if ((yield* Ref.get(state)).stopped) return false;
          const pushed = yield* Effect.exit(sink.push(notification));
          if (pushed._tag === "Success") return true;
          if (attempt < attempts) yield* Effect.sleep(delayMillis);
        }
        return false;
      });

    const deliver = (runId: RunId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const claimed = yield* claim(runId);
        if (claimed === "duplicate") return;
        if (claimed === "stopped") {
          yield* store.releasePin(runId, "delivery");
          return;
        }
        yield* Effect.gen(function* () {
          const stored = yield* store.read(runId);
          if (stored.outcome !== "result") {
            // Release before the report; the finalizer's idempotent release
            // also covers interruption and the other delivery paths.
            yield* store.releasePin(runId, "delivery");
            if (!(yield* Ref.get(state)).stopped) {
              yield* record(runId, "unannounceable");
              yield* sink.unannounceable(runId);
            }
            return;
          }
          if (yield* push(toRunNotification(stored.result))) {
            yield* record(runId, "handedOff");
          } else if (!(yield* Ref.get(state)).stopped) {
            counters.count("deliveryFailures");
            yield* record(runId, "exhausted");
            yield* sink.exhausted(runId);
          }
        }).pipe(Effect.ensuring(store.releasePin(runId, "delivery")));
      });

    /** Storage is authoritative: a sweep recovers a missed delivery wake-up. */
    const sweep = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.stopped) return;
        const stored = yield* store.stored();
        yield* Effect.forEach(
          stored.filter((runId) => !current.runs.has(runId)),
          deliver,
          { discard: true },
        );
      });

    return {
      deliver,
      sweep,
      stop: (): Effect.Effect<void> =>
        Ref.update(state, (current) => ({ ...current, stopped: true })),
      handedOff: () => idsWithStatus("handedOff"),
      exhausted: () => idsWithStatus("exhausted"),
      unannounceable: () => idsWithStatus("unannounceable"),
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
