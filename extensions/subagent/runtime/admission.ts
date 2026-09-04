/**
 * Admission: the one atomic decision that a Run may begin, and the lease it
 * hands back.
 *
 * The shape is decided by two rules in operation semantics sections 1 and 2,
 * and neither of them is negotiable here:
 *
 * - **Nothing waits.** At capacity the answer is `at capacity`, immediately,
 *   with nothing queued. So capacity is a non-blocking claim rather than a
 *   semaphore, and the roadmap forbids the semaphore explicitly.
 * - **Nothing is allocated by a rejection.** So the whole decision is taken
 *   before an identifier is spent, which is what makes it one step rather
 *   than a sequence a caller could be refused halfway through.
 *
 * **Why a lease rather than a claim and a release.** What one Run holds is two
 * things owned by two different components: a slot in this module's capacity,
 * and room for a result in the Result store. Before this module there were
 * three sites that gave them back — a refused reservation, a failed open, and
 * the Run fiber's exit — and each had to remember which of the two it was
 * holding at that point. That is why the capacity counter was clamped at
 * zero: with three sites nobody could prove a slot was never returned twice,
 * and a negative count would permanently *raise* the effective capacity. A
 * lease knows what it holds and gives all of it back in one call, and a second
 * call does nothing, so there is nothing left for a clamp to defend.
 *
 * **Why `bind` exists.** A resume's Subagent id is known before the acquire,
 * so its one-active-Run claim is taken inside the same atomic step. A start's
 * is not: there is no Subagent until its backend has opened. Binding the lease
 * afterwards is what keeps that late claim inside admission instead of being
 * a `Ref.update` performed by the caller once the id existed.
 *
 * [ADR-0034](../../../docs/adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)
 * is the decision; contributing invariant 12 is the rule this module owns.
 */

import { Effect, Exit, Ref, type Scope } from "effect";
import type { RunId, SubagentId } from "../domain/index.ts";

/**
 * Why a start or resume was refused, in the words the operations report.
 *
 * `already running` is reachable only for a resume, because it is a statement
 * about a Subagent and a start does not have one yet.
 */
export type AdmissionRejection =
  | "shutting down"
  | "already running"
  | "at capacity";

/** What one atomic acquire answers: a lease, or the reason there is none. */
export type AdmissionOutcome =
  | { readonly outcome: "admitted"; readonly lease: AdmissionLease }
  | { readonly outcome: AdmissionRejection };

/**
 * What one admitted Run holds, and the one call that gives it all back.
 *
 * The lease is a **scoped resource**: nobody calls `release` procedurally.
 * {@link RunAdmission.admit} returns it when the admitting Scope closes on a
 * failure, and the Run fiber's own Scope returns it when the Run is over. The
 * two never both fire on one lease, and `release` is idempotent by
 * construction if they ever did.
 */
export interface AdmissionLease {
  /**
   * Take the Subagent's one-active-Run claim, once its id exists.
   *
   * Only a start calls this, and only between a successful open and the fork.
   * A bind after the lease was released would add a Subagent to the running
   * set that nothing will ever remove, which is a permanent refusal of every
   * later resume for that Subagent — so it fails loudly rather than quietly.
   */
  readonly bind: (subagentId: SubagentId) => Effect.Effect<void>;
  /**
   * Take room for the result this Run could produce.
   *
   * A separate step from the capacity claim because it belongs to a different
   * owner, and the compensation is what keeps the pair honest: a refusal
   * releases the whole lease and answers `false`, so the caller reports
   * `at capacity` without compensating anything itself. The one thing that
   * cannot happen is admitting a Run whose result could never be stored.
   */
  readonly reserveResult: (runId: RunId) => Effect.Effect<boolean>;
  /**
   * Give back the capacity slot, the bound Subagent, and any reservation still
   * held. Idempotent by construction.
   */
  readonly release: () => Effect.Effect<void>;
}

/**
 * The two things admission needs from the Result store.
 *
 * Narrower than the store on purpose. Admission needs to know that there is
 * room for a result and how to give that room back; how results are bounded,
 * pinned, evicted, and read is none of its business, and a module that took
 * the whole store would be a module a reader had to check for that.
 */
export interface ResultReservations {
  readonly reserve: (runId: RunId) => Effect.Effect<boolean>;
  readonly release: (runId: RunId) => Effect.Effect<void>;
}

export interface RunAdmission {
  /**
   * One indivisible step: shutting down, already running, at capacity, or a
   * lease. Pass the Subagent id for a resume, and nothing for a start.
   */
  readonly acquire: (
    subagentId?: SubagentId,
  ) => Effect.Effect<AdmissionOutcome>;
  /**
   * {@link acquire}, under the caller's Scope, for callers that admit a Run.
   *
   * The protocol is the supervisor's start and resume, and it has two halves.
   * **A rejection after admission is a failure of the admitted span** — a
   * backend that would not open, a reservation the store refused — so the
   * Scope closes on a failure and everything the lease holds goes back before
   * the rejection reaches the caller. **A span that succeeds has forked a
   * Run**, and from that instant the Run fiber's own Scope holds the lease, so
   * this Scope must not take it back.
   *
   * That is why the release is conditional on the exit rather than
   * unconditional: the two Scopes own the lease at different times, and the
   * hand-over is exactly the moment the admitted span succeeds. Nobody has to
   * remember a compensating call on either path, which is the whole point —
   * before this there were three sites that gave capacity back and each had to
   * know which half of the lease it was holding.
   */
  readonly admit: (
    subagentId?: SubagentId,
  ) => Effect.Effect<AdmissionOutcome, never, Scope.Scope>;
  /** What the pre-check in start, resume, and steer reads. */
  readonly isShuttingDown: () => Effect.Effect<boolean>;
  /** True for the first caller only. The one observable instant. */
  readonly beginShutdown: () => Effect.Effect<boolean>;
}

/**
 * What admission decides, in one value.
 *
 * Held in one reference so that a concurrent pair of starts has exactly one
 * winner: both reach the same `Ref.modify` and the loser reads the winner's
 * claim rather than the value they both started from.
 */
interface AdmissionState {
  readonly shuttingDown: boolean;
  readonly activeRuns: number;
  readonly running: ReadonlySet<SubagentId>;
}

const EMPTY_ADMISSION: AdmissionState = {
  shuttingDown: false,
  activeRuns: 0,
  running: new Set(),
};

export function makeAdmission(
  maxActiveRuns: number,
  reservations: ResultReservations,
): Effect.Effect<RunAdmission> {
  return Effect.map(Ref.make(EMPTY_ADMISSION), (state) => {
    /**
     * One lease, which knows what it took and can only give it back once.
     *
     * `claimed` is the Subagent whose active-Run claim the acquire already
     * took — set for a resume, and set later by `bind` for a start.
     */
    const makeLease = (claimed: SubagentId | undefined): AdmissionLease => {
      let released = false;
      let bound = claimed;
      let reserved: RunId | undefined;

      const release = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (released) return Effect.void;
          released = true;
          const runId = reserved;
          const subagentId = bound;
          return Effect.gen(function* () {
            // The store's room goes back before the capacity slot does. A
            // start waiting for capacity must not find the slot free while
            // this Run's reservation is still taking up room in the store,
            // because it would then be refused by the store instead.
            if (runId !== undefined) yield* reservations.release(runId);
            yield* Ref.update(state, (current) => {
              const running = new Set(current.running);
              if (subagentId !== undefined) running.delete(subagentId);
              return {
                ...current,
                activeRuns: current.activeRuns - 1,
                running,
              };
            });
          });
        });

      return {
        bind: (subagentId) =>
          Effect.suspend(() => {
            if (released) {
              throw new Error(
                `the admission lease for ${subagentId} was released before it was bound`,
              );
            }
            bound = subagentId;
            return Ref.update(state, (current) => ({
              ...current,
              running: new Set(current.running).add(subagentId),
            }));
          }),
        reserveResult: (runId) =>
          Effect.gen(function* () {
            const granted = yield* reservations.reserve(runId);
            if (!granted) {
              yield* release();
              return false;
            }
            reserved = runId;
            return true;
          }),
        release,
      };
    };

    const acquire = (
      subagentId?: SubagentId,
    ): Effect.Effect<AdmissionOutcome> =>
      Ref.modify(state, (current) => {
        if (current.shuttingDown) {
          // Answered first, and before the two conditions that can change,
          // because it is the one that will not.
          return [{ outcome: "shutting down" } as AdmissionOutcome, current];
        }
        if (subagentId !== undefined && current.running.has(subagentId)) {
          return [{ outcome: "already running" }, current];
        }
        if (current.activeRuns >= maxActiveRuns) {
          return [{ outcome: "at capacity" }, current];
        }
        const running = new Set(current.running);
        if (subagentId !== undefined) running.add(subagentId);
        return [
          { outcome: "admitted", lease: makeLease(subagentId) },
          { ...current, activeRuns: current.activeRuns + 1, running },
        ];
      });

    return {
      acquire,
      admit: (subagentId) =>
        Effect.acquireRelease(acquire(subagentId), (admitted, exit) =>
          admitted.outcome === "admitted" && Exit.isFailure(exit)
            ? admitted.lease.release()
            : Effect.void,
        ),
      isShuttingDown: () =>
        Effect.map(Ref.get(state), (current) => current.shuttingDown),
      beginShutdown: () =>
        Ref.modify(state, (current) =>
          current.shuttingDown
            ? [false, current]
            : [true, { ...current, shuttingDown: true }],
        ),
    };
  });
}
