import { Clock, Effect } from "effect";
import type { RunId, SubagentId } from "../domain/ids.ts";
import type {
  RunInspection,
  SubagentInspectionSummary,
} from "../domain/inspection.ts";
import { summarizeRun } from "./history.ts";
import type { RunRepositoryApi } from "./repository.ts";
import type { ResultStoreApi } from "./result-store.ts";

/**
 * Terminal publication follows storage and is absorbing. Read that publication
 * before the store; never infer terminality from a Projection's ending flag.
 * Eviction in between is an honest expiry. Active capture belongs to the next
 * slice; here an active/finalizing row explicitly has no terminal Result yet.
 */
export function inspectTerminalRun(
  id: RunId,
  repository: RunRepositoryApi,
  store: ResultStoreApi,
  subagent: (id: SubagentId) => SubagentInspectionSummary | undefined,
): Effect.Effect<RunInspection> {
  return Effect.gen(function* () {
    const known = yield* repository.lookup(id);
    const capturedAt = yield* Clock.currentTimeMillis;
    const capture = { runId: id, capturedAt };
    if (known.state === "unknown" || known.state === "spent")
      return Object.freeze({ ...capture, outcome: "unknown Run" });
    const condition = subagent(known.snapshot.identity.subagentId);
    const metadata = {
      ...capture,
      summary: summarizeRun(known.snapshot),
      usage: {
        turns: known.snapshot.usage.turns,
        totals: { ...known.snapshot.usage.totals },
        context: { ...known.snapshot.usage.context },
      },
      ...(condition ? { subagent: condition } : {}),
    };
    if (known.state === "active")
      return freeze({ ...metadata, outcome: "RunNotTerminal" });
    const stored = yield* store.read(id);
    if (stored.outcome === "result")
      return freeze({ ...metadata, outcome: "result", result: stored.result });
    return freeze({
      ...metadata,
      outcome:
        stored.outcome === "ResultExpired" ? "ResultExpired" : "unavailable",
      ...(stored.outcome === "defect" ? { diagnostic: stored.diagnostic } : {}),
    });
  });
}

/** Decoding yields fresh bounded plain data; recursively freeze the capture. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
