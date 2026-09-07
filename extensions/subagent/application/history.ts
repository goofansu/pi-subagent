/** Read-only observation through the same application/runtime boundary as tools. */
import { Effect } from "effect";
import type { RunId, SubagentId } from "../domain/index.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";

export const inspectRun = (id: RunId) =>
  Effect.flatMap(SubagentSupervisor, (supervisor) => supervisor.inspectRun(id));

export const subagentSummaries = () =>
  Effect.flatMap(SubagentSupervisor, (supervisor) =>
    supervisor.subagentSummaries(),
  );
export const runSummaries = (id: SubagentId) =>
  Effect.flatMap(SubagentSupervisor, (supervisor) =>
    supervisor.runSummaries(id),
  );
