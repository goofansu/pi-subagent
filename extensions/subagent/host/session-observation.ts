/**
 * The dashboard's read-only view of one Session.
 *
 * This is the whole capability the dashboard receives. Runtime publications
 * are implementation details of summary watching, and Effect execution stays
 * behind this boundary rather than being handed to the controller.
 */
import { Clock, Effect, Stream } from "effect";
import {
  inspectRun as inspectRunQuery,
  runSummaries,
  subagentSummaries,
} from "../application/history.ts";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import type { SessionServices } from "../runtime/composition.ts";
import { RunRepository } from "../runtime/repository.ts";

export type { RunSummary, SubagentSummary } from "../domain/history.ts";
export type { RunId, SubagentId } from "../domain/index.ts";

/** History rows and the one runtime instant against which they are rendered. */
export interface RunHistoryCapture {
  readonly runs: readonly RunSummary[];
  readonly capturedAt: number;
}

/** A read-only dashboard capability bound to exactly one Session. */
export interface SessionObservation {
  /**
   * Follow current Subagent summaries. Publications are invalidations, not
   * values to replay. Returns an unsubscribe for this callback.
   */
  readonly watchSummaries: (
    changed: (summaries: readonly SubagentSummary[]) => void,
    failed: () => void,
  ) => () => void;
  /** Capture entry-only Run history and its runtime instant as one value. */
  readonly captureHistory: (
    subagentId: SubagentId,
  ) => Promise<RunHistoryCapture | undefined>;
  /** Capture one Run without consuming or pinning its Result. */
  readonly inspectRun: (runId: RunId) => Promise<RunInspection | undefined>;
  /**
   * Synchronously sample the Session instant for existing overview
   * publication/navigation behavior. This is a plain read, not a Clock
   * service or an Effect runner.
   */
  readonly currentInstant: () => number;
  /** Abort reads and release every callback owned by this observation. */
  readonly dispose: () => void;
}

/** The only part of the process-level handle the dashboard can name. */
export interface SessionObservationSource {
  readonly observe: (onRelease: () => void) => SessionObservation | undefined;
}

interface ObservationLease {
  readonly run: <A>(
    work: Effect.Effect<A, never, SessionServices>,
    whenNotReady: A,
  ) => Promise<A>;
  readonly currentInstant: () => number;
  readonly dispose: () => void;
}

/** Build the narrow capability over the handle's existing Session lease. */
export function createSessionObservation(
  lease: ObservationLease,
): SessionObservation {
  let disposed = false;
  const watchers = new Set<() => void>();

  const watchSummaries: SessionObservation["watchSummaries"] = (
    changed,
    failed,
  ) => {
    if (disposed) return () => {};
    let watching = true;
    const controller = new AbortController();
    const unsubscribe = () => {
      if (!watching) return;
      watching = false;
      controller.abort();
      watchers.delete(unsubscribe);
    };
    watchers.add(unsubscribe);

    void lease
      .run(
        Effect.scoped(
          Effect.gen(function* () {
            const repository = yield* RunRepository;
            const changes = yield* repository.subscribe();
            // Publications only invalidate the higher-level query. Sliding
            // buffering retains one pending refresh while a query is running.
            const invalidations = changes.pipe(
              Stream.map(() => undefined),
              Stream.buffer({ capacity: 1, strategy: "sliding" }),
            );
            yield* Effect.forkScoped(
              Stream.runForEach(invalidations, () =>
                Effect.gen(function* () {
                  const summaries = yield* subagentSummaries();
                  if (watching && !disposed) changed(summaries);
                }),
              ),
            );
            yield* Effect.callback<void>((resume) => {
              const stop = () => resume(Effect.void);
              if (controller.signal.aborted) stop();
              else
                controller.signal.addEventListener("abort", stop, {
                  once: true,
                });
              return Effect.sync(() =>
                controller.signal.removeEventListener("abort", stop),
              );
            });
          }),
        ),
        undefined,
      )
      .catch(() => {
        if (watching && !disposed) failed();
      });

    return unsubscribe;
  };

  return {
    watchSummaries,
    captureHistory: (subagentId) =>
      lease.run(
        Effect.gen(function* () {
          const capturedAt = yield* Clock.currentTimeMillis;
          const runs = yield* runSummaries(subagentId);
          return Object.freeze({ runs, capturedAt });
        }),
        undefined,
      ),
    inspectRun: (runId) => lease.run(inspectRunQuery(runId), undefined),
    currentInstant: lease.currentInstant,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of [...watchers]) unsubscribe();
      watchers.clear();
      lease.dispose();
    },
  };
}
