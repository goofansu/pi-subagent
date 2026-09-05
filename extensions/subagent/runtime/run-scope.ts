/**
 * One Run's scope: what it holds, and the order it lets go in.
 *
 * A Run Scope holds a bounded observation intake, one reducer fiber, a
 * cancellation record on the repository row, a completion `Deferred` used only
 * to wake people up, a settlement coordinator, and — nested inside it — the
 * native execution scope. The nesting is the point: a provider turn may end
 * without ending the Run, but it can never outlive it (ADR-0023).
 *
 * The settlement path is the roadmap's, in the roadmap's order, and the order
 * is what makes the user-visible invariant true:
 *
 *   if the widget shows a Run as completed, `agent_result` for that Run
 *   returns a result, never `RunNotTerminal`.
 *
 * That is why the terminal snapshot is published *after* the commit and not
 * before, and why `finalizing` exists at all: the instant the execution stops
 * and the instant the Run is settled are different instants, and only the
 * second one is terminal.
 *
 * The completion `Deferred` is a wake-up and nothing else. `agent_wait` and
 * completion delivery both read their answer from the Result store, because a
 * `Deferred` can be awaited once by each waiter but a late waiter that arrives
 * after it resolves must get the same answer as an early one. Only the store
 * can promise that.
 */

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Ref,
  Scope,
} from "effect";
import type {
  BackendAgent,
  RunInput,
  TerminalBundle,
} from "../backend/contract.ts";
import {
  type AppliedReport,
  createRunProjection,
  type ProjectionBounds,
  type RunDiagnostic,
  type RunIdentity,
  type RunObservation,
  type RunProjection,
  type RunResult,
  reduceRun,
  runDiagnostic,
  settlementEventForEnding,
  toRunResult,
} from "../domain/index.ts";
import {
  type Arbitration,
  arbitrate,
  type SettlementCandidate,
} from "./arbitration.ts";
import type { RuntimeCounters } from "./counters.ts";
import { type ControlMailbox, makeMailbox } from "./mailbox.ts";
import { makeIntake, type ObservationIntake } from "./observation-intake.ts";
import type { ControlBounds } from "./policy.ts";
import type { RunRepository } from "./repository.ts";
import type { ResultStore } from "./result-store.ts";

/** The stages a Run passes through, named so ordering is assertable. */
export const RUN_STAGES = {
  candidateCaptured: "run:candidate-captured",
  intakeSealed: "run:intake-sealed",
  finalizingPublished: "run:finalizing-published",
  executionScopeClosed: "run:execution-scope-closed",
  observationsDrained: "run:observations-drained",
  resultProduced: "run:result-produced",
  runScopeClosed: "run:run-scope-closed",
  resultCommitted: "run:result-committed",
  terminalPublished: "run:terminal-published",
  waitersWoken: "run:waiters-woken",
  deliveryInitiated: "run:delivery-initiated",
} as const;

export type RunStage = (typeof RUN_STAGES)[keyof typeof RUN_STAGES];

/** What the coordinator did with a candidate it was offered. */
export type CaptureOutcome = "captured" | "duplicate";

export interface SettlementCoordinator {
  /**
   * Offer a terminal candidate.
   *
   * The first one is kept. Every later one is counted and changes nothing,
   * which is what "a Run settles exactly once" means when four things can
   * decide it is over at the same moment.
   */
  readonly capture: (
    candidate: SettlementCandidate,
  ) => Effect.Effect<CaptureOutcome>;
  readonly captured: Deferred.Deferred<SettlementCandidate>;
}

export function makeCoordinator(
  counters: RuntimeCounters,
): Effect.Effect<SettlementCoordinator> {
  return Effect.map(
    Deferred.make<SettlementCandidate>(),
    (captured): SettlementCoordinator => ({
      captured,
      capture: (candidate) =>
        Effect.map(Deferred.succeed(captured, candidate), (won) => {
          if (won) return "captured" as const;
          counters.count("duplicateSettlements");
          return "duplicate" as const;
        }),
    }),
  );
}

/** Everything one Run fiber needs, gathered so its signature stays readable. */
export interface RunContext {
  readonly identity: RunIdentity;
  readonly input: RunInput;
  readonly agent: BackendAgent;
  readonly repository: RunRepository["Service"];
  readonly store: ResultStore["Service"];
  readonly counters: RuntimeCounters;
  readonly bounds: ProjectionBounds;
  readonly observationQueueBound: number;
  readonly controlBounds: ControlBounds;
  readonly startedAt: number;
  /** Reads the clock for the settled-at stamp. */
  readonly now: Effect.Effect<number>;
  /** Appended to by every stage, so ordering is assertable. */
  readonly trace: (stage: RunStage) => void;
  /**
   * Close the native execution scope, bounded however the caller bounds it.
   *
   * Returns a diagnostic when the close did not finish inside its budget and
   * the caller escalated past it. Passing this in keeps the settlement order
   * in one place and the cleanup policy in another.
   */
  readonly closeExecutionScope: (
    scope: Scope.Closeable,
  ) => Effect.Effect<RunDiagnostic | undefined>;
  /** Called after the terminal snapshot is published. Delivery hooks in here. */
  readonly onSettled: (result: RunResult) => Effect.Effect<void>;
}

/** What one Run fiber leaves behind for the supervisor and for tests. */
export interface RunHandle {
  readonly identity: RunIdentity;
  readonly coordinator: SettlementCoordinator;
  /** Completed when the Run is terminal. A wake-up, never the value. */
  readonly completion: Deferred.Deferred<void>;
  readonly intake: ObservationIntake;
  readonly mailbox: ControlMailbox;
  /** Interrupted by cancel, timeout, shutdown, and Subagent close. */
  readonly executionFiber: Fiber.Fiber<TerminalBundle, never>;
}

/**
 * The reducer fiber: one per Run, taking from the intake until it is done.
 *
 * It updates the repository after each observation, so the index is never
 * further behind than one observation, and it writes the projection into a
 * `Ref` the settlement path reads. Nothing else writes either.
 */
function reducerLoop(
  context: RunContext,
  intake: ObservationIntake,
  projection: Ref.Ref<RunProjection>,
  reports: AppliedReport[],
  coordinator: SettlementCoordinator,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (;;) {
      const next = yield* Effect.exit(Queue.take(intake.queue));
      if (Exit.isFailure(next)) return;
      const observation = next.value;
      const folded = yield* Ref.modify(projection, (current) => {
        const step = reduceRun(current, observation, context.bounds);
        return [step, step.projection];
      });
      reports.push(folded.report);
      if (folded.report.report === "ignored-late") {
        context.counters.count("lateObservations");
      }
      // The other arrival path. An adapter whose work finished before a cancel
      // reached it announces its snapshot through the intake rather than in a
      // terminal bundle, and a difference that arrived that way is the same
      // fact about the backend.
      if (
        observation.kind === "reconciliation" &&
        reconciliationDiffered(folded.report)
      ) {
        context.counters.count("reconciliationDifferences");
      }
      yield* context.repository.recordProjection(
        context.identity.runId,
        folded.projection,
      );
      // An ending the backend announced is a terminal candidate, and the
      // first candidate wins. It does not end the Run — the execution still
      // has to return — but it is what closed the projection.
      if (
        observation.kind === "ending" &&
        folded.report.report !== "ignored-late"
      ) {
        yield* coordinator.capture({
          source: "in-stream-ending",
          ending: observation.ending,
        });
      }
    }
  });
}

/**
 * Whether a reduced reconciliation actually disagreed with what was streamed.
 *
 * The reducer reports the set of projection fields a snapshot altered, and
 * that set is the whole test. A snapshot the reducer ignored as late carries
 * no set, and one that restated the stream carries an empty one; neither is a
 * difference. Counting arrivals instead — which is what this used to do —
 * makes `reconciliationDifferences` read as a count of answered Runs on a
 * backend that always sends a snapshot.
 */
function reconciliationDiffered(report: AppliedReport): boolean {
  const changed =
    report.report === "applied" || report.report === "applied-with-truncation"
      ? report.changed
      : undefined;
  return (changed?.length ?? 0) > 0;
}

/** What the execution's exit means, before arbitration has a say. */
function candidateOf(
  exit: Exit.Exit<TerminalBundle, never>,
): SettlementCandidate {
  if (Exit.isSuccess(exit)) return { source: "bundle", bundle: exit.value };
  if (Cause.hasInterrupts(exit.cause)) {
    // The reason is a fallback. A cancel that was admitted recorded its own
    // reason, and arbitration prefers that one.
    return { source: "interruption", reason: "requested" };
  }
  return { source: "defect" };
}

export interface SettledRun {
  readonly result: RunResult;
  readonly arbitration: Arbitration;
  readonly projection: RunProjection;
  readonly reports: readonly AppliedReport[];
}

/**
 * Run one Run to settlement, inside the caller's Run Scope.
 *
 * The caller forks this. It returns only once the Run is terminal, its result
 * is committed, and delivery has been asked to run — so a caller that joins
 * this fiber knows the Run is done in every observable sense.
 */
export function runToSettlement(
  context: RunContext,
  onStarted: (handle: RunHandle) => Effect.Effect<void>,
): Effect.Effect<SettledRun, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { counters, identity, repository, store } = context;

    // The Run Scope proper: everything the Run holds while it is running, in
    // a scope settlement can close *before* it commits. Forked from the
    // caller's so that a Run fiber that dies without settling still releases
    // all of it.
    const runScope = yield* Scope.fork(yield* Effect.scope);
    const intake = yield* makeIntake(
      context.observationQueueBound,
      counters,
    ).pipe(Scope.provide(runScope));
    const mailbox = yield* makeMailbox(context.controlBounds, counters).pipe(
      Scope.provide(runScope),
    );
    const coordinator = yield* makeCoordinator(counters);
    const completion = yield* Deferred.make<void>();
    const projection = yield* Ref.make(createRunProjection());
    const reports: AppliedReport[] = [];

    const reducer = yield* Effect.acquireRelease(
      Effect.map(
        Effect.forkChild(
          reducerLoop(context, intake, projection, reports, coordinator),
        ),
        (fiber) => {
          counters.acquired("liveReducerFibers");
          return fiber;
        },
      ),
      (fiber) =>
        Effect.sync(() => {
          counters.released("liveReducerFibers");
          void fiber;
        }),
    ).pipe(Scope.provide(runScope));

    // The native execution scope, nested inside the Run Scope. It can close
    // independently — a provider turn ending is not the Run ending — but it
    // can never outlive the Run.
    const executionScope = yield* Scope.make();
    const executionFiber = yield* Effect.forkChild(
      context.agent
        .execute(context.input, { emit: intake.emit, controls: mailbox.feed })
        .pipe(Scope.provide(executionScope)),
    );

    yield* onStarted({
      identity,
      coordinator,
      completion,
      intake,
      mailbox,
      executionFiber,
    });

    const [exit] = yield* Fiber.awaitAll([executionFiber]);

    /* ---- the settlement path, in the roadmap's order ---- */

    // 1. Capture the candidate.
    yield* coordinator.capture(candidateOf(exit));
    const candidate = yield* Deferred.await(coordinator.captured);
    context.trace(RUN_STAGES.candidateCaptured);

    // 2. Seal intake and close the mailbox. Everything emitted after this is
    //    a late event, and nothing more can be admitted to steer a Run that
    //    has already decided how it ended.
    yield* intake.seal();
    yield* mailbox.close();
    context.trace(RUN_STAGES.intakeSealed);

    // 3. `finalizing`, published before any cleanup runs, so nothing shows a
    //    Run as terminal while its finalizers are still going.
    yield* repository.transition(identity.runId, "execution-ended");
    context.trace(RUN_STAGES.finalizingPublished);

    // 4. Close the native execution scope, bounded by whatever the caller
    //    bounds it by. A close that outlived its budget hands back the
    //    diagnostic saying so, and settlement carries on with what it has —
    //    a hung finalizer must not leave a Run in `finalizing` forever.
    const escalation = yield* context.closeExecutionScope(executionScope);
    context.trace(RUN_STAGES.executionScopeClosed);

    // 5. Drain and reduce every accepted observation. Sealing ended the queue,
    //    so the reducer finishes once it has taken what was already in.
    yield* Fiber.join(reducer);
    context.trace(RUN_STAGES.observationsDrained);

    // 6. Reconciliation, then the ending. Both go through the reducer's own
    //    rules rather than a second implementation of them.
    const snapshot = yield* repository.get(identity.runId);
    const announced = (yield* Ref.get(projection)).ending;
    const decided = arbitrate({
      candidate,
      ...(announced === undefined ? {} : { announced }),
      ...(snapshot?.cancellation === undefined
        ? {}
        : { cancellation: snapshot.cancellation }),
    });
    if (decided.late) counters.count("lateEndings");

    const extra: RunObservation[] = [];
    if (escalation) extra.push({ kind: "diagnostic", diagnostic: escalation });
    if (decided.diagnostic) {
      extra.push({ kind: "diagnostic", diagnostic: decided.diagnostic });
    }
    const reconciliation =
      candidate.source === "bundle"
        ? candidate.bundle.reconciliation
        : undefined;
    if (reconciliation) {
      extra.push({ kind: "reconciliation", reconciliation });
    }
    extra.push({ kind: "ending", ending: decided.ending });

    let folded = yield* Ref.get(projection);
    for (const observation of extra) {
      const step = reduceRun(folded, observation, context.bounds);
      folded = step.projection;
      reports.push(step.report);
      if (
        observation.kind === "reconciliation" &&
        reconciliationDiffered(step.report)
      ) {
        counters.count("reconciliationDifferences");
      }
    }
    yield* Ref.set(projection, folded);
    yield* repository.recordProjection(identity.runId, folded);

    // 7. Produce the bounded candidate result.
    const settledAt = yield* context.now;
    const result = toRunResult({
      identity,
      projection: folded,
      ending: decided.ending,
      startedAt: context.startedAt,
      settledAt,
    });
    context.trace(RUN_STAGES.resultProduced);

    // 8. Close the rest of the Run Scope. The intake queue, the mailbox, and
    //    the reducer fiber's bookkeeping all go here — before the commit, so
    //    a Run that is retrievable is a Run that is holding nothing.
    yield* Scope.close(runScope, Exit.void);
    context.trace(RUN_STAGES.runScopeClosed);

    // 9. Commit, idempotently.
    const committed = yield* store.commit(result);
    if (committed.outcome === "conflict") {
      // Two different results for one Run is a defect in the runtime, not in
      // the backend. The first one stands and the attempt is counted.
      counters.count("duplicateSettlements");
    }
    context.trace(RUN_STAGES.resultCommitted);

    // 10. Publish the terminal snapshot — only now, so a terminal snapshot
    //     implies a retrievable result.
    // The row's settled instant is the Result's own, so the row and the
    // RunCard built from that Result quote one figure.
    yield* repository.transition(
      identity.runId,
      settlementEventForEnding(decided.ending),
      settledAt,
    );
    yield* store.releasePin(identity.runId, "publication");
    context.trace(RUN_STAGES.terminalPublished);

    // 11. Wake anyone waiting. The value they read comes from the store.
    yield* Deferred.succeed(completion, undefined);
    context.trace(RUN_STAGES.waitersWoken);

    // 12. Initiate delivery.
    yield* context.onSettled(committed.result);
    context.trace(RUN_STAGES.deliveryInitiated);

    return {
      result: committed.result,
      arbitration: decided,
      projection: folded,
      reports,
    };
  });
}

/** The diagnostic a Run carries when its own settlement went wrong. */
export function settlementDefect(reason: string): RunDiagnostic {
  return runDiagnostic("other", reason);
}
