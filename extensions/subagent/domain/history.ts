/** Plain observation values: no output, resources, or lifecycle operations. */
import type { BackendId, RunId, SubagentId } from "./ids.ts";
import type { CancellationReason, RunPhase, SubagentPhase } from "./phases.ts";

export interface SemanticActivity {
  readonly summary: string;
  /** Runtime instant when the bounded normalized summary last changed. */
  readonly changedAt: number;
}

export interface RunSummary {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
  readonly profile: string;
  readonly backend: BackendId;
  readonly label: string;
  readonly phase: RunPhase;
  readonly cancellationReason?: CancellationReason;
  readonly activity?: string;
  readonly lastActivity?: SemanticActivity;
  readonly turns: number;
  readonly startedAt: number;
  readonly settledAt?: number;
}

/**
 * Run history rows and the one runtime instant they are rendered against.
 *
 * The instant travels with the rows because a history page is frozen at
 * entry: every age it shows is relative to when it was read, and a reader
 * that sampled the clock separately could date the rows from a different
 * moment than the one they were taken at.
 */
export interface RunHistoryCapture {
  readonly runs: readonly RunSummary[];
  readonly capturedAt: number;
}

export interface SubagentSummary {
  readonly subagentId: SubagentId;
  readonly phase: SubagentPhase;
  readonly latest: RunSummary;
  readonly current?: RunSummary;
}
