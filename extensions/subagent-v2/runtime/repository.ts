/**
 * `RunRepository`: the only writer of Run snapshots.
 *
 * Everything that displays or acts on a Run reads its snapshot from here, and
 * exactly one thing writes them. That is the whole design: v1's shared mutable
 * Run record (ADR-0004) let four different modules reach the same object, and
 * the cost was that no single place knew what a Run currently looked like.
 * Here the reducer fiber and the settlement coordinator call methods;
 * adapters, delivery, and presentation never do.
 *
 * The index is published through a `SubscriptionRef`. Two different things are
 * often confused about that, and only one of them is free:
 *
 * - **The snapshot is conflated.** A row holds one activity value, replaced
 *   rather than appended, so a hundred progress updates grow the index by
 *   nothing. That falls out of the projection's own rule and is what stops a
 *   chatty backend from growing what every reader has to walk.
 * - **The change stream is not.** `SubscriptionRef.changes` delivers every
 *   value a subscriber has not yet taken, so a slow one gets a backlog rather
 *   than the latest. {@link RunRepositoryApi.subscribe} therefore reads the
 *   *current* index at the moment each change is delivered, which means a
 *   consumer never renders a value that is already stale — but it may be
 *   handed the same value more than once, and a consumer that must not do
 *   redundant work has to say so itself.
 *
 * The repository also owns the **spent-id set**, so identifier allocation and
 * the promise that no identifier is ever reused are the same fact. An id
 * allocated for a start that then failed to open stays spent even though no
 * Run was ever published.
 */

import {
  Context,
  Effect,
  Layer,
  Ref,
  type Scope,
  type Stream,
  SubscriptionRef,
} from "effect";
import {
  type CancellationReason,
  type CancellationRequest,
  EMPTY_USAGE_SNAPSHOT,
  ILLEGAL_TRANSITION,
  isTerminalRunPhase,
  type RunEvent,
  type RunId,
  type RunIdentity,
  RunId as RunIdSchema,
  type RunPhase,
  type RunProjection,
  recordCancellation,
  type SubagentId,
  SubagentId as SubagentIdSchema,
  type TerminalRunPhase,
  transitionRun,
  type UsageSnapshot,
} from "../domain/index.ts";
import type { RuntimeCounters } from "./counters.ts";

/**
 * What one Run looks like right now.
 *
 * Deliberately not the projection. A projection holds the whole transcript,
 * and the index is read by everything: publishing the transcript on every
 * observation would make a UI subscriber's work proportional to how much a
 * backend said. What a row needs is identity, where the Run is, and the few
 * figures a widget shows.
 */
export interface RunSnapshot {
  readonly identity: RunIdentity;
  readonly phase: RunPhase;
  /** Present once a cancellation has been recorded, whatever the phase. */
  readonly cancellation?: CancellationRequest;
  /** Conflated and display-only. Cleared when the Run settles. */
  readonly activity?: string;
  readonly usage: UsageSnapshot;
  /** How many tool calls the Run has, not which ones. */
  readonly tools: number;
  readonly startedAt: number;
  /** Present exactly when the phase is terminal. */
  readonly terminalStatus?: TerminalRunPhase;
}

/** The current Run index: every Run this Session has published, by id. */
export type RunIndex = ReadonlyMap<RunId, RunSnapshot>;

/**
 * What the repository knows about an id.
 *
 * Four answers, and the last two are the distinction that has to exist
 * somewhere. `spent` means the id was allocated for a start that never got as
 * far as publishing a Run — a failed open — so no Run ever had it and it can
 * never be handed out again. `unknown` means it was never allocated at all.
 * Both are `unknown Run` to a caller, because operation semantics gives them
 * one answer; they are separate here so a maintainer reading the repository
 * can tell a spent id from a wrong one.
 *
 * A Run whose stored output has since been evicted is `terminal` here and
 * `ResultExpired` at the store.
 */
export type RunLookup =
  | { readonly state: "active"; readonly snapshot: RunSnapshot }
  | { readonly state: "terminal"; readonly snapshot: RunSnapshot }
  | { readonly state: "spent" }
  | { readonly state: "unknown" };

/** What recording a cancellation on the index did. */
export type CancellationOutcome =
  | { readonly outcome: "recorded"; readonly request: CancellationRequest }
  | { readonly outcome: "unchanged"; readonly request: CancellationRequest }
  | { readonly outcome: "already terminal"; readonly status: TerminalRunPhase }
  | { readonly outcome: "unknown Run" };

/** What a transition attempt did. An illegal one is reported, never thrown. */
export type TransitionOutcome =
  | { readonly outcome: "moved"; readonly phase: RunPhase }
  | { readonly outcome: "illegal"; readonly phase: RunPhase }
  | { readonly outcome: "unknown Run" };

function withRun(
  index: RunIndex,
  runId: RunId,
  update: (snapshot: RunSnapshot) => RunSnapshot,
): RunIndex {
  const snapshot = index.get(runId);
  if (!snapshot) return index;
  const next = new Map(index);
  next.set(runId, update(snapshot));
  return next;
}

const make = (counters: RuntimeCounters) =>
  Effect.gen(function* () {
    const index = yield* SubscriptionRef.make<RunIndex>(new Map());
    const spentRunIds = yield* Ref.make<ReadonlySet<string>>(new Set());
    const spentSubagentIds = yield* Ref.make<ReadonlySet<string>>(new Set());
    let sequence = 0;

    /**
     * Allocate an id and spend it in the same step.
     *
     * Allocation and spending cannot be two calls, because the gap between
     * them is exactly where a reused id would come from: a start that fails
     * between allocating and publishing would otherwise release the id.
     */
    const allocate = <T extends string>(
      spent: Ref.Ref<ReadonlySet<string>>,
      prefix: string,
      brand: (value: string) => T,
    ): Effect.Effect<T> =>
      Ref.modify(spent, (ids) => {
        sequence += 1;
        const value = `${prefix}-${sequence}`;
        return [brand(value), new Set(ids).add(value)];
      });

    return {
      /** The published index, for a UI consumer to subscribe to. */
      index,

      /**
       * A live view of the index, held for the caller's scope.
       *
       * Counted, because a subscription that outlives its consumer is a leak of
       * exactly the kind the probe exists to catch, and a raw
       * `SubscriptionRef.changes` would be invisible to it.
       */
      subscribe: (): Effect.Effect<
        Stream.Stream<RunIndex>,
        never,
        Scope.Scope
      > =>
        Effect.map(
          Effect.acquireRelease(
            Effect.sync(() => counters.acquired("repositorySubscriptions")),
            () =>
              Effect.sync(() => counters.released("repositorySubscriptions")),
          ),
          () => SubscriptionRef.changes(index),
        ),

      allocateRunId: (): Effect.Effect<RunId> =>
        allocate(spentRunIds, "run", (value) => RunIdSchema.make(value)),

      allocateSubagentId: (): Effect.Effect<SubagentId> =>
        allocate(spentSubagentIds, "subagent", (value) =>
          SubagentIdSchema.make(value),
        ),

      /** Whether an id was ever handed out this Session. */
      isSpent: (id: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const runs = yield* Ref.get(spentRunIds);
          const subagents = yield* Ref.get(spentSubagentIds);
          return runs.has(id) || subagents.has(id);
        }),

      /**
       * Publish a Run for the first time, in `running`.
       *
       * This is what makes a Run public: before it, the caller holds ids and
       * nothing else, which is what lets a failed open leave nothing behind.
       */
      publish: (
        identity: RunIdentity,
        startedAt: number,
      ): Effect.Effect<RunSnapshot> =>
        SubscriptionRef.modify(index, (current) => {
          const snapshot: RunSnapshot = {
            identity,
            phase: "running",
            usage: EMPTY_USAGE_SNAPSHOT,
            tools: 0,
            startedAt,
          };
          const next = new Map(current);
          next.set(identity.runId, snapshot);
          return [snapshot, next];
        }),

      /**
       * Fold what the reducer produced into the row.
       *
       * The projection stays with the Run fiber; only the few figures a
       * reader needs are published.
       */
      recordProjection: (
        runId: RunId,
        projection: RunProjection,
      ): Effect.Effect<void> =>
        SubscriptionRef.update(index, (current) =>
          withRun(current, runId, (snapshot) => {
            const next: RunSnapshot = {
              ...snapshot,
              usage: projection.usage,
              tools: projection.tools.length,
            };
            // Activity is conflated *and clearable*: a backend that reported
            // nothing is doing nothing in particular, and a stale value left on
            // the row would read as though it still were.
            if (projection.activity === undefined) {
              delete (next as { activity?: string }).activity;
            } else {
              (next as { activity?: string }).activity = projection.activity;
            }
            return next;
          }),
        ),

      transition: (
        runId: RunId,
        event: RunEvent,
      ): Effect.Effect<TransitionOutcome> =>
        SubscriptionRef.modify(index, (current) => {
          const snapshot = current.get(runId);
          if (!snapshot) {
            return [{ outcome: "unknown Run" } as TransitionOutcome, current];
          }
          const phase = transitionRun(snapshot.phase, event);
          if (phase === ILLEGAL_TRANSITION) {
            return [
              {
                outcome: "illegal",
                phase: snapshot.phase,
              } as TransitionOutcome,
              current,
            ];
          }
          const next = new Map(current);
          const moved: RunSnapshot = {
            ...snapshot,
            phase,
            ...(isTerminalRunPhase(phase) ? { terminalStatus: phase } : {}),
          };
          // A settled Run is quiet: the activity a backend last reported is
          // not what it is doing, because it is not doing anything.
          if (phase !== "running")
            delete (moved as { activity?: string }).activity;
          next.set(runId, moved);
          return [{ outcome: "moved", phase } as TransitionOutcome, next];
        }),

      /**
       * Record a cancellation request. The first reason wins.
       *
       * A request is not a phase change: the Run reaches `cancelled` only
       * when its execution and finalizers have finished. ADR-0025.
       */
      recordCancellation: (
        runId: RunId,
        reason: CancellationReason,
      ): Effect.Effect<CancellationOutcome> =>
        SubscriptionRef.modify(index, (current) => {
          const snapshot = current.get(runId);
          if (!snapshot) {
            return [{ outcome: "unknown Run" } as CancellationOutcome, current];
          }
          const recording = recordCancellation(
            snapshot.phase,
            snapshot.cancellation,
            reason,
          );
          if (recording.outcome === ILLEGAL_TRANSITION) {
            return [
              {
                outcome: "already terminal",
                status: recording.phase as TerminalRunPhase,
              } as CancellationOutcome,
              current,
            ];
          }
          if (recording.outcome === "unchanged") {
            return [
              {
                outcome: "unchanged",
                request: recording.request,
              } as CancellationOutcome,
              current,
            ];
          }
          const next = new Map(current);
          next.set(runId, { ...snapshot, cancellation: recording.request });
          return [
            {
              outcome: "recorded",
              request: recording.request,
            } as CancellationOutcome,
            next,
          ];
        }),

      get: (runId: RunId): Effect.Effect<RunSnapshot | undefined> =>
        Effect.map(SubscriptionRef.get(index), (current) => current.get(runId)),

      lookup: (runId: RunId): Effect.Effect<RunLookup> =>
        Effect.map(SubscriptionRef.get(index), (current) => {
          const snapshot = current.get(runId);
          if (!snapshot) return { state: "unknown" } as RunLookup;
          return isTerminalRunPhase(snapshot.phase)
            ? ({ state: "terminal", snapshot } as RunLookup)
            : ({ state: "active", snapshot } as RunLookup);
        }),

      /**
       * Forget every identity, at shutdown.
       *
       * Operation semantics section 5: the next Session's model did not start
       * these Runs. The spent set goes with the index, because an id can only
       * be reused by a Session that never issued it, and this Session is over.
       */
      forget: (): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(index, new Map());
          yield* Ref.set(spentRunIds, new Set());
          yield* Ref.set(spentSubagentIds, new Set());
        }),

      /** Every Run this Session has published, newest last. */
      list: (): Effect.Effect<readonly RunSnapshot[]> =>
        Effect.map(SubscriptionRef.get(index), (current) => [
          ...current.values(),
        ]),

      /** How many Runs are not yet terminal. */
      activeCount: (): Effect.Effect<number> =>
        Effect.map(
          SubscriptionRef.get(index),
          (current) =>
            [...current.values()].filter(
              (snapshot) => !isTerminalRunPhase(snapshot.phase),
            ).length,
        ),

      /** The active Run of one Subagent, if it has one. */
      activeRunOf: (
        subagentId: SubagentId,
      ): Effect.Effect<RunSnapshot | undefined> =>
        Effect.map(SubscriptionRef.get(index), (current) =>
          [...current.values()].find(
            (snapshot) =>
              snapshot.identity.subagentId === subagentId &&
              !isTerminalRunPhase(snapshot.phase),
          ),
        ),
    };
  });

/** What the service exposes, derived from what builds it. */
export type RunRepositoryApi = Effect.Success<ReturnType<typeof make>>;

export class RunRepository extends Context.Service<
  RunRepository,
  RunRepositoryApi
>()("pi-subagent-v2/runtime/RunRepository") {
  static layerOf(counters: RuntimeCounters): Layer.Layer<RunRepository> {
    return Layer.effect(
      RunRepository,
      Effect.map(make(counters), (api) => RunRepository.of(api)),
    );
  }
}
