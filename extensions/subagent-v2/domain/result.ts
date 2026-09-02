/**
 * The immutable Run result.
 *
 * One value, produced once, at settlement, from a projection that is already
 * bounded. It is what `agent_result` returns, what `agent_wait` observes, and
 * what a completion Notification points at, and none of those may see a
 * different answer from the others.
 *
 * The ContextGauge a Run ended with is carried inside `usage`, at
 * `usage.context`, rather than duplicated as a second field: a gauge stored
 * twice is a gauge that can disagree with itself.
 *
 * This is the one domain type with an encoder as well as a decoder, because
 * the Result store persists it. Encoding and decoding on the way in and out is
 * what proves the round trip and what stops provider vocabulary being stored
 * by accident.
 */

import { Schema } from "effect";
import { RunDiagnostic } from "./diagnostics.ts";
import { type RunEnding, terminalPhaseForEnding } from "./endings.ts";
import { BackendId, RunId, SubagentId } from "./ids.ts";
import { ResultLink } from "./links.ts";
import { CancellationReason, TerminalRunPhase } from "./phases.ts";
import { type RunProjection, TruncationRecord } from "./projection.ts";
import { ToolEntry, TranscriptItem } from "./transcript.ts";
import { UsageSnapshot } from "./usage.ts";

/** A wall-clock instant in milliseconds. */
const Instant = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Who a Run belongs to. Fixed when the Run is admitted. */
export const RunIdentity = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  backendId: BackendId,
  /** The Profile's name, as the caller asked for it. */
  agent: Schema.String,
  description: Schema.String,
});

export type RunIdentity = typeof RunIdentity.Type;

export const RunResult = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  backendId: BackendId,
  agent: Schema.String,
  description: Schema.String,
  status: TerminalRunPhase,
  /** Present exactly when the status is `cancelled`. */
  cancellationReason: Schema.optionalKey(CancellationReason),
  /** Present only for a failed Run that had a message to give. */
  errorMessage: Schema.optionalKey(Schema.String),
  finalOutput: Schema.String,
  transcript: Schema.Array(TranscriptItem),
  tools: Schema.Array(ToolEntry),
  usage: UsageSnapshot,
  diagnostics: Schema.Array(RunDiagnostic),
  links: Schema.Array(ResultLink),
  model: Schema.optionalKey(Schema.String),
  startedAt: Instant,
  settledAt: Instant,
  truncation: TruncationRecord,
});

export type RunResult = typeof RunResult.Type;

export interface RunSettlement {
  readonly identity: RunIdentity;
  readonly projection: RunProjection;
  readonly ending: RunEnding;
  readonly startedAt: number;
  readonly settledAt: number;
}

/**
 * Produce the Run's one result.
 *
 * Nothing is fabricated. A Run that settled with no observations gets empty
 * output, an empty transcript, and zero usage, because that is what happened.
 */
export function toRunResult(settlement: RunSettlement): RunResult {
  const { identity, projection, ending } = settlement;
  const status = terminalPhaseForEnding(ending);
  const result: RunResult = {
    runId: identity.runId,
    subagentId: identity.subagentId,
    backendId: identity.backendId,
    agent: identity.agent,
    description: identity.description,
    status,
    ...(ending.ending === "cancelled"
      ? { cancellationReason: ending.reason }
      : {}),
    ...(ending.ending === "failed" && ending.message !== undefined
      ? { errorMessage: ending.message }
      : {}),
    finalOutput: projection.finalOutput,
    transcript: projection.transcript,
    tools: projection.tools,
    usage: projection.usage,
    diagnostics: projection.diagnostics,
    links: projection.links,
    ...(projection.model === undefined ? {} : { model: projection.model }),
    startedAt: settlement.startedAt,
    settledAt: settlement.settledAt,
    truncation: projection.truncation,
  };
  // Readonly types make the shape immutable to a compiler; freezing makes it
  // immutable to a caller that reached it through an `any`.
  Object.freeze(result.transcript);
  Object.freeze(result.tools);
  Object.freeze(result.diagnostics);
  Object.freeze(result.links);
  return Object.freeze(result);
}
