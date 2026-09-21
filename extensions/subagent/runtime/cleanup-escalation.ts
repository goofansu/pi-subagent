/**
 * Cleanup that may outlive the Session's patience, decided in one place.
 *
 * There are two cases. Closing a native execution scope still belongs to its
 * Run, so an overrun produces one diagnostic and one escalation for that Run:
 * count it, close the BackendAgent, and mark the Conversation lost. Closing a
 * BackendAgent after settlement has no Run on which to report a diagnostic,
 * so an overrun is counted alone.
 *
 * Every potentially stuck close runs in a detached fiber. The caller waits on
 * a Deferred instead of timing out the close itself, because interrupting an
 * uninterruptible finalizer and then awaiting that interruption would defeat
 * the budget this module exists to enforce.
 */

import { Clock, Deferred, Effect, Exit, Scope } from "effect";
import type { BackendAgent } from "../backend/contract.ts";
import {
  type RunDiagnostic,
  runDiagnostic,
  type SubagentId,
} from "../domain/index.ts";
import type { RuntimeCounters } from "./counters.ts";
import type { SubagentRecords } from "./subagent-records.ts";

export interface ExecutionScopeClose {
  readonly subagentId: SubagentId;
  readonly agent: BackendAgent;
  readonly scope: Scope.Closeable;
  /** The execution itself already exceeded the same Run's cleanup budget. */
  readonly alreadyOverran?: boolean;
}

/** The two cleanup operations the supervisor sequences. */
export interface CleanupEscalation {
  /** Close native execution cleanup, returning this Run's diagnostic on overrun. */
  readonly closeExecutionScope: (
    close: ExecutionScopeClose,
  ) => Effect.Effect<RunDiagnostic | undefined>;
  /** Close a settled Subagent's BackendAgent, counting an overrun alone. */
  readonly closeBackendAgent: (
    agent: BackendAgent,
    subagentId: SubagentId,
  ) => Effect.Effect<void>;
}

export function makeCleanupEscalation(
  counters: RuntimeCounters,
  clock: Clock.Clock,
  budgetMillis: number,
  records: SubagentRecords,
): CleanupEscalation {
  /**
   * One native execution scope exists per Run, so its weak identity is also
   * the per-Run idempotence record without retaining settled Runs for the rest
   * of a long-lived Session.
   */
  const escalated = new WeakMap<Scope.Closeable, RunDiagnostic>();

  const finishesWithinBudget = (
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
        budgetMillis,
      ).pipe(Effect.provideService(Clock.Clock, clock));
      return withinBudget._tag === "Some" && withinBudget.value;
    });

  const escalate = (
    scope: Scope.Closeable,
    agent: BackendAgent,
    subagentId: SubagentId,
  ): Effect.Effect<RunDiagnostic> =>
    Effect.suspend(() => {
      const previous = escalated.get(scope);
      if (previous !== undefined) return Effect.succeed(previous);

      const diagnostic = runDiagnostic(
        "cleanup-escalation",
        `native cleanup did not finish within ${budgetMillis}ms; the BackendAgent was closed and its conversation is lost`,
      );
      // Record before yielding. Two concurrent overruns for one Run therefore
      // cannot both count or close, even while the winning close is in flight.
      escalated.set(scope, diagnostic);
      counters.count("cleanupEscalations");
      return Effect.as(
        Effect.gen(function* () {
          yield* finishesWithinBudget(agent.close());
          records.markConversationLost(subagentId);
        }),
        diagnostic,
      );
    });

  const closeExecutionScope = ({
    subagentId,
    agent,
    scope,
    alreadyOverran = false,
  }: ExecutionScopeClose): Effect.Effect<RunDiagnostic | undefined> =>
    Effect.suspend(() => {
      const previous = escalated.get(scope);
      if (previous !== undefined) return Effect.succeed(previous);

      const close = Scope.close(scope, Exit.void);
      if (alreadyOverran) {
        // Start native-scope disposal, but do not spend a second budget before
        // escalating an execution already known to have spent the first one.
        return Effect.forkDetach(close).pipe(
          Effect.andThen(escalate(scope, agent, subagentId)),
        );
      }
      return Effect.gen(function* () {
        const closed = yield* finishesWithinBudget(close);
        return closed ? undefined : yield* escalate(scope, agent, subagentId);
      });
    });

  const closeBackendAgent = (
    agent: BackendAgent,
    subagentId: SubagentId,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const record = records.get(subagentId);
      // Normally the Subagent Scope owns the BackendAgent and everything else
      // its adapter acquired, so closing that scope is the complete close. A
      // record may already be gone (or no longer name this agent) during
      // disposal; close the supplied agent directly rather than turning
      // bounded Session cleanup into a defect.
      const close =
        record !== undefined && record.agent === agent
          ? Scope.close(record.scope, Exit.void)
          : agent.close();
      return Effect.gen(function* () {
        const closed = yield* finishesWithinBudget(close);
        if (!closed) counters.count("cleanupEscalations");
      });
    });

  return { closeExecutionScope, closeBackendAgent };
}
