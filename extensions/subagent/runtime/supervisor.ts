/**
 * `SubagentSupervisor`: the six public operations, in order.
 *
 * This module sequences a lifecycle; it does not own the state that lifecycle
 * moves through. Three modules do, each carrying one invariant
 * ([ADR-0034](../../../docs/adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)):
 *
 * - [`admission.ts`](admission.ts) — the shutting-down flag, capacity, the
 *   running Subagents, and the Result-store reservation, handed out as a
 *   lease. Invariant 12.
 * - [`subagent-records.ts`](subagent-records.ts) — what is known about each
 *   Subagent, and the only writer of it. Invariant 2.
 * - [`waiters.ts`](waiters.ts) — how many callers registered at a settlement
 *   have yet to read it, and the pin held for them. Invariant 13.
 *
 * What is left here is the order things happen in, and boundary rule 21 keeps
 * it that way: no reference, map, or set is constructed in this file, so a
 * fourth mechanism cannot quietly move in. The `stages` trace array is the
 * documented exception, and it is a test hook nothing reads back.
 *
 * Start is three steps, and the middle one is the only one that talks to a
 * provider:
 *
 * 1. Admission: shutting down, unknown agent, invalid Profile, delegation
 *    depth, then one atomic acquire for global capacity, and the guaranteed
 *    result reservation taken through the lease it yields.
 * 2. Open the BackendAgent inside the new Subagent Scope. A failure here is
 *    `backend unavailable` and the ids stay spent (ADR-0030).
 * 3. Build and attach the Run handle, publish its row, then fork settlement.
 *
 * `start` returns after step 3, so a caller receives either ids for a Run that
 * exists or a typed rejection — never an id for work that never began.
 *
 * **Nothing here releases the lease by hand.** Steps 1 to 3 run under one
 * Scope and a rejection among them is a *failure* of that span, so
 * `admission.admit` gives back the capacity slot and the reservation as the
 * Scope closes; once the fork has happened an explicit hand-over makes the Run
 * fiber's own Scope responsible for returning it after `detachRun`. Phase C1 is
 * where the two procedural `release()` calls went, and the ordering the Phase
 * B review restored is now a consequence of Scope finalizers running
 * last-in-first-out rather than of a comment asking for it.
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
  Layer,
  type Option,
  Scope,
} from "effect";
import type {
  Backend,
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
import {
  type RunLookup,
  RunRepository,
  type RunSnapshot,
} from "./repository.ts";
import { ResultStore } from "./result-store.ts";
import {
  makeResumedRunHandle,
  makeRunHandle,
  type RunContext,
  type RunHandle,
  runToSettlement,
} from "./run-scope.ts";
import {
  type CurrentRun,
  makeSubagentRecords,
  type SubagentRecord,
} from "./subagent-records.ts";
import { makeWaiterLedger } from "./waiters.ts";

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
  /** Returned by the Run fiber's Scope closing, whatever ended the Run. */
  readonly lease: AdmissionLease;
  /** Built and attached before the active row was published. */
  readonly handle: RunHandle;
  readonly context: RunContext;
  /** Absent when the caller's request carried none. */
  readonly diagnostics?: AdmissionDiagnostics;
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

/**
 * What resolving a start request answers.
 *
 * The three rejections a start can earn before it costs anything, or the
 * Profile and backend the request named. Written as the domain's own outcome
 * members rather than a parallel vocabulary, so the resolved rejection is
 * returned to the caller unchanged.
 */
type StartRejection = Extract<
  StartOutcome,
  {
    readonly outcome:
      | "unknown agent"
      | "invalid profile"
      | "delegation-depth exceeded";
  }
>;

type ResolvedStart =
  | {
      readonly outcome: "resolved";
      readonly profile: Profile;
      readonly backend: Backend;
    }
  | StartRejection;

/** The same, for a resume: the four rejections it can earn, or its record. */
type ResumeRejection = Extract<
  ResumeOutcome,
  {
    readonly outcome:
      | "unknown Subagent"
      | "Subagent already running"
      | "resume unsupported"
      | "conversation lost";
  }
>;

type ResolvedResume =
  | { readonly outcome: "resolved"; readonly record: SubagentRecord }
  | ResumeRejection;

type CurrentRunResolution =
  | { readonly state: "current"; readonly current: CurrentRun }
  | Exclude<RunLookup, { readonly state: "active" }>;

/**
 * What one Subagent is opened with: the caller's fixed facts plus its id.
 *
 * A function rather than a literal inside `start` because it depends on
 * nothing else — no catalog, no policy, no clock — and saying so is what
 * makes it obvious that a Subagent's context never changes after this.
 */
function subagentContextFor(
  request: StartRequest,
  subagentId: SubagentId,
): SubagentContext {
  return {
    subagentId,
    cwd: request.cwd,
    childDepth: request.childDepth,
    projectTrusted: request.projectTrusted,
    ...(request.parentModel === undefined
      ? {}
      : { parentModel: request.parentModel }),
  };
}

/**
 * The five facts that name one Run for its whole life.
 *
 * Built here for both start and resume, because they build the same value
 * from the same Profile and there is no reason for adding a field to
 * `RunIdentity` to be a change in two places. The backend id comes from the
 * Profile rather than from the resolved `Backend`, and they are the same
 * value: the catalog keys every backend by its own id, so the backend a
 * Profile resolves to is the one whose id the Profile names.
 */
function runIdentityFor(
  runId: RunId,
  subagentId: SubagentId,
  profile: Profile,
  description: string,
): RunIdentity {
  return {
    runId,
    subagentId,
    backendId: profile.backend,
    agent: profile.name,
    description,
  };
}

/**
 * What a waiter answers about a Run it has seen settle.
 *
 * The status comes from the **store**, so a waiter and `agent_result` cannot
 * disagree about one Run: they read the same value, and a Run whose output was
 * evicted still carries its status in the entry that stayed. The repository's
 * snapshot is the fallback for the moment between publication and a store that
 * has not been asked yet.
 *
 * The Result itself rides on the outcome when the store still holds it
 * ([ADR-0036](../../../docs/adr/0036-a-wait-delivers-the-result-it-waited-for.md)):
 * a wait delivers what it waited for, and reading it here — under the
 * waiters' pin, before the registration is released — is what makes the pin
 * mean what invariant 13 says it means. An evicted output leaves the field
 * absent rather than the outcome different.
 */
function terminalOutcomeOf(
  store: ResultStore["Service"],
  runId: RunId,
  snapshot: RunSnapshot,
): Effect.Effect<WaitOutcome> {
  return Effect.map(store.read(runId), (stored) => {
    const status =
      stored.outcome === "result"
        ? stored.result.status
        : stored.outcome === "ResultExpired"
          ? stored.status
          : (snapshot.terminalStatus ?? "failed");
    // The reason comes from the stored Result where there is one and from
    // the snapshot's recorded request otherwise, so an evicted Run still
    // says why it stopped. A Run that was not cancelled has no reason, and
    // reporting one would be inventing it.
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
      ...(stored.outcome === "result" ? { result: stored.result } : {}),
    } as const;
  });
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
     * The Session Scope and its work child.
     *
     * The work scope is acquired before Shutdown's finalizer is registered,
     * so LIFO finalization runs Shutdown first and only then interrupts any
     * work it did not have to escalate past. Every shorter-lived scope and
     * fiber belongs to this child; the Session Scope itself owns only the two
     * ordered finalizers.
     */
    const sessionScope = yield* Scope.Scope;
    const workScope = yield* Scope.fork(sessionScope);

    /**
     * Admission, with the supervisor's lifetime and no Layer of its own.
     *
     * Constructed here rather than wired as a service because it has exactly
     * this object's lifetime, and ADR-0023's rule is that nothing
     * shorter-lived than the Session is a Layer. The store is passed for its
     * two reservation calls and nothing else.
     */
    const admission = yield* makeAdmission(policy.maxActiveRuns, store);
    /** What this supervisor knows about each Subagent it owns. */
    const records = makeSubagentRecords();
    /**
     * The waiters' ledger, holding the store's `waiters` pin on their behalf.
     *
     * The holder is named here rather than inside the ledger so that all three
     * of the store's named pin holders stay findable from the code that
     * releases them, which is what the freeze asks of them.
     */
    const waiters = makeWaiterLedger(
      { release: (runId) => store.releasePin(runId, "waiters") },
      counters,
    );
    /** Hooks the conformance suite reads instead of the deleted driver's log. */
    const stages: string[] = [];

    const now = Effect.clockWith((clock) => clock.currentTimeMillis);

    /**
     * Run cleanup detached and report whether it finished inside the budget.
     *
     * Timing out a `Scope.close` directly would interrupt the close and wait
     * for that interruption. An uninterruptible finalizer could therefore
     * defeat the timeout. The detached close instead reports through a
     * Deferred; timing out that interruptible await never waits for the close.
     */
    const finishesWithinCleanupBudget = (
      cleanup: Effect.Effect<void>,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const finished = yield* Deferred.make<boolean>();
        yield* Effect.forkDetach(
          Effect.flatMap(Effect.exit(cleanup), (exit) =>
            Deferred.succeed(finished, Exit.isSuccess(exit)),
          ),
        );
        const withinBudget = yield* Effect.timeoutOption(
          Deferred.await(finished),
          policy.cleanupBudgetMillis,
        );
        return withinBudget._tag === "Some" && withinBudget.value;
      });

    /* ------------------------------------------------------------ */
    /* Running a Run                                                 */
    /* ------------------------------------------------------------ */

    const forkRun = ({
      record,
      lease,
      handle,
      context,
      diagnostics: admissionDiagnostics = [],
    }: ForkedRun): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Fork and lease transfer are one uninterruptible hand-over. Once the
        // fiber exists its Scope owns release; interruption of the admitting
        // span after this point must not return capacity out from under it.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Effect.forkIn(
              Effect.gen(function* () {
                // The lease first, so LIFO gives it back after detachment.
                yield* Effect.addFinalizer(() => lease.release());
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    counters.released("liveRunFibers");
                    records.detachRun(record.id);
                  }),
                );
                counters.acquired("liveRunFibers");
                // Admission diagnostics enter the same intake as every other
                // diagnostic, after publication and before activation.
                for (const diagnostic of admissionDiagnostics) {
                  yield* handle.intake.emit({
                    kind: "diagnostic",
                    diagnostic,
                  });
                }
                return yield* runToSettlement(context, handle);
              }).pipe(Effect.scoped),
              workScope,
            );
            yield* lease.handOver();
            // Let active-row subscribers observe publication while settlement
            // is parked on the handle's activation gate. This replaces no
            // ownership handshake: the complete handle is already attached.
            yield* Effect.yieldNow;
            yield* Deferred.succeed(handle.activation, undefined);
          }),
        );
        yield* armDefaultTimeout(handle);
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
        yield* waiters.releaseIfIdle(runId);
        yield* Effect.forkIn(
          Effect.gen(function* () {
            yield* delivery.deliver(runId);
            yield* delivery.sweep();
          }),
          workScope,
        );
      });

    /**
     * Record one cleanup overrun and, while a Run still owns the incident,
     * close its BackendAgent under the same budget and lose its Conversation.
     *
     * This is the single escalation point for a cancelled execution that will
     * not stop, a native execution-scope finalizer that will not finish, and a
     * BackendAgent/Subagent Scope close that overruns after settlement. The
     * last case has no live Run to diagnose or Conversation to resume, so it
     * supplies no agent.
     */
    const escalateCleanup = (details?: {
      readonly agent: SubagentRecord["agent"];
      readonly subagentId: SubagentId;
    }): Effect.Effect<RunDiagnostic> =>
      Effect.gen(function* () {
        counters.count("cleanupEscalations");
        if (details === undefined) {
          return runDiagnostic(
            "cleanup-escalation",
            `BackendAgent cleanup did not finish within ${policy.cleanupBudgetMillis}ms`,
          );
        }
        yield* finishesWithinCleanupBudget(details.agent.close());
        records.markConversationLost(details.subagentId);
        return runDiagnostic(
          "cleanup-escalation",
          `native cleanup did not finish within ${policy.cleanupBudgetMillis}ms; the BackendAgent was closed and its conversation is lost`,
        );
      });

    /** Close the native execution scope, or escalate past its finalizers. */
    const closeUnderCleanupBudget =
      (agent: SubagentRecord["agent"], subagentId: SubagentId) =>
      (scope: Scope.Closeable): Effect.Effect<RunDiagnostic | undefined> =>
        Effect.gen(function* () {
          const closed = yield* finishesWithinCleanupBudget(
            Scope.close(scope, Exit.void),
          );
          return closed
            ? undefined
            : yield* escalateCleanup({ agent, subagentId });
        });

    const runContextFor = ({
      identity,
      prompt,
      agent,
      startedAt,
    }: {
      readonly identity: RunIdentity;
      readonly prompt: string;
      readonly agent: SubagentRecord["agent"];
      readonly startedAt: number;
    }): RunContext => ({
      identity,
      input: {
        runId: identity.runId,
        description: identity.description,
        prompt,
      },
      agent,
      repository,
      store,
      counters,
      bounds: policy.projection,
      observationQueueBound: policy.observationQueueBound,
      controlBounds: policy.controls,
      startedAt,
      now,
      trace: (stage) => stages.push(`${identity.runId}:${stage}`),
      closeExecutionScope: closeUnderCleanupBudget(agent, identity.subagentId),
      cleanupBudgetMillis: policy.cleanupBudgetMillis,
      escalateCleanup: escalateCleanup({
        agent,
        subagentId: identity.subagentId,
      }),
      onSettled: () => settled(identity.runId),
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
    const armDefaultTimeout = (handle: RunHandle): Effect.Effect<void> =>
      Effect.gen(function* () {
        const budget = policy.defaultRunTimeoutMillis;
        if (budget === undefined) return;
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const finished = yield* Effect.exit(
              Effect.timeout(Deferred.await(handle.completion), budget),
            );
            if (Exit.isSuccess(finished)) return;
            yield* cancelOne(handle.identity.runId, "timeout");
          }),
          workScope,
        );
      });

    /* ------------------------------------------------------------ */
    /* start                                                         */
    /* ------------------------------------------------------------ */

    /**
     * Everything a start can be refused for without provider I/O, decided
     * before any of it costs anything.
     *
     * A named step rather than three inline branches because it is the whole
     * of what a start *validates*, as opposed to what a start *does*: no
     * identifier is spent by any answer here, and none of it can change while
     * the rest of the operation runs.
     */
    const resolveStart = (request: StartRequest): ResolvedStart => {
      const profile = profiles.get(request.agent);
      if (!profile) {
        const diagnostics = profiles.diagnosticsFor(request.agent);
        // A Profile that exists but does not work is a different mistake
        // from one that does not exist, and gets a different answer.
        return diagnostics.length > 0
          ? { outcome: "invalid profile", diagnostics }
          : { outcome: "unknown agent", agent: request.agent };
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
        };
      }
      if (request.childDepth > settings.maxDelegationDepth) {
        return {
          outcome: "delegation-depth exceeded",
          depth: request.childDepth,
        };
      }
      return { outcome: "resolved", profile, backend };
    };

    /**
     * The admitted half of a start: everything from the capacity claim to the
     * fork.
     *
     * It runs under a Scope of its own, and a rejection *after* admission is
     * expressed as a **failure** rather than as a returned value. That is not
     * decoration: `admission.admit` releases the lease when this Scope closes
     * on a failure, so a backend that would not open gives back the capacity
     * slot and the result reservation before the rejection reaches the caller,
     * with nobody remembering a compensating call. A span that succeeds has
     * forked the Run, and from that instant the Run fiber's Scope holds the
     * lease.
     */
    const admittedStart = (
      request: StartRequest,
      profile: Profile,
      backend: Backend,
    ): Effect.Effect<
      Extract<StartOutcome, { outcome: "started" }>,
      StartOutcome,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        // No Subagent id yet, so nothing to claim for one: a start's Subagent
        // is bound to the lease after the open, below.
        const acquired = yield* admission.admit();
        if (acquired.outcome !== "admitted") {
          return yield* Effect.fail(
            acquired.outcome === "shutting down"
              ? ({ outcome: "shutting down" } as const)
              : ({ outcome: "at capacity" } as const),
          );
        }
        const { lease } = acquired;

        // Only now are identifiers spent, and they stay spent whatever
        // happens next.
        const subagentId = yield* repository.allocateSubagentId();
        const runId = yield* repository.allocateRunId();

        const reserved = yield* lease.reserveResult(runId);
        if (!reserved) {
          return yield* Effect.fail({ outcome: "at capacity" } as const);
        }

        const context = subagentContextFor(request, subagentId);
        const opened = yield* openSubagent(backend, profile, context);
        if (opened.outcome !== "opened") {
          // Nothing was published, so no Run ever existed; this Scope closing
          // on the failure is what returns everything the lease holds.
          return yield* Effect.fail({
            outcome: "backend unavailable",
            diagnostic: opened.diagnostic,
          } as const);
        }

        // The Subagent's active-Run claim is taken now rather than at
        // admission, because until the open succeeded there was no Subagent.
        yield* lease.bind(subagentId);

        const identity = runIdentityFor(
          runId,
          subagentId,
          profile,
          request.description,
        );
        const startedAt = yield* now;
        const runContext = runContextFor({
          identity,
          prompt: request.prompt,
          agent: opened.agent,
          startedAt,
        });
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const handle = yield* Effect.matchEffect(
              makeRunHandle(runContext).pipe(
                Scope.provide(opened.scope),
                Effect.onError(() => Scope.close(opened.scope, Exit.void)),
              ),
              {
                onFailure: (diagnostic) =>
                  Effect.fail<StartOutcome>({
                    outcome: "backend unavailable",
                    diagnostic,
                  }),
                onSuccess: Effect.succeed,
              },
            );
            const record = records.insert({
              id: subagentId,
              profile,
              context,
              agent: opened.agent,
              scope: opened.scope,
            });
            records.attachRun(record.id, handle);
            yield* repository.publish(identity, startedAt);
            yield* forkRun({
              record,
              lease,
              handle,
              context: runContext,
              diagnostics: request.diagnostics,
            });
          }),
        );

        return { outcome: "started", runId, subagentId } as const;
      });

    const start = (request: StartRequest): Effect.Effect<StartOutcome> =>
      Effect.gen(function* () {
        if (yield* admission.isShuttingDown()) {
          return { outcome: "shutting down" } as const;
        }

        const resolved = resolveStart(request);
        if (resolved.outcome !== "resolved") return resolved;
        const { profile, backend } = resolved;

        // Rejection and success are one union again on the way out: the
        // failure channel exists only so that the Scope closes on a rejection.
        return yield* Effect.catch(
          Effect.scoped(admittedStart(request, profile, backend)),
          (rejection): Effect.Effect<StartOutcome> => Effect.succeed(rejection),
        );
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
        // Forked from the work scope, so Shutdown gets the first chance to
        // cancel and await this Subagent before structural interruption.
        const scope = yield* Scope.fork(workScope);
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

    /**
     * Everything a resume can be refused for without provider I/O.
     *
     * Synchronous throughout, so a rejected resume costs no provider quota and
     * cannot block the caller's turn — which is the reason the two
     * conversation checks live here rather than being discovered at the
     * provider. The core's own view comes first: a cleanup escalation closed
     * this BackendAgent, and the adapter may not have noticed.
     */
    const resolveResume = (request: ResumeRequest): ResolvedResume => {
      const record = records.get(request.subagentId);
      if (!record || record.phase === "closed") {
        return {
          outcome: "unknown Subagent",
          subagentId: request.subagentId,
        };
      }
      if (record.phase === "running") {
        return {
          outcome: "Subagent already running",
          subagentId: request.subagentId,
        };
      }
      if (record.conversationLost && record.agent.capabilities.resume) {
        return { outcome: "conversation lost" };
      }
      const admitted = record.agent.admitResume();
      if (admitted === "unsupported") return { outcome: "resume unsupported" };
      if (admitted === "conversation lost") {
        return { outcome: "conversation lost" };
      }
      return { outcome: "resolved", record };
    };

    /**
     * The admitted half of a resume, under a Scope of its own.
     *
     * The same shape as {@link admittedStart} and for the same reason: a
     * rejection after admission is a failure of the span, so the Scope closing
     * returns everything the lease holds, and a span that succeeds has forked
     * the Run. Resume has one such rejection today and the lease's own
     * `reserveResult` already compensates it — but "already compensates it" is
     * a thing a reader has to check, and the next rejection added here would
     * not have been. Both operations admit the same way so that neither is the
     * one somebody has to remember.
     */
    const admittedResume = (
      request: ResumeRequest,
      record: SubagentRecord,
    ): Effect.Effect<
      Extract<ResumeOutcome, { outcome: "started" }>,
      ResumeOutcome,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        // The Subagent id is known, so its one-active-Run claim is taken in
        // the same atomic step as capacity rather than bound afterwards.
        const acquired = yield* admission.admit(record.id);
        if (acquired.outcome !== "admitted") {
          return yield* Effect.fail(
            acquired.outcome === "already running"
              ? ({
                  outcome: "Subagent already running",
                  subagentId: record.id,
                } as const)
              : ({ outcome: acquired.outcome } as const),
          );
        }
        const { lease } = acquired;

        const runId = yield* repository.allocateRunId();
        const reserved = yield* lease.reserveResult(runId);
        if (!reserved) {
          return yield* Effect.fail({ outcome: "at capacity" } as const);
        }

        const identity = runIdentityFor(
          runId,
          record.id,
          record.profile,
          request.description,
        );
        const startedAt = yield* now;
        const runContext = runContextFor({
          identity,
          prompt: request.prompt,
          agent: record.agent,
          startedAt,
        });
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const handle = yield* makeResumedRunHandle(runContext).pipe(
              Scope.provide(record.scope),
            );
            // Handle attachment and the running phase precede publication:
            // from the first instant the repository can say active, every
            // operation can reach this exact Run through the records module.
            records.markRunning(record.id);
            records.attachRun(record.id, handle);
            yield* repository.publish(identity, startedAt);
            yield* forkRun({
              record,
              lease,
              handle,
              context: runContext,
              diagnostics: request.diagnostics,
            });
          }),
        );

        return { outcome: "started", runId, subagentId: record.id } as const;
      });

    const resume = (request: ResumeRequest): Effect.Effect<ResumeOutcome> =>
      Effect.gen(function* () {
        if (yield* admission.isShuttingDown()) {
          return { outcome: "shutting down" } as const;
        }

        const resolved = resolveResume(request);
        if (resolved.outcome !== "resolved") return resolved;

        // Rejection and success are one union again on the way out: the
        // failure channel exists only so that the Scope closes on a rejection.
        return yield* Effect.catch(
          Effect.scoped(admittedResume(request, resolved.record)),
          (rejection): Effect.Effect<ResumeOutcome> =>
            Effect.succeed(rejection),
        );
      });

    /* ------------------------------------------------------------ */
    /* steer                                                         */
    /* ------------------------------------------------------------ */

    /**
     * Resolve an already-observed active row to its current handle, or to the
     * newer non-active repository fact if settlement won between the reads.
     *
     * Handle attachment precedes active publication, and detachment is a Run
     * fiber finalizer after settlement, so active-without-handle is unreachable
     * in a healthy runtime. The small bound protects every public operation
     * from spinning forever if those independently stored facts are corrupted;
     * after it, the only honest typed answer is unknown Run.
     */
    const CURRENT_RUN_LOOKUP_YIELDS = 8;
    const currentRunAfterActive = (
      runId: RunId,
    ): Effect.Effect<CurrentRunResolution> =>
      Effect.gen(function* () {
        for (
          let attempt = 0;
          attempt < CURRENT_RUN_LOOKUP_YIELDS;
          attempt += 1
        ) {
          const current = records.currentRun(runId);
          if (current !== undefined) return { state: "current", current };
          const latest = yield* repository.lookup(runId);
          if (latest.state !== "active") return latest;
          yield* Effect.yieldNow;
        }
        const latest = yield* repository.lookup(runId);
        return latest.state === "active" ? { state: "unknown" } : latest;
      });

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

        const resolved = yield* currentRunAfterActive(runId);
        if (resolved.state === "unknown" || resolved.state === "spent") {
          return { outcome: "unknown Run", runId } as const;
        }
        if (resolved.state === "terminal") {
          return {
            outcome: alreadyTerminal(
              resolved.snapshot.terminalStatus ?? "failed",
            ),
            runId,
          } as const;
        }
        const { record, handle } = resolved.current;
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
        const resolved = yield* currentRunAfterActive(runId);
        if (resolved.state === "current") {
          const { handle } = resolved.current;
          yield* handle.mailbox.close();
          // Settlement observes this before any interruption request. Polling
          // the execution handle keeps cancellation independent of whether
          // the execution fiber has been forked yet.
          yield* Deferred.succeed(handle.stopRequested, undefined);
          if (Deferred.isDoneUnsafe(handle.executionFiber)) {
            const running = yield* Deferred.await(handle.executionFiber);
            running.interruptUnsafe();
          }
        }
        // The request was recorded before a concurrent terminal publication;
        // it remains admitted even if there is no execution left to interrupt.
        return { outcome: "admitted", runId } as const;
      });

    const cancel = (
      runIds: readonly RunId[],
    ): Effect.Effect<readonly CancelOutcome[]> =>
      Effect.forEach(runIds, (runId) => cancelOne(runId, "requested"));

    /* ------------------------------------------------------------ */
    /* wait                                                          */
    /* ------------------------------------------------------------ */

    const waitOne = (
      runId: RunId,
      timeoutMillis?: number,
    ): Effect.Effect<WaitOutcome> =>
      Effect.suspend(() => {
        // Registration precedes even the terminal lookup. A settlement between
        // these two operations therefore sees a waiter and keeps its pin until
        // this read (or any non-blocking return) releases the registration.
        const registration = waiters.register(runId);
        return Effect.gen(function* () {
          const known = yield* repository.lookup(runId);
          if (known.state === "unknown" || known.state === "spent") {
            return { outcome: "unknown Run", runId } as const;
          }
          if (known.state === "terminal") {
            return yield* terminalOutcomeOf(store, runId, known.snapshot);
          }
          const resolved = yield* currentRunAfterActive(runId);
          if (resolved.state === "unknown" || resolved.state === "spent") {
            return { outcome: "unknown Run", runId } as const;
          }
          if (resolved.state === "terminal") {
            return yield* terminalOutcomeOf(store, runId, resolved.snapshot);
          }
          const { handle } = resolved.current;
          const finished = yield* Effect.exit(
            timeoutMillis === undefined
              ? Deferred.await(handle.completion)
              : Effect.timeout(
                  Deferred.await(handle.completion),
                  timeoutMillis,
                ),
          );
          if (Exit.isFailure(finished)) {
            return { outcome: "still running", runId } as const;
          }
          const settled = yield* repository.lookup(runId);
          return settled.state === "terminal"
            ? yield* terminalOutcomeOf(store, runId, settled.snapshot)
            : ({ outcome: "still running", runId } as const);
        }).pipe(Effect.ensuring(registration.release));
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
        const handle = record.run;
        if (!records.markClosed(record.id)) return;
        if (handle !== undefined) {
          yield* cancelOne(handle.identity.runId, reason);
          // Completion closes over the full settlement, including Run Scope
          // finalizers and terminal publication; no settlement fiber handle is
          // retained or joined by the records module.
          yield* Deferred.await(handle.completion);
        }
        const closed = yield* finishesWithinCleanupBudget(
          Scope.close(record.scope, Exit.void),
        );
        if (!closed) {
          // Unlike execution cleanup escalation, there is no stronger close
          // to try here: this Scope close is already running the BackendAgent
          // finalizer, and the record is permanently closed, so no later
          // resume needs a conversation-loss marker.
          yield* escalateCleanup();
        }
      });

    const shutdown = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        // One observable instant, before any cleanup runs. From here, start,
        // resume, and steer all answer `shutting down`.
        const first = yield* admission.beginShutdown();
        if (!first) return;

        // Subagents are independent. Close them concurrently so N Runs whose
        // cleanup hangs consume one cleanup budget rather than N budgets.
        yield* Effect.forEach(
          [...records.all()].reverse(),
          (record) => closeSubagent(record, "shutdown"),
          { concurrency: "unbounded" },
        );
        // The next Session's model did not start these Runs and has no context
        // in which to act on their answers, so an undelivered notification is
        // dropped rather than queued, the store is cleared, and every local
        // identity is forgotten.
        yield* delivery.stop();
        yield* store.clear();
        records.clear();
        yield* repository.forget();
      });

    // Registered after the work scope was forked, so the Session Scope's LIFO
    // order makes disposal run the same idempotent Shutdown exposed above
    // before it structurally closes the remaining work.
    yield* Scope.addFinalizer(sessionScope, shutdown());

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
          const record = records.get(subagentId);
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
