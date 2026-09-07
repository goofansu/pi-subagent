/** One scoped, publication-driven overview subscription; never reads output. */
import { Effect, Stream } from "effect";
import { subagentSummaries } from "../application/history.ts";
import type { SubagentSummary } from "../domain/history.ts";
import { RunRepository } from "../runtime/repository.ts";
import type { SessionObservation } from "./session-handle.ts";

export function observeOverview(
  session: SessionObservation,
  update: (rows: readonly SubagentSummary[]) => void,
  failed: () => void,
): () => void {
  const controller = new AbortController();
  void session
    .run(
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* RunRepository;
          const changes = yield* repository.subscribe();
          // Observations are only invalidations here. Drain them cheaply and
          // keep one pending refresh; each refresh queries current summaries,
          // never replays a queued historical index into the UI.
          const invalidations = changes.pipe(
            Stream.map(() => undefined),
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
          );
          yield* Effect.forkScoped(
            Stream.runForEach(invalidations, () =>
              Effect.gen(function* () {
                const rows = yield* subagentSummaries();
                if (!controller.signal.aborted) update(rows);
              }),
            ),
          );
          yield* Effect.callback<void>((resume) => {
            const stop = () => resume(Effect.void);
            if (controller.signal.aborted) stop();
            else
              controller.signal.addEventListener("abort", stop, { once: true });
            return Effect.sync(() =>
              controller.signal.removeEventListener("abort", stop),
            );
          });
        }),
      ),
      undefined,
    )
    .catch(() => {
      if (!controller.signal.aborted) failed();
    });
  return () => controller.abort();
}
