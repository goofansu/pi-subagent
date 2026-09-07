import { Clock, Effect, Ref, SubscriptionRef } from "effect";
import type { RunId } from "../domain/ids.ts";
import type { RunInspection } from "../domain/inspection.ts";
import { isTerminalRunPhase } from "../domain/phases.ts";
import { summarizeRun } from "./history.ts";
import type { RunRepositoryApi } from "./repository.ts";
import type { ResultStoreApi } from "./result-store.ts";
import type { SubagentRecords } from "./subagent-records.ts";

/**
 * The synchronous capture callback is the active read's linearization point:
 * published phase, attached Projection, known Subagent conditions and time are
 * read without yielding. No lock, backend call or settlement barrier is needed.
 * A reduced ending is NOT terminal publication; even a closed Run Scope can
 * still have an attached Projection while ordinary settlement finishes.
 *
 * Terminal publication follows storage and is absorbing. Once observed, read
 * only the authoritative store. Eviction during that read is honest expiry;
 * never turn an active Projection into a Result or pin it for observation.
 */
export function captureRunInspection(
  id: RunId,
  repository: RunRepositoryApi,
  store: ResultStoreApi,
  records: SubagentRecords,
): Effect.Effect<RunInspection> {
  return Effect.gen(function* () {
    const captured = yield* Effect.map(
      Clock.currentTimeMillis,
      (capturedAt) => {
        const snapshot = SubscriptionRef.getUnsafe(repository.index).get(id);
        const capture = { runId: id, capturedAt };
        if (!snapshot)
          return freeze({ ...capture, outcome: "unknown Run" } as const);
        const record = records.get(snapshot.identity.subagentId);
        const metadata = {
          ...capture,
          summary: summarizeRun(snapshot),
          usage: snapshot.usage,
          ...(record
            ? {
                subagent: {
                  phase: record.phase,
                  conversationLost: record.conversationLost,
                },
              }
            : {}),
        };
        if (isTerminalRunPhase(snapshot.phase))
          return freeze(
            structuredClone({ ...metadata, outcome: "terminal" } as const),
          );
        const current = records.currentRun(id);
        if (!current)
          return freeze(
            structuredClone({ ...metadata, outcome: "unavailable" } as const),
          );
        const projection = Ref.getUnsafe(current.handle.projection);
        return freeze(
          structuredClone({
            ...metadata,
            summary: { ...metadata.summary, turns: projection.usage.turns },
            usage: projection.usage,
            outcome: "active",
            content: {
              transcript: projection.transcript,
              tools: projection.tools,
              diagnostics: projection.diagnostics,
              links: projection.links,
              model: projection.model,
              finalOutput: projection.finalOutput,
              truncation: projection.truncation,
              ...(projection.ending?.ending === "failed"
                ? { errorMessage: projection.ending.message }
                : {}),
            },
          } as const),
        );
      },
    );
    if (captured.outcome !== "terminal") return captured;
    const stored = yield* store.read(id);
    if (stored.outcome === "result")
      return freeze({ ...captured, outcome: "result", result: stored.result });
    return freeze({
      ...captured,
      outcome:
        stored.outcome === "ResultExpired" ? "ResultExpired" : "unavailable",
      ...(stored.outcome === "defect" ? { diagnostic: stored.diagnostic } : {}),
    });
  });
}

/** Clone active data / decode stored data before freezing, never freeze owners. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
