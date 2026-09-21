/**
 * One Run's scope: what it holds, and the order it lets go in.
 *
 * A Run Scope holds a bounded observation intake, one reducer fiber, a
 * cancellation record on the repository row, a completion `Deferred` that is
 * the settlement barrier, and — nested inside it — the native execution scope.
 * The nesting is the ordinary case: a provider turn
 * may end without ending the Run. An execution escalated past the cleanup
 * budget is abandoned, however, and may outlive the Run (ADR-0023, ADR-0025).
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
 * The completion `Deferred` is the settlement barrier, not the Result value.
 * `agent_wait` and completion delivery both read their answer from the Result store, because a
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
  RunControl,
  RunInput,
  TerminalBundle,
} from "../backend/contract.ts";
import {
  type AppliedReport,
  createRunProjection,
  failedEnding,
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
import type { CleanupEscalation } from "./cleanup-escalation.ts";
import type { RuntimeCounters } from "./counters.ts";
import {
  type ControlMailbox,
  type MailboxAdmission,
  makeMailbox,
} from "./mailbox.ts";
import { makeIntake, type ObservationIntake } from "./observation-intake.ts";
import type { ControlBounds } from "./policy.ts";
import type { RunRepository } from "./repository.ts";
import type { ResultStore } from "./result-store.ts";

/** The stages a Run passes through, named so ordering is assertable. */
export const RUN_STAGES = {
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

/** Session-long dependencies shared by every Run in one supervisor. */
export interface RunEnvironment {
  readonly repository: RunRepository["Service"];
  readonly store: ResultStore["Service"];
  readonly counters: RuntimeCounters;
  readonly bounds: ProjectionBounds;
  readonly observationQueueBound: number;
  readonly controlBounds: ControlBounds;
  /** Reads the clock for the settled-at stamp. */
  readonly now: Effect.Effect<number>;
  /** Appended to by every stage, so ordering is assertable. */
  readonly trace: (identity: RunIdentity, stage: RunStage) => void;
  /** The module that owns cleanup-budget decisions and escalation. */
  readonly cleanupEscalation: CleanupEscalation;
  /** How long a cancelled execution may take to leave its fiber. */
  readonly cleanupBudgetMillis: number;
}

/** The facts that name one Run and its settlement hook. */
export interface RunContext {
  readonly identity: RunIdentity;
  readonly input: RunInput;
  readonly agent: BackendAgent;
  readonly startedAt: number;
  /** Called after the terminal snapshot is published. Delivery hooks in here. */
  readonly onSettled: (result: RunResult) => Effect.Effect<void>;
}

/**
 * The execution this Run runs, once the backend has prepared it.
 *
 * It carries no error channel: a backend failure is a `failed` ending, not a
 * failed Effect (ADR-0028).
 */
type RunExecution = Effect.Effect<TerminalBundle, never, Scope.Scope>;

/**
 * The stop request, and the execution fiber it interrupts.
 *
 * A stop can arrive on either side of the fork: before the settlement loop has
 * an execution fiber at all, or after it has one — including after that fiber
 * has already exited, where interrupting is a no-op and the Run settles on the
 * candidate it had already captured. Whichever of the two is second does the
 * interrupting, which is why both halves of that question live here, beside
 * the loop that forks, rather than one of them in a caller.
 */
interface ExecutionStop {
  /** Completed by {@link request}. Settlement bounds its wait from it. */
  readonly requested: Deferred.Deferred<void>;
  /** Take the forked execution, interrupting it if a stop already arrived. */
  readonly hold: (
    fiber: Fiber.Fiber<TerminalBundle, never>,
  ) => Effect.Effect<void>;
  /** Record the stop, and interrupt the execution if it has been forked. */
  readonly request: Effect.Effect<void>;
}

function makeExecutionStop(): Effect.Effect<ExecutionStop> {
  return Effect.map(Deferred.make<void>(), (requested) => {
    let running: Fiber.Fiber<TerminalBundle, never> | undefined;
    return {
      requested,
      hold: (fiber) =>
        Effect.sync(() => {
          running = fiber;
          if (Deferred.isDoneUnsafe(requested)) fiber.interruptUnsafe();
        }),
      request: Effect.gen(function* () {
        yield* Deferred.succeed(requested, undefined);
        running?.interruptUnsafe();
      }),
    };
  });
}

type RecordedDecision = Extract<
  SettlementCandidate,
  { readonly source: "recorded-decision" }
>;

/** The once-only decision slot handed to one execution. */
interface DecisionRecorder {
  readonly record: (bundle: TerminalBundle) => Effect.Effect<void>;
  readonly recorded: () => RecordedDecision | undefined;
}

function makeDecisionRecorder(
  stop: ExecutionStop,
  counters: RuntimeCounters,
): DecisionRecorder {
  let recorded: RecordedDecision | undefined;
  return {
    record: (bundle) =>
      Effect.sync(() => {
        if (recorded !== undefined) {
          counters.count("duplicateDecisions");
          return;
        }
        recorded = {
          source: "recorded-decision",
          bundle,
          beforeStop: !Deferred.isDoneUnsafe(stop.requested),
        };
      }),
    recorded: () => recorded,
  };
}

/** Everything one Run's settlement loop drives, private to this module. */
interface RunResources {
  /** Completed when settlement is done. The barrier carries no Result value. */
  readonly completion: Deferred.Deferred<void>;
  readonly intake: ObservationIntake;
  readonly mailbox: ControlMailbox;
  readonly stop: ExecutionStop;
  readonly decisions: DecisionRecorder;
  /** Everything held for this Run, already nested under its Subagent. */
  readonly runScope: Scope.Closeable;
  /** The native child that settlement closes independently first. */
  readonly executionScope: Scope.Closeable;
  /** Opens settlement only after attachment and active-row publication. */
  readonly activation: Deferred.Deferred<void>;
  readonly execution: RunExecution;
  readonly projection: Ref.Ref<RunProjection>;
  readonly reports: AppliedReport[];
}

/**
 * What one Run fiber leaves behind for the supervisor and for tests.
 *
 * The stop protocol is an operation here rather than the three mechanisms it
 * drives: a caller can start this Run's settlement, open its gate, offer it a
 * Control and stop it, but it cannot close the mailbox without recording the
 * request, or interrupt an execution without closing the mailbox, because
 * there is nothing here to do either half with. What remains published is what
 * other modules read rather than drive — the intake an admission diagnostic
 * enters by, the folded projection an inspection capture reads, and the
 * settlement barrier a waiter awaits.
 */
export interface RunHandle {
  readonly identity: RunIdentity;
  /** Completed when settlement is done. The barrier carries no Result value. */
  readonly completion: Deferred.Deferred<void>;
  readonly intake: ObservationIntake;
  /** What the inspection capture reads, folded, without yielding. */
  readonly projection: Ref.Ref<RunProjection>;
  /** Offer one Control to this Run's bounded mailbox. Never blocks. */
  readonly admitControl: (
    control: RunControl,
  ) => Effect.Effect<MailboxAdmission>;
  /**
   * Stop this Run: close the Control mailbox, record the stop request, and
   * interrupt the execution however far along it is, in that order.
   *
   * Not the Run fiber, which stays alive to settle (ADR-0025). Idempotent, and
   * admitted whether or not an execution exists yet to interrupt.
   */
  readonly stop: Effect.Effect<void>;
  /** Open the activation gate, after attachment and active-row publication. */
  readonly activate: Effect.Effect<void>;
  /**
   * Carry this Run through settlement. The caller forks it, exactly once.
   *
   * It returns only once the Run is terminal, its Result is committed, and
   * delivery has been asked to run. A second fork would run a second
   * settlement over resources the first one has already sealed and closed.
   */
  readonly settle: Effect.Effect<SettledRun>;
}

/**
 * The reducer fiber: one per Run, taking from the intake until it is done.
 *
 * It updates the repository after each observation, so the index is never
 * further behind than one observation, and it writes the projection into a
 * `Ref` the settlement path reads. Nothing else writes either.
 */
function reducerLoop(
  environment: RunEnvironment,
  context: RunContext,
  intake: ObservationIntake,
  projection: Ref.Ref<RunProjection>,
  reports: AppliedReport[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (;;) {
      const next = yield* Effect.exit(Queue.take(intake.queue));
      if (Exit.isFailure(next)) return;
      const observation = next.value;
      const folded = yield* Ref.modify(projection, (current) => {
        const step = reduceRun(current, observation, environment.bounds);
        return [step, step.projection];
      });
      reports.push(folded.report);
      if (folded.report.report === "ignored-late") {
        environment.counters.count("lateObservations");
      }
      if (
        observation.kind === "reconciliation" &&
        reconciliationDiffered(folded.report)
      ) {
        environment.counters.count("reconciliationDifferences");
      }
      yield* environment.repository.recordProjection(
        context.identity.runId,
        folded.projection,
      );
    }
  });
}

/** The confined message of the ending that actually closed the projection. */
function failureDetailOf(projection: RunProjection): string | undefined {
  return projection.ending?.ending === "failed"
    ? projection.ending.message
    : undefined;
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
  if (Exit.isSuccess(exit)) return { source: "execution-return" };
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
 * Build the complete Run handle in the admitting fiber, before publication.
 *
 * Calling `execute` itself happens here, so a backend that throws instead of
 * returning an Effect fails admission rather than stranding a start waiter.
 */
type PrepareExecution<E> = (io: {
  readonly recordDecision: DecisionRecorder["record"];
  readonly emit: ObservationIntake["emit"];
  readonly controls: ControlMailbox["feed"];
}) => Effect.Effect<RunExecution, E>;

function buildRunHandle<E>(
  environment: RunEnvironment,
  context: RunContext,
  prepareExecution: PrepareExecution<E>,
): Effect.Effect<RunHandle, E, Scope.Scope> {
  return Effect.gen(function* () {
    const { counters } = environment;
    const { identity } = context;
    const parent = yield* Effect.scope;
    const runScope = yield* Scope.fork(parent);

    return yield* Effect.gen(function* () {
      const intake = yield* makeIntake(
        environment.observationQueueBound,
        counters,
      ).pipe(Scope.provide(runScope));
      const mailbox = yield* makeMailbox(
        environment.controlBounds,
        counters,
      ).pipe(Scope.provide(runScope));

      const completion = yield* Deferred.make<void>();
      const activation = yield* Deferred.make<void>();
      const projection = yield* Ref.make(createRunProjection());
      const reports: AppliedReport[] = [];
      const stop = yield* makeExecutionStop();
      const decisions = makeDecisionRecorder(stop, counters);

      const executionScope = yield* Scope.fork(runScope);
      const prepared = yield* prepareExecution({
        recordDecision: decisions.record,
        emit: intake.emit,
        controls: mailbox.feed,
      });
      // Returning a bundle is the same decision at the instant of return. If
      // the adapter recorded earlier, this is the counted duplicate and the
      // first bundle remains authoritative.
      const execution = Effect.tap(prepared, decisions.record);

      const resources: RunResources = {
        completion,
        intake,
        mailbox,
        stop,
        decisions,
        runScope,
        executionScope,
        activation,
        execution,
        projection,
        reports,
      };

      return {
        identity,
        completion,
        intake,
        projection,
        admitControl: mailbox.admit,
        stop: Effect.gen(function* () {
          yield* mailbox.close();
          yield* stop.request;
        }),
        activate: Effect.asVoid(Deferred.succeed(activation, undefined)),
        // Suspended, so the settlement loop's own bookkeeping belongs to the
        // fiber that runs it rather than to the fiber that built the handle.
        settle: Effect.suspend(() =>
          runToSettlement(environment, context, resources),
        ),
      };
    }).pipe(Effect.onError(() => Scope.close(runScope, Exit.void)));
  });
}

const synchronousExecuteDiagnostic = (): RunDiagnostic =>
  runDiagnostic("backend-failure", "the backend could not start execution");

/** Build a start's handle, preserving a synchronous execute throw as admission failure. */
export function makeRunHandle(
  environment: RunEnvironment,
  context: RunContext,
): Effect.Effect<RunHandle, RunDiagnostic, Scope.Scope> {
  return buildRunHandle(environment, context, (io) =>
    Effect.try({
      try: () => context.agent.execute(context.input, io),
      catch: synchronousExecuteDiagnostic,
    }),
  );
}

/**
 * Build a resume's handle.
 *
 * Resume has no `backend unavailable` outcome: once its lease is admitted, a
 * backend failure belongs to that new Run. A synchronous contract violation
 * is therefore represented as the execution's defect and settles `failed` by
 * the same arbitration path as an asynchronous backend defect.
 */
export function makeResumedRunHandle(
  environment: RunEnvironment,
  context: RunContext,
): Effect.Effect<RunHandle, never, Scope.Scope> {
  return buildRunHandle(environment, context, (io) =>
    Effect.matchEffect(
      Effect.try({
        try: () => context.agent.execute(context.input, io),
        catch: synchronousExecuteDiagnostic,
      }),
      {
        onFailure: (diagnostic) => {
          const failedExecution: RunExecution = Effect.die(
            new Error(diagnostic.message),
          );
          return Effect.succeed(failedExecution);
        },
        onSuccess: Effect.succeed,
      },
    ),
  );
}

/**
 * Carry an already-published Run through settlement.
 *
 * Reached through the handle's `settle`, which is what the supervisor forks.
 * It returns only once the Run is terminal, its result is committed, and
 * delivery has been asked to run.
 */
function runToSettlement(
  environment: RunEnvironment,
  context: RunContext,
  resources: RunResources,
): Effect.Effect<SettledRun> {
  const { counters, repository, store } = environment;
  const { identity } = context;
  const { completion, executionScope, projection, reports, runScope } =
    resources;
  let committed:
    | {
        readonly result: RunResult;
        readonly ending: Arbitration["ending"];
      }
    | undefined;
  let recovered: SettledRun | undefined;
  let settlementStarted = false;

  const settlement = Effect.gen(function* () {
    const { activation, decisions, execution, intake, mailbox, stop } =
      resources;

    yield* Deferred.await(activation);
    const reducer = yield* Effect.acquireRelease(
      Effect.map(
        Effect.forkIn(
          reducerLoop(environment, context, intake, projection, reports),
          runScope,
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
    // Native execution is detached from every structural Scope. A provider
    // stuck in an uninterruptible stop must not make closing the Run, its
    // Subagent, or the Session await that abandoned fiber. The Run Scope keeps
    // only a non-awaiting interruption finalizer for ordinary structural exit.
    const running = yield* Effect.forkDetach(
      execution.pipe(Scope.provide(executionScope)),
    );
    yield* Scope.addFinalizer(
      runScope,
      Effect.sync(() => running.interruptUnsafe()),
    );
    // A stop already requested is applied to the fiber the instant the stop
    // protocol is given it, so a cancel that arrived before this fork is not
    // waiting on an execution nobody told to stop.
    yield* stop.hold(running);

    // A Run may execute without a time bound. Once cancellation has requested
    // its stop, only the cleanup budget remains. Waiting on `Fiber.await`
    // observes the Exit without joining or supervising the native fiber.
    const stopWon = yield* Effect.raceFirst(
      Effect.as(Fiber.await(running), false),
      Effect.as(Deferred.await(stop.requested), true),
    );
    let executionOverran = false;
    let executionCandidate: SettlementCandidate;
    if (!stopWon) {
      executionCandidate = candidateOf(yield* Fiber.await(running));
    } else {
      running.interruptUnsafe();
      const stopped = yield* Effect.timeoutOption(
        Fiber.await(running),
        environment.cleanupBudgetMillis,
      );
      if (stopped._tag === "Some") {
        executionCandidate = candidateOf(stopped.value);
      } else {
        // Arbitration applies the recorded Cancellation reason from the
        // snapshot it already reads below; this is only the fallback.
        executionCandidate = { source: "interruption", reason: "requested" };
        // Disposal still begins at settlement step 4, after candidate capture,
        // sealing, and finalizing publication. This flag tells that one close
        // not to charge a second execution-wait budget before escalating.
        executionOverran = true;
      }
    }
    settlementStarted = true;

    /* ---- the settlement path, in the roadmap's order ---- */

    const candidate = executionCandidate;

    // 1. Close the mailbox. Nothing more can be admitted to steer a Run that
    //    has already reached settlement.
    yield* mailbox.close();

    // 2. `finalizing`, published before any cleanup runs, so nothing shows a
    //    Run as terminal while its finalizers are still going.
    yield* repository.transition(identity.runId, "execution-ended");
    environment.trace(identity, RUN_STAGES.finalizingPublished);

    // 3. Close the native execution scope. If the execution wait already
    //    overran, disposal starts here but escalation is immediate; otherwise
    //    the module bounds the close. Either way, an uncooperative finalizer
    //    cannot leave a Run in `finalizing` forever.
    const escalation = yield* environment.cleanupEscalation.closeExecutionScope(
      {
        subagentId: identity.subagentId,
        agent: context.agent,
        scope: executionScope,
        ...(executionOverran ? { alreadyOverran: true } : {}),
      },
    );
    environment.trace(identity, RUN_STAGES.executionScopeClosed);

    // 4. Arbitrate once cleanup is done, then put the terminal observations
    //    through the Run's one ordered intake. The core is their only emitter:
    //    sealing stops acceptance before appending reconciliation then ending,
    //    so that ending is the last accepted observation.
    const snapshot = yield* repository.get(identity.runId);
    const decision = decisions.recorded();
    const decided = arbitrate({
      candidate,
      ...(decision === undefined ? {} : { decision }),
      ...(snapshot?.cancellation === undefined
        ? {}
        : { cancellation: snapshot.cancellation }),
    });

    const terminal: RunObservation[] = [];
    if (escalation) {
      terminal.push({ kind: "diagnostic", diagnostic: escalation });
    }
    if (decided.diagnostic) {
      terminal.push({ kind: "diagnostic", diagnostic: decided.diagnostic });
    }
    if (decision?.bundle.reconciliation) {
      terminal.push({
        kind: "reconciliation",
        reconciliation: decision.bundle.reconciliation,
      });
    }
    terminal.push({ kind: "ending", ending: decided.ending });
    yield* intake.sealWith(terminal);
    environment.trace(identity, RUN_STAGES.intakeSealed);

    // 5. Drain and reduce every accepted observation. Sealing ended the queue,
    //    so the reducer finishes once it has taken the terminal ending.
    yield* Fiber.join(reducer);
    environment.trace(identity, RUN_STAGES.observationsDrained);
    const folded = yield* Ref.get(projection);

    // 6. Produce the bounded candidate result.
    const settledAt = yield* environment.now;
    const result = toRunResult({
      identity,
      projection: folded,
      ending: decided.ending,
      startedAt: context.startedAt,
      settledAt,
    });
    environment.trace(identity, RUN_STAGES.resultProduced);

    // 7. Close the rest of the Run Scope. The intake queue, the mailbox, and
    //    the reducer fiber's bookkeeping all go here — before the commit, so
    //    a Run that is retrievable is a Run that is holding nothing.
    yield* Scope.close(runScope, Exit.void);
    environment.trace(identity, RUN_STAGES.runScopeClosed);

    // 8. Commit, idempotently.
    const commit = yield* store.commit(result);
    committed = { result: commit.result, ending: decided.ending };
    environment.trace(identity, RUN_STAGES.resultCommitted);

    // 9. Publish the terminal snapshot — only now, so a terminal snapshot
    //     implies a retrievable result.
    // The row's settled instant is the Result's own, so the row and the
    // RunCard built from that Result quote one figure.
    const settlementEvent = settlementEventForEnding(decided.ending);
    yield* settlementEvent === "settled-failed"
      ? repository.transition(
          identity.runId,
          settlementEvent,
          settledAt,
          failureDetailOf(folded),
        )
      : repository.transition(identity.runId, settlementEvent, settledAt);
    yield* store.releasePin(identity.runId, "publication");
    environment.trace(identity, RUN_STAGES.terminalPublished);

    // 10. Wake anyone waiting. The value they read comes from the store.
    yield* Deferred.succeed(completion, undefined);
    environment.trace(identity, RUN_STAGES.waitersWoken);

    // 11. Initiate delivery.
    yield* context.onSettled(commit.result);
    environment.trace(identity, RUN_STAGES.deliveryInitiated);

    return {
      result: commit.result,
      arbitration: decided,
      projection: folded,
      reports,
    };
  });

  return settlement.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        // Interrupting native execution is the ordinary cancellation candidate
        // above. Once that execution has ended, however, interruption is a
        // settlement failure and must pass through the same terminal guard.
        if (
          Exit.isSuccess(exit) ||
          (Cause.hasInterruptsOnly(exit.cause) && !settlementStarted)
        ) {
          return;
        }

        counters.count("settlementDefects");
        const diagnostic = settlementDefect(
          "Run settlement failed after an internal runtime defect",
        );
        yield* repository.recordSettlementDiagnostic(
          identity.runId,
          diagnostic,
        );

        if (committed !== undefined) {
          // The immutable stored Result remains authoritative. A defect after
          // commit may delay publication, but cannot rewrite that Result or
          // the projection it came from into a different ending.
          const current = yield* Ref.get(projection);
          yield* store.releasePin(identity.runId, "publication");
          yield* context.onSettled(committed.result);
          recovered = {
            result: committed.result,
            arbitration: {
              ending: committed.ending,
              from: "defect",
            },
            projection: current,
            reports,
          };
          return;
        }

        const ending = failedEnding(
          "settlement failed after an internal runtime defect",
        );
        const current = yield* Ref.get(projection);
        const open: RunProjection = { ...current, terminal: false };
        delete (open as { ending?: unknown }).ending;
        const diagnosed = reduceRun(
          open,
          { kind: "diagnostic", diagnostic },
          environment.bounds,
        );
        reports.push(diagnosed.report);
        const ended = reduceRun(
          diagnosed.projection,
          { kind: "ending", ending },
          environment.bounds,
        );
        reports.push(ended.report);
        yield* Ref.set(projection, ended.projection);

        // Recovery still observes the Run Scope ordering before publication.
        // The fallback commit is best-effort, but terminality is not.
        yield* repository.transition(identity.runId, "execution-ended");
        yield* repository.recordProjection(identity.runId, ended.projection);
        yield* Effect.exit(
          environment.cleanupEscalation.closeExecutionScope({
            subagentId: identity.subagentId,
            agent: context.agent,
            scope: executionScope,
          }),
        );
        yield* Effect.exit(Scope.close(runScope, Exit.void));

        const clock = yield* Effect.exit(environment.now);
        const settledAt = Exit.isSuccess(clock)
          ? clock.value
          : context.startedAt;
        const fallback = toRunResult({
          identity,
          projection: ended.projection,
          ending,
          startedAt: context.startedAt,
          settledAt,
        });
        const stored = yield* Effect.exit(store.commit(fallback));
        if (Exit.isSuccess(stored)) {
          committed = { result: stored.value.result, ending };
          yield* store.releasePin(identity.runId, "publication");
        } else {
          // Metadata-only is the same representation an eviction leaves. No
          // encoder bypass and no unencoded Result enter the store.
          yield* store.recordOutputGone(fallback);
        }

        yield* repository.transition(
          identity.runId,
          "settled-failed",
          settledAt,
          failureDetailOf(ended.projection),
        );
        yield* context.onSettled(fallback);
        recovered = {
          result: Exit.isSuccess(stored) ? stored.value.result : fallback,
          arbitration: { ending, from: "defect" },
          projection: ended.projection,
          reports,
        };
      }).pipe(Effect.ensuring(Deferred.succeed(completion, undefined))),
    ),
    // Encoding is the settlement path's typed failure. The guard has already
    // converted it to a terminal outcome; defects still retain their cause
    // after the same recovery work and interruption remains interruption.
    Effect.catch(() =>
      Effect.suspend(() =>
        recovered === undefined
          ? Effect.die(
              new Error("the settlement guard did not construct a recovery"),
            )
          : Effect.succeed(recovered),
      ),
    ),
  );
}

/** The diagnostic a Run carries when its own settlement went wrong. */
export function settlementDefect(reason: string): RunDiagnostic {
  return runDiagnostic("other", reason);
}
