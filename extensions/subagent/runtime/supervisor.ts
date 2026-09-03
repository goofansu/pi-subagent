/**
 * `SubagentSupervisor`: the six public operations, in order.
 *
 * This module sequences a lifecycle; it does not own the state that lifecycle
 * moves through. Admission — the shutting-down flag, capacity, the running
 * Subagents, and the Result-store reservation — belongs to
 * [`admission.ts`](admission.ts), which hands out a lease
 * ([ADR-0034](../../../docs/adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)).
 *
 * Start is three steps, and the middle one is the only one that talks to a
 * provider:
 *
 * 1. Admission: shutting down, unknown agent, invalid Profile, delegation
 *    depth, then one atomic acquire for global capacity, and the guaranteed
 *    result reservation taken through the lease it yields.
 * 2. Open the BackendAgent inside the new Subagent Scope. A failure here is
 *    `backend unavailable`, the lease releases everything it holds, and the
 *    ids stay spent (ADR-0030).
 * 3. Publish the Run and fork its Run fiber.
 *
 * `start` returns after step 3, so a caller receives either ids for a Run that
 * exists or a typed rejection — never an id for work that never began.
 *
 * The order of those steps is what keeps both admission rules true, and it
 * does not change: **nothing waits**, because at capacity the answer is
 * immediate with nothing queued; and **nothing is allocated by a rejection**,
 * because everything decidable without provider I/O is decided before an
 * identifier is spent or a Subagent Scope is opened.
 */

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  type Option,
  Scope,
} from "effect";
import type {
  Backend,
  BackendAgent,
  BackendOpenFailure,
  RunControl,
} from "../backend/contract.ts";
import {
  alreadyTerminal,
  type CancellationReason,
  type CancelOutcome,
  type ParentModel,
  type Profile,
  type ResultOutcome,
  type ResumeOutcome,
  type RunDiagnostic,
  type RunId,
  type RunIdentity,
  runDiagnostic,
  type StartOutcome,
  type SteerOutcome,
  type SubagentContext,
  type SubagentId,
  type SubagentPhase,
  type WaitOutcome,
} from "../domain/index.ts";
import { type AdmissionLease, makeAdmission } from "./admission.ts";
import { BackendCatalog } from "./backend-catalog.ts";
import type {
  RuntimeCounters,
  RuntimeProbe,
  SupervisorCounters,
} from "./counters.ts";
import { CompletionDelivery } from "./delivery.ts";
import type { RuntimePolicy } from "./policy.ts";
import { ProfileCatalog } from "./profile-catalog.ts";
import { RunRepository, type RunSnapshot } from "./repository.ts";
import { ResultStore } from "./result-store.ts";
import { type RunHandle, runToSettlement } from "./run-scope.ts";

/** What an adapter that died rather than failing says instead. */
const OPEN_FAILED_MESSAGE = "the backend could not be opened";

/** What an open that outlived its budget says. */
export function openBudgetExceededMessage(millis: number): string {
  return `the backend did not open within ${millis}ms`;
}

/**
 * Diagnostics the caller already has about a request it is making.
 *
 * The label bound is applied where tool input becomes a request, which is
 * before any Run exists — so the record half of truncate-and-record has to
 * travel with the request and be emitted onto the Run once there is one.
 * Carried here rather than through a channel of its own, because the Run's
 * observation intake is already where every diagnostic reaches a projection.
 */
type AdmissionDiagnostics = readonly RunDiagnostic[];

/** What `agent_start` is given. The four fixed facts come from the caller. */
export interface StartRequest {
  readonly agent: string;
  /** The Run's label, already bounded by the caller. */
  readonly description: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly childDepth: number;
  readonly projectTrusted: boolean;
  readonly parentModel?: ParentModel;
  readonly diagnostics?: AdmissionDiagnostics;
}

export interface ResumeRequest {
  readonly subagentId: SubagentId;
  /** The Run's label, already bounded by the caller. */
  readonly description: string;
  readonly prompt: string;
  readonly diagnostics?: AdmissionDiagnostics;
}

/** Settings that are not bounds, so they are not the runtime policy. */
export interface SessionSettings {
  readonly policy: RuntimePolicy;
  /** How deeply a Subagent may itself delegate. */
  readonly maxDelegationDepth: number;
  /**
   * The Session's counters and probe.
   *
   * Shared rather than created here, because delivery counts into the same
   * set and a test that read two different snapshots would be reading two
   * different Sessions.
   */
  readonly counters: RuntimeCounters;
}

/** One Subagent: a fixed Profile, a retained BackendAgent, and a scope. */
interface SubagentRecord {
  readonly id: SubagentId;
  readonly profile: Profile;
  readonly context: SubagentContext;
  readonly agent: BackendAgent;
  readonly scope: Scope.Closeable;
  phase: SubagentPhase;
  /**
   * Whether this Subagent's Conversation is gone.
   *
   * Tracked here as well as in the adapter because cleanup escalation is a
   * *core* decision: when a finalizer outlives its budget the core closes the
   * BackendAgent out from under it, and a later resume has to report that
   * honestly rather than discovering it at the provider.
   */
  conversationLost: boolean;
  /** The Run currently in flight, if any. */
  run?: RunHandle;
  /** The fiber settling that Run, so a close can wait for it. */
  runFiber?: Fiber.Fiber<unknown, never>;
}

/**
 * One forked Run's facts, as one value.
 *
 * A parameter object rather than six positions because the fork is where the
 * admission lease, the Subagent record, the published identity, and the
 * caller's own diagnostics meet, and a reader of the call site should be able
 * to see which is which.
 */
interface ForkedRun {
  readonly record: SubagentRecord;
  /** Released when the Run fiber exits, whatever ended it. */
  readonly lease: AdmissionLease;
  readonly identity: RunIdentity;
  readonly prompt: string;
  readonly startedAt: number;
  readonly diagnostics: AdmissionDiagnostics;
}

/**
 * What a failed open tells the caller.
 *
 * Three cases, one outcome. A backend that said why keeps the diagnostic it
 * already redacted; an open that outlived its budget says so, because that is
 * a different thing for a maintainer to see; an adapter that died rather than
 * failing gets the neutral message, because it said nothing that could be
 * carried. No provider text crosses in any of the three.
 */
function openFailure(
  failure: Option.Option<BackendOpenFailure | Cause.TimeoutError>,
  budgetMillis?: number,
): RunDiagnostic {
  if (failure._tag !== "Some") {
    return runDiagnostic("backend-failure", OPEN_FAILED_MESSAGE);
  }
  if (Cause.isTimeoutError(failure.value)) {
    return runDiagnostic(
      "backend-failure",
      openBudgetExceededMessage(budgetMillis ?? 0),
    );
  }
  return failure.value.diagnostic;
}

const makeSupervisor = (settings: SessionSettings) =>
  Effect.gen(function* () {
    const backends = yield* BackendCatalog;
    const profiles = yield* ProfileCatalog;
    const repository = yield* RunRepository;
    const store = yield* ResultStore;
    const delivery = yield* CompletionDelivery;
    const counters = settings.counters;
    const { policy } = settings;
    /**
     * The Session Scope: the layer's own scope, and the parent of every
     * Subagent Scope and every Run fiber.
     *
     * Taking it here is what makes "closing the Session Scope closes every
     * Run, Subagent, and BackendAgent beneath it" a structural fact rather
     * than a shutdown procedure that has to remember them all.
     */
    const sessionScope = yield* Scope.Scope;

    /**
     * Admission, with the supervisor's lifetime and no Layer of its own.
     *
     * Constructed here rather than wired as a service because it has exactly
     * this object's lifetime, and ADR-0023's rule is that nothing
     * shorter-lived than the Session is a Layer. The store is passed for its
     * two reservation calls and nothing else.
     */
    const admission = yield* makeAdmission(policy.maxActiveRuns, store);
    const subagents = new Map<SubagentId, SubagentRecord>();
    /** Hooks the conformance suite reads instead of the deleted driver's log. */
    const stages: string[] = [];

    const now = Effect.clockWith((clock) => clock.currentTimeMillis);

    /* ------------------------------------------------------------ */
    /* Running a Run                                                 */
    /* ------------------------------------------------------------ */

    const forkRun = ({
      record,
      lease,
      identity,
      prompt,
      startedAt,
      diagnostics: admissionDiagnostics,
    }: ForkedRun): Effect.Effect<void> =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        // Forked into the Session Scope, not into the caller's fiber. Every
        // Run is detached from the turn that started it: `Escape` does not
        // stop one, and only the Session ending does.
        const fiber = yield* Effect.forkIn(
          Effect.gen(function* () {
            counters.acquired("liveRunFibers");
            return yield* runToSettlement(
              {
                identity,
                input: {
                  runId: identity.runId,
                  description: identity.description,
                  prompt,
                },
                agent: record.agent,
                repository,
                store,
                counters,
                bounds: policy.projection,
                observationQueueBound: policy.observationQueueBound,
                controlBounds: policy.controls,
                startedAt,
                now,
                trace: (stage) => stages.push(`${identity.runId}:${stage}`),
                closeExecutionScope: closeUnderCleanupBudget(record),
                onSettled: () => settled(identity.runId),
              },
              (handle) =>
                Effect.gen(function* () {
                  record.run = handle;
                  // Emitted through the Run's own intake, before intake can
                  // be sealed, so an admission diagnostic reaches the
                  // projection by the path every other diagnostic takes.
                  for (const diagnostic of admissionDiagnostics) {
                    yield* handle.intake.emit({
                      kind: "diagnostic",
                      diagnostic,
                    });
                  }
                  yield* Deferred.succeed(started, undefined);
                }),
            );
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                counters.released("liveRunFibers");
                record.run = undefined;
                record.phase = record.phase === "closed" ? "closed" : "idle";
                // Last, and this order matters: the Subagent's active-Run
                // claim is what stops a resume being admitted, so releasing
                // it before the record was cleared would let the next Run
                // arrive while this one still looked in flight.
                yield* lease.release();
              }),
            ),
            Scope.provide(record.scope),
          ),
          sessionScope,
        );
        record.runFiber = fiber;
        // Returning only once the Run Scope exists means a caller that has an
        // id can immediately steer, cancel, or wait on it.
        yield* Deferred.await(started);
        yield* armDefaultTimeout(record, identity.runId);
      });

    /**
     * What settlement does once the terminal snapshot is published.
     *
     * Delivery is *initiated*, not awaited: it retries on a clock, and a Run
     * fiber that waited for it would hold its Run Scope open for as long as a
     * failing sink took to give up. The sweep goes with it, so a wake-up this
     * fork somehow misses is recovered by the pass that follows it.
     */
    const settled = (runId: RunId): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* releaseWaiterPinIfIdle(runId);
        yield* Effect.forkIn(
          Effect.gen(function* () {
            yield* delivery.deliver(runId);
            yield* delivery.sweep();
          }),
          sessionScope,
        );
      });

    /**
     * Close the native execution scope, or give up on it and say so.
     *
     * A provider finalizer that never returns is a real thing — a socket that
     * will not close, a child process that ignores its signal — and the one
     * answer that is not acceptable is leaving the Run in `finalizing`
     * forever. So the close is raced against the cleanup budget, and when the
     * budget wins the core takes over: it records a `cleanup-escalation`
     * diagnostic on the Run, closes the BackendAgent itself, marks the
     * Conversation lost so a later resume is honest about it, and settles the
     * Run with the observations it has.
     *
     * Adapter-specific forced termination is M4 to M6 work. The policy and the
     * diagnostic are decided here.
     */
    const closeUnderCleanupBudget =
      (record: SubagentRecord) =>
      (scope: Scope.Closeable): Effect.Effect<RunDiagnostic | undefined> =>
        Effect.gen(function* () {
          const closed = yield* Effect.exit(
            Effect.timeout(
              Scope.close(scope, Exit.void),
              policy.cleanupBudgetMillis,
            ),
          );
          if (Exit.isSuccess(closed)) return undefined;
          counters.count("cleanupEscalations");
          yield* record.agent.close();
          record.conversationLost = true;
          return runDiagnostic(
            "cleanup-escalation",
            `native cleanup did not finish within ${policy.cleanupBudgetMillis}ms; the BackendAgent was closed and its conversation is lost`,
          );
        });

    /**
     * The optional default timeout, as a cancellation rather than a second way
     * for a Run to end.
     *
     * Waiting on the Run's own completion and cancelling if it has not arrived
     * means a timeout goes through exactly the path a user's cancel goes
     * through, and arrives at `cancelled` with reason `timeout`. A Run that
     * finishes first resolves the wait and this fiber does nothing.
     */
    const armDefaultTimeout = (
      record: SubagentRecord,
      runId: RunId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const budget = policy.defaultRunTimeoutMillis;
        const handle = record.run;
        if (budget === undefined || handle === undefined) return;
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const finished = yield* Effect.exit(
              Effect.timeout(Deferred.await(handle.completion), budget),
            );
            if (Exit.isSuccess(finished)) return;
            yield* cancelOne(runId, "timeout");
          }),
          record.scope,
        );
      });

    /* ------------------------------------------------------------ */
    /* start                                                         */
    /* ------------------------------------------------------------ */

    const start = (request: StartRequest): Effect.Effect<StartOutcome> =>
      Effect.gen(function* () {
        if (yield* admission.isShuttingDown()) {
          return { outcome: "shutting down" } as const;
        }

        const profile = profiles.get(request.agent);
        if (!profile) {
          const diagnostics = profiles.diagnosticsFor(request.agent);
          // A Profile that exists but does not work is a different mistake
          // from one that does not exist, and gets a different answer.
          return diagnostics.length > 0
            ? ({ outcome: "invalid profile", diagnostics } as const)
            : ({ outcome: "unknown agent", agent: request.agent } as const);
        }
        const backend = backends.get(profile.backend);
        if (!backend) {
          return {
            outcome: "invalid profile",
            diagnostics: [
              {
                filePath: profile.name,
                reason: `unknown backend '${profile.backend}'`,
              },
            ],
          } as const;
        }
        if (request.childDepth > settings.maxDelegationDepth) {
          return {
            outcome: "delegation-depth exceeded",
            depth: request.childDepth,
          } as const;
        }

        // No Subagent id yet, so nothing to claim for one: a start's Subagent
        // is bound to the lease after the open, below.
        const acquired = yield* admission.acquire();
        if (acquired.outcome !== "admitted") {
          return acquired.outcome === "shutting down"
            ? ({ outcome: "shutting down" } as const)
            : ({ outcome: "at capacity" } as const);
        }
        const { lease } = acquired;

        // Only now are identifiers spent, and they stay spent whatever
        // happens next.
        const subagentId = yield* repository.allocateSubagentId();
        const runId = yield* repository.allocateRunId();

        // A refusal has already released the lease, so there is nothing to
        // compensate here.
        const reserved = yield* lease.reserveResult(runId);
        if (!reserved) return { outcome: "at capacity" } as const;

        const context: SubagentContext = {
          subagentId,
          cwd: request.cwd,
          childDepth: request.childDepth,
          projectTrusted: request.projectTrusted,
          ...(request.parentModel === undefined
            ? {}
            : { parentModel: request.parentModel }),
        };

        const opened = yield* openSubagent(backend, profile, context);
        if (opened.outcome !== "opened") {
          // Everything the lease holds is released before the rejection
          // returns, and nothing was published, so no Run ever existed.
          yield* lease.release();
          return {
            outcome: "backend unavailable",
            diagnostic: opened.diagnostic,
          } as const;
        }

        const record: SubagentRecord = {
          id: subagentId,
          profile,
          context,
          agent: opened.agent,
          scope: opened.scope,
          phase: "running",
          conversationLost: false,
        };
        subagents.set(subagentId, record);

        const identity: RunIdentity = {
          runId,
          subagentId,
          backendId: backend.id,
          agent: profile.name,
          description: request.description,
        };
        // The Subagent's active-Run claim is taken now rather than at
        // admission, because until the open succeeded there was no Subagent.
        yield* lease.bind(subagentId);

        const startedAt = yield* now;
        yield* repository.publish(identity, startedAt);
        yield* forkRun({
          record,
          lease,
          identity,
          prompt: request.prompt,
          startedAt,
          diagnostics: request.diagnostics ?? [],
        });

        return { outcome: "started", runId, subagentId } as const;
      });

    /**
     * Open a BackendAgent into its own Subagent Scope, under the open budget.
     *
     * The scope is created here rather than by the caller so that a failed
     * open has exactly one thing to close, and so that anything the adapter
     * acquired before it failed is released by closing it.
     */
    const openSubagent = (
      backend: Backend,
      profile: Profile,
      context: SubagentContext,
    ) =>
      Effect.gen(function* () {
        // Forked from the Session Scope, so closing the Session closes every
        // Subagent beneath it in reverse acquisition order.
        const scope = yield* Scope.fork(sessionScope);
        const attempt = yield* Effect.exit(
          backend
            .open(profile, context)
            .pipe(
              Scope.provide(scope),
              Effect.timeout(policy.openBudgetMillis),
            ),
        );
        if (Exit.isSuccess(attempt)) {
          counters.acquired("openBackendAgents");
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => counters.released("openBackendAgents")),
          );
          return { outcome: "opened" as const, agent: attempt.value, scope };
        }
        yield* Scope.close(scope, Exit.void);
        const failure: Option.Option<BackendOpenFailure | Cause.TimeoutError> =
          Cause.findErrorOption(attempt.cause);
        return {
          outcome: "failed" as const,
          diagnostic: openFailure(failure, policy.openBudgetMillis),
        };
      });

    /* ------------------------------------------------------------ */
    /* resume                                                        */
    /* ------------------------------------------------------------ */

    const resume = (request: ResumeRequest): Effect.Effect<ResumeOutcome> =>
      Effect.gen(function* () {
        if (yield* admission.isShuttingDown()) {
          return { outcome: "shutting down" } as const;
        }

        const record = subagents.get(request.subagentId);
        if (!record || record.phase === "closed") {
          return {
            outcome: "unknown Subagent",
            subagentId: request.subagentId,
          } as const;
        }
        if (record.phase === "running") {
          return {
            outcome: "Subagent already running",
            subagentId: request.subagentId,
          } as const;
        }

        // Synchronous and free of provider I/O, so a rejected resume costs no
        // provider quota and cannot block the caller's turn. The core's own
        // view comes first: a cleanup escalation closed this BackendAgent, and
        // the adapter may not have noticed.
        if (record.conversationLost && record.agent.capabilities.resume) {
          return { outcome: "conversation lost" } as const;
        }
        const admitted = record.agent.admitResume();
        if (admitted === "unsupported") {
          return { outcome: "resume unsupported" } as const;
        }
        if (admitted === "conversation lost") {
          return { outcome: "conversation lost" } as const;
        }

        // The Subagent id is known, so its one-active-Run claim is taken in
        // the same atomic step as capacity rather than bound afterwards.
        const acquired = yield* admission.acquire(record.id);
        if (acquired.outcome !== "admitted") {
          return acquired.outcome === "already running"
            ? ({
                outcome: "Subagent already running",
                subagentId: record.id,
              } as const)
            : ({ outcome: acquired.outcome } as const);
        }
        const { lease } = acquired;

        const runId = yield* repository.allocateRunId();
        const reserved = yield* lease.reserveResult(runId);
        if (!reserved) return { outcome: "at capacity" } as const;

        record.phase = "running";
        const identity: RunIdentity = {
          runId,
          subagentId: record.id,
          backendId: record.profile.backend,
          agent: record.profile.name,
          description: request.description,
        };
        const startedAt = yield* now;
        yield* repository.publish(identity, startedAt);
        yield* forkRun({
          record,
          lease,
          identity,
          prompt: request.prompt,
          startedAt,
          diagnostics: request.diagnostics ?? [],
        });

        return { outcome: "started", runId, subagentId: record.id } as const;
      });

    /* ------------------------------------------------------------ */
    /* steer                                                         */
    /* ------------------------------------------------------------ */

    /** The Subagent whose Run this is, if that Run is in flight right now. */
    const recordOf = (runId: RunId): SubagentRecord | undefined => {
      for (const record of subagents.values()) {
        if (record.run?.identity.runId === runId) return record;
      }
      return undefined;
    };

    /** Its Run Scope, which exists for exactly as long as the Run does. */
    const handleOf = (runId: RunId): RunHandle | undefined =>
      recordOf(runId)?.run;

    const steer = (
      runId: RunId,
      control: RunControl,
    ): Effect.Effect<SteerOutcome> =>
      Effect.gen(function* () {
        if (yield* admission.isShuttingDown()) {
          return { outcome: "shutting down" } as const;
        }

        const known = yield* repository.lookup(runId);
        if (known.state === "unknown" || known.state === "spent") {
          return { outcome: "unknown Run", runId } as const;
        }
        if (known.state === "terminal") {
          return {
            outcome: alreadyTerminal(known.snapshot.terminalStatus ?? "failed"),
            runId,
          } as const;
        }

        const record = recordOf(runId);
        const handle = record?.run;
        if (!record || !handle) {
          // Active in the index but with no live Run Scope: it is settling.
          return { outcome: "mailbox closed", runId } as const;
        }
        // A backend that declared no steering is never called about a Control
        // at all, which is what makes `unsupported` free of provider I/O.
        if (!record.agent.capabilities.steer) {
          return { outcome: "unsupported", runId } as const;
        }

        const admitted = yield* handle.mailbox.admit(control);
        return admitted === "invalid"
          ? ({
              outcome: "invalid",
              reason:
                "a Control must be non-empty text within the per-message byte bound",
            } as const)
          : ({ outcome: admitted, runId } as const);
      });

    /* ------------------------------------------------------------ */
    /* cancel                                                        */
    /* ------------------------------------------------------------ */

    /**
     * Record the request, close the mailbox, and interrupt the execution.
     *
     * The Run fiber is deliberately *not* interrupted: it stays alive to
     * settle, because a cancelled Run still produces one immutable result with
     * whatever partial output it had (ADR-0025). Cancelling also does not
     * close the Subagent — it returns to idle and stays resumable.
     */
    const cancelOne = (
      runId: RunId,
      reason: CancellationReason,
    ): Effect.Effect<CancelOutcome> =>
      Effect.gen(function* () {
        const recorded = yield* repository.recordCancellation(runId, reason);
        if (recorded.outcome === "unknown Run") {
          return { outcome: "unknown Run", runId } as const;
        }
        if (recorded.outcome === "already terminal") {
          return { outcome: alreadyTerminal(recorded.status), runId } as const;
        }
        if (recorded.outcome === "unchanged") {
          // Idempotent: it changes nothing, does not re-forward, and does not
          // turn an admitted request into an error.
          return { outcome: "idempotent", runId } as const;
        }
        const handle = handleOf(runId);
        if (handle) {
          yield* handle.mailbox.close();
          yield* Fiber.interrupt(handle.executionFiber);
        }
        return { outcome: "admitted", runId } as const;
      });

    const cancel = (
      runIds: readonly RunId[],
    ): Effect.Effect<readonly CancelOutcome[]> =>
      Effect.forEach(runIds, (runId) => cancelOne(runId, "requested"));

    /* ------------------------------------------------------------ */
    /* wait                                                          */
    /* ------------------------------------------------------------ */

    /** How many waiters registered at settlement have yet to read. */
    const waiters = new Map<RunId, number>();

    /**
     * Let go of the waiters' pin once nobody is holding it.
     *
     * Settlement calls this too, so a Run nobody waited on releases its pin
     * immediately rather than holding a result open for a reader who never
     * arrives.
     */
    const releaseWaiterPinIfIdle = (runId: RunId): Effect.Effect<void> =>
      Effect.suspend(() =>
        (waiters.get(runId) ?? 0) > 0
          ? Effect.void
          : store.releasePin(runId, "waiters"),
      );

    /**
     * What a waiter answers about a Run it has seen settle.
     *
     * The status comes from the **store**, so a waiter and `agent_result`
     * cannot disagree about one Run: they read the same value, and a Run whose
     * output was evicted still carries its status in the entry that stayed.
     * The repository's snapshot is the fallback for the moment between
     * publication and a store that has not been asked yet.
     */
    const terminalStatusOf = (
      runId: RunId,
      snapshot: RunSnapshot,
    ): Effect.Effect<WaitOutcome> =>
      Effect.map(store.read(runId), (stored) => {
        const status =
          stored.outcome === "result"
            ? stored.result.status
            : stored.outcome === "ResultExpired"
              ? stored.status
              : (snapshot.terminalStatus ?? "failed");
        // The reason comes from the stored Result where there is one and from
        // the snapshot's recorded request otherwise, so an evicted Run still
        // says why it stopped. A Run that was not cancelled has no reason,
        // and reporting one would be inventing it.
        const reason =
          stored.outcome === "result"
            ? stored.result.cancellationReason
            : snapshot.cancellation?.reason;
        return {
          outcome: "terminal",
          runId,
          status,
          ...(status === "cancelled" && reason !== undefined
            ? { cancellationReason: reason }
            : {}),
        } as const;
      });

    const waitOne = (
      runId: RunId,
      timeoutMillis?: number,
    ): Effect.Effect<WaitOutcome> =>
      Effect.gen(function* () {
        const known = yield* repository.lookup(runId);
        if (known.state === "unknown" || known.state === "spent") {
          return { outcome: "unknown Run", runId } as const;
        }
        if (known.state === "terminal") {
          return yield* terminalStatusOf(runId, known.snapshot);
        }
        const handle = handleOf(runId);
        if (!handle) return { outcome: "still running", runId } as const;

        waiters.set(runId, (waiters.get(runId) ?? 0) + 1);
        counters.acquired("unresolvedWaiters");
        const finished = yield* Effect.exit(
          timeoutMillis === undefined
            ? Deferred.await(handle.completion)
            : Effect.timeout(Deferred.await(handle.completion), timeoutMillis),
        ).pipe(
          // Aborting or timing out a wait stops only that waiter. The Run
          // continues, still settles exactly once, and still stores its
          // result — so the bookkeeping has to be released either way.
          Effect.ensuring(
            Effect.suspend(() => {
              counters.released("unresolvedWaiters");
              const left = (waiters.get(runId) ?? 1) - 1;
              if (left <= 0) waiters.delete(runId);
              else waiters.set(runId, left);
              return releaseWaiterPinIfIdle(runId);
            }),
          ),
        );

        if (Exit.isFailure(finished)) {
          return { outcome: "still running", runId } as const;
        }
        const settled = yield* repository.lookup(runId);
        return settled.state === "terminal"
          ? yield* terminalStatusOf(runId, settled.snapshot)
          : ({ outcome: "still running", runId } as const);
      });

    const wait = (
      runIds: readonly RunId[],
      timeoutMillis?: number,
    ): Effect.Effect<readonly WaitOutcome[]> =>
      Effect.forEach(
        runIds,
        (runId) =>
          timeoutMillis === undefined
            ? waitOne(runId)
            : waitOne(runId, timeoutMillis),
        { concurrency: "unbounded" },
      );

    /* ------------------------------------------------------------ */
    /* Subagent close and shutdown                                   */
    /* ------------------------------------------------------------ */

    /**
     * Cancel-and-await-cleanup, in the order operation semantics section 4
     * fixes it.
     *
     * The Subagent is marked closed *first*, so from that instant it admits no
     * new Run and no late settlement can move it back to idle.
     */
    const closeSubagent = (
      record: SubagentRecord,
      reason: CancellationReason,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (record.phase === "closed") return;
        record.phase = "closed";
        const runId = record.run?.identity.runId;
        if (runId !== undefined) yield* cancelOne(runId, reason);
        const fiber = record.runFiber;
        // Wait for the Run Scope's finalizers and the BackendAgent's native
        // cleanup to finish before the Subagent Scope closes them.
        if (fiber) yield* Effect.ignore(Fiber.join(fiber));
        yield* Scope.close(record.scope, Exit.void);
      });

    const shutdown = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        // One observable instant, before any cleanup runs. From here, start,
        // resume, and steer all answer `shutting down`.
        const first = yield* admission.beginShutdown();
        if (!first) return;

        // Reverse acquisition order: the newest Subagent closes first, which
        // is what closing the Session Scope would do on its own.
        for (const record of [...subagents.values()].reverse()) {
          yield* closeSubagent(record, "shutdown");
        }
        // The next Session's model did not start these Runs and has no context
        // in which to act on their answers, so an undelivered notification is
        // dropped rather than queued, the store is cleared, and every local
        // identity is forgotten.
        yield* delivery.stop();
        yield* store.clear();
        subagents.clear();
        yield* repository.forget();
      });

    /* ------------------------------------------------------------ */
    /* result                                                        */
    /* ------------------------------------------------------------ */

    const result = (runId: RunId): Effect.Effect<ResultOutcome> =>
      Effect.gen(function* () {
        const known = yield* repository.lookup(runId);
        // A spent id and an id nothing ever had get one answer, because
        // operation semantics gives them one: no Run in this Session has ever
        // had it. The repository keeps them apart for a maintainer's benefit.
        if (known.state === "unknown" || known.state === "spent") {
          return { outcome: "unknown Run", runId } as const;
        }
        if (known.state === "active") {
          return { outcome: "RunNotTerminal", runId } as const;
        }
        const stored = yield* store.read(runId);
        if (stored.outcome === "result") {
          return { outcome: "result", result: stored.result } as const;
        }
        if (stored.outcome === "ResultExpired") return stored;
        // A terminal Run whose entry is missing or unreadable. The output is
        // gone either way, and `ResultExpired` is the only outcome the union
        // has for that — so the counter is what tells a maintainer this was a
        // defect rather than eviction doing its job.
        counters.count("unreadableResults");
        return {
          outcome: "ResultExpired",
          runId,
          subagentId: known.snapshot.identity.subagentId,
          status: known.snapshot.terminalStatus ?? "failed",
        } as const;
      });

    return {
      start,
      resume,
      steer,
      cancel,
      wait,
      result,
      shutdown,
      /** Not a public tool. Shutdown uses it, and so does one race test. */
      closeSubagentById: (subagentId: SubagentId): Effect.Effect<void> =>
        Effect.suspend(() => {
          const record = subagents.get(subagentId);
          return record ? closeSubagent(record, "shutdown") : Effect.void;
        }),
      /** Every Run stage, in order, for ordering assertions. */
      stages: (): readonly string[] => [...stages],
      counters: (): SupervisorCounters => counters.counters(),
      probe: (): RuntimeProbe => counters.probe(),
    };
  });

export type SubagentSupervisorApi = Effect.Success<
  ReturnType<typeof makeSupervisor>
>;

export class SubagentSupervisor extends Context.Service<
  SubagentSupervisor,
  SubagentSupervisorApi
>()("pi-subagent/runtime/SubagentSupervisor") {
  static layerOf(
    settings: SessionSettings,
  ): Layer.Layer<
    SubagentSupervisor,
    never,
    | BackendCatalog
    | ProfileCatalog
    | RunRepository
    | ResultStore
    | CompletionDelivery
  > {
    return Layer.effect(
      SubagentSupervisor,
      Effect.map(makeSupervisor(settings), (api) => SubagentSupervisor.of(api)),
    );
  }
}
