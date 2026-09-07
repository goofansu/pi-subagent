import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import {
  isTerminalRunPhase,
  type SubagentId,
  type SubagentPhase,
} from "../domain/index.ts";
import type { RunSnapshot } from "./repository.ts";

/** Records supply actual phases and insertion order, never resource references. */
export function summarizeSubagents(
  runs: readonly RunSnapshot[],
  subagents: readonly {
    readonly id: SubagentId;
    readonly phase: SubagentPhase;
  }[],
): readonly SubagentSummary[] {
  const grouped = new Map<SubagentId, RunSummary[]>();
  for (const run of runs) {
    const history = grouped.get(run.identity.subagentId) ?? [];
    history.push(summarizeRun(run));
    grouped.set(run.identity.subagentId, history);
  }
  return Object.freeze(
    subagents.flatMap((subagent) => {
      const history = grouped.get(subagent.id);
      const latest = history?.at(-1);
      if (!latest) return [];
      const current = history?.find((run) => !isTerminalRunPhase(run.phase));
      return [
        Object.freeze({
          subagentId: subagent.id,
          phase: subagent.phase,
          latest,
          ...(current ? { current } : {}),
        }),
      ];
    }),
  );
}

/** Copy only displayed facts; repository additions cannot widen observation. */
export function summarizeRun(run: RunSnapshot): RunSummary {
  return Object.freeze({
    runId: run.identity.runId,
    subagentId: run.identity.subagentId,
    profile: run.identity.agent,
    backend: run.identity.backendId,
    label: run.identity.description,
    phase: run.phase,
    ...(run.cancellation
      ? { cancellationReason: run.cancellation.reason }
      : {}),
    ...(run.activity === undefined ? {} : { activity: run.activity }),
    turns: run.usage.turns,
    startedAt: run.startedAt,
    ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
  });
}
