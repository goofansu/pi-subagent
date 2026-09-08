/**
 * The `details` a tool result carries alongside its text.
 *
 * Pi hands a tool result's `details` back to the renderer that draws it, so
 * this is how a collapsed row says "explore (run-1) completed · 412
 * characters" without re-parsing the text it is summarising. The shapes are
 * declared here, next to the renderers that read them, and the façade builds
 * them — which is the only reason the façade knows about them at all.
 *
 * Every field is a plain string or number. `details` crosses the host as
 * `unknown` and may be persisted with the session, so a branded id or a
 * domain value with methods would be a shape that survived the trip only by
 * luck. The guards below are therefore real runtime checks rather than casts:
 * this renderer can be handed another extension's tool result, and the type
 * that says otherwise is only as good as the boundary it was written at.
 */

import type { RunResult, TerminalRunPhase } from "../domain/index.ts";
import { TERMINAL_RUN_PHASES } from "../domain/index.ts";

/** One terminal Run the collapsed line covers. */
export interface CollectedRun {
  readonly runId: string;
  readonly agent: string;
  readonly status: TerminalRunPhase;
}

/** Which Runs a collected result covers, for the collapsed line. */
export interface CollectedRuns {
  readonly runs: readonly CollectedRun[];
  /** Runs asked for that had not finished. Only the two waits produce these. */
  readonly stillRunning?: number;
}

/** The collapsed line's entry for one stored Result. */
export function collectedRunOf(result: RunResult): CollectedRun {
  return {
    runId: result.runId,
    agent: result.agent,
    status: result.status,
  };
}

function isTerminalStatus(value: unknown): value is TerminalRunPhase {
  return (TERMINAL_RUN_PHASES as readonly string[]).includes(value as string);
}

function isCollectedRun(value: unknown): value is CollectedRun {
  if (typeof value !== "object" || value === null) return false;
  const run = value as Record<string, unknown>;
  return (
    typeof run.runId === "string" &&
    typeof run.agent === "string" &&
    isTerminalStatus(run.status)
  );
}

export function isCollectedRuns(value: unknown): value is CollectedRuns {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return Array.isArray(details.runs) && details.runs.every(isCollectedRun);
}
