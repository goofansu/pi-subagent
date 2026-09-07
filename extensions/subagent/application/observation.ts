/**
 * One seam for everything a host surface may read about this Session.
 *
 * Four host surfaces watch and question the same Session — the ambient
 * widget, the dashboard's observation source, `/subagent doctor` and the
 * shallow `/subagent` status — and before this module each reached the runtime
 * its own way: one subscribed to the repository, one ran an application query,
 * one asked the supervisor for counters, one did two of the three. The cost
 * was not the extra import. It was that **"coalesce publications into at most
 * one pending refresh" existed twice**, written differently each time — a
 * capacity-1 sliding buffer behind the dashboard and a `renderPending` boolean
 * inside the widget — so the two surfaces could drift apart in how they
 * throttle without anything failing.
 *
 * So this is the whole of what a host *surface* reads, and there is one of
 * each thing in it: follow published Runs, read Subagent and Run summaries,
 * capture one Run's inspection, read the Session's counters and its runtime
 * probe. The Session wiring is the one caller that is not a surface: it reads
 * the Profile catalog of the runtime it has just built, through the
 * composition module that built it, because that is part of building one.
 *
 * It is a **module over the existing services**, not a seventh service: no
 * Layer, nothing Session-long, no state. Every function here is an Effect the
 * host runs against the runtime it already holds, which is what keeps the
 * lifetime question — who owns this subscription, and when does it go — in the
 * caller's Scope where it belongs.
 *
 * The types a host reads *about* what it is handed travel with it: the index
 * and its rows, the counter names and the class each falls into. That is
 * deliberate. A surface that had to reach the repository for the shape of a
 * row, or the counter module for what a counter means, would be a surface
 * reaching past this seam for half of one answer.
 */

import { Clock, Effect, type Scope, Stream } from "effect";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import {
  COUNTER_CLASSES,
  type RuntimeProbe,
  type SupervisorCounter,
  type SupervisorCounters,
} from "../runtime/counters.ts";
import {
  type RunIndex,
  RunRepository,
  type RunSnapshot,
} from "../runtime/repository.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";

export type {
  RunIndex,
  RunSnapshot,
  RuntimeProbe,
  SupervisorCounter,
  SupervisorCounters,
};
export { COUNTER_CLASSES };

/**
 * The runtime services an observation read needs.
 *
 * Named as one type so a host surface can say what its Effect requires without
 * naming a service: a host module that could name `SubagentSupervisor` could
 * call `start`, and then the façade would not be the only way a Run begins.
 */
export type ObservationServices = RunRepository | SubagentSupervisor;

/* ------------------------------------------------------------------ */
/* The coalescing rule                                                  */
/* ------------------------------------------------------------------ */

/**
 * Many publications, at most one pending refresh.
 *
 * The one rule, in one place. A Run publishing activity a thousand times a
 * second must not cost a thousand summary queries or a thousand terminal
 * draws, and the cheapest correct answer is the same in both cases: while a
 * refresh that has been asked for has not happened yet, asking again re-arms
 * nothing, because the refresh that has not happened yet will read the newer
 * value anyway.
 *
 * What "the refresh happened" means belongs to the caller and is the only part
 * that differs: the widget's is a frame Pi drew, the dashboard's is a summary
 * query that returned. Neither surface decides *how much* to coalesce, which
 * is what kept the two implementations from being comparable.
 */
export interface PendingRefresh {
  /** Ask for a refresh, unless one has been asked for and not yet happened. */
  readonly request: () => void;
  /** The refresh that was asked for has happened. */
  readonly done: () => void;
  /** Whether a refresh has been asked for and not yet happened. */
  readonly pending: () => boolean;
}

/**
 * Build the latch over the work one refresh performs.
 *
 * `perform` runs on the transition into pending and nowhere else, so a caller
 * that counts its calls is counting refreshes asked for rather than
 * publications observed — which is the ratio that says whether coalescing is
 * working at all.
 */
export function pendingRefresh(perform: () => void): PendingRefresh {
  let armed = false;
  return {
    request: () => {
      if (armed) return;
      armed = true;
      perform();
    },
    done: () => {
      armed = false;
    },
    pending: () => armed,
  };
}

/* ------------------------------------------------------------------ */
/* Following what the Session publishes                                 */
/* ------------------------------------------------------------------ */

/**
 * Follow this Session's published Runs for the caller's Scope.
 *
 * Every publication is delivered, with the index as it is at that moment —
 * the repository's own promise, and the reason a follower never renders a
 * value that is already stale. Delivery is deliberately *not* where
 * coalescing happens: `observed` is a cheap cache write, and a follower that
 * was handed only the publications it had time for could not count what it
 * missed. Coalescing is {@link pendingRefresh}, over whatever the follower
 * does about what it saw.
 *
 * The subscription is counted by the runtime probe and released when the
 * caller's Scope closes, so a follower that outlives its Session is a leak the
 * probe reports rather than one nobody sees.
 */
export const followPublishedRuns = (
  observed: (index: RunIndex) => void,
): Effect.Effect<void, never, RunRepository | Scope.Scope> =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    const published = yield* repository.subscribe();
    yield* Effect.forkScoped(
      Stream.runForEach(published, (index: RunIndex) =>
        Effect.sync(() => observed(index)),
      ),
    );
  });

/**
 * Follow the Session's Subagent summaries, coalesced.
 *
 * A publication invalidates the summaries rather than carrying them: the
 * summary is a fold over the whole index plus the Subagent records, and
 * folding it once per activity update would be work nobody reads. So a
 * publication arms one refresh, the refresh runs the query, and publications
 * arriving while it runs arm exactly one more.
 *
 * The latch is taken *before* the query rather than after it, which is what
 * makes the newest publication reach the next query instead of being lost
 * behind the one already in flight.
 */
export const followSubagentSummaries = (
  changed: (summaries: readonly SubagentSummary[]) => void,
): Effect.Effect<void, never, ObservationServices | Scope.Scope> =>
  Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    /** Wakes the refresh fiber. Set only while that fiber is waiting. */
    let wake: (() => void) | undefined;
    const refresh = pendingRefresh(() => {
      const waiting = wake;
      wake = undefined;
      waiting?.();
    });
    yield* followPublishedRuns(refresh.request);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          // The pending check happens inside the registration, on the fiber,
          // so a publication landing between "nothing pending" and "waiting"
          // cannot leave this fiber asleep with work to do.
          yield* Effect.callback<void>((resume) => {
            if (refresh.pending()) {
              resume(Effect.void);
              return;
            }
            wake = () => resume(Effect.void);
            return Effect.sync(() => {
              wake = undefined;
            });
          });
          refresh.done();
          changed(yield* supervisor.subagentSummaries());
        }),
      ),
    );
  });

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

/**
 * Every Run this Session has published, terminal ones included.
 *
 * The one-shot form of {@link followPublishedRuns}, for a command that answers
 * once and returns rather than staying to watch.
 */
export const publishedRuns = (): Effect.Effect<
  readonly RunSnapshot[],
  never,
  RunRepository
> => Effect.flatMap(RunRepository, (repository) => repository.list());

/** Every Subagent this Session created, in creation order. */
export const subagentSummaries = (): Effect.Effect<
  readonly SubagentSummary[],
  never,
  SubagentSupervisor
> =>
  Effect.flatMap(SubagentSupervisor, (supervisor) =>
    supervisor.subagentSummaries(),
  );

/** One Subagent's Runs, newest first. */
export const runSummaries = (
  id: SubagentId,
): Effect.Effect<readonly RunSummary[], never, SubagentSupervisor> =>
  Effect.flatMap(SubagentSupervisor, (supervisor) =>
    supervisor.runSummaries(id),
  );

/** Run history rows and the one runtime instant they are rendered against. */
export interface RunHistoryCapture {
  readonly runs: readonly RunSummary[];
  readonly capturedAt: number;
}

/**
 * Capture one Subagent's Run history as a single value.
 *
 * The instant travels with the rows because a history page is frozen at
 * entry: every age it shows is relative to when it was read, and a reader
 * that sampled the clock separately could date the rows from a different
 * moment than the one they were taken at.
 */
export const captureRunHistory = (
  id: SubagentId,
): Effect.Effect<RunHistoryCapture, never, SubagentSupervisor> =>
  Effect.gen(function* () {
    const capturedAt = yield* Clock.currentTimeMillis;
    const runs = yield* runSummaries(id);
    return Object.freeze({ runs, capturedAt });
  });

/**
 * Capture one Run without consuming or pinning its Result.
 *
 * Observation may advance discovery of an unreadable Result, but never
 * consumes one and never changes Completion hand-off state (ADR-0035).
 */
export const inspectRun = (
  id: RunId,
): Effect.Effect<RunInspection, never, SubagentSupervisor> =>
  Effect.flatMap(SubagentSupervisor, (supervisor) => supervisor.inspectRun(id));

/**
 * What the runtime noticed and nobody had to be told about at the time.
 *
 * A reading rather than a view: the runtime hands over a fresh block each
 * time, so what a caller keeps is the numbers as they were when it asked.
 */
export const sessionCounters = (): Effect.Effect<
  SupervisorCounters,
  never,
  SubagentSupervisor
> => Effect.map(SubagentSupervisor, (supervisor) => supervisor.counters());

/** What the runtime is still holding. Zero after the Session Scope closes. */
export const runtimeProbe = (): Effect.Effect<
  RuntimeProbe,
  never,
  SubagentSupervisor
> => Effect.map(SubagentSupervisor, (supervisor) => supervisor.probe());
