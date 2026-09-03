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
import { RunDiagnostic, runDiagnostic } from "./diagnostics.ts";
import { type RunEnding, terminalPhaseForEnding } from "./endings.ts";
import { BackendId, RunId, SubagentId } from "./ids.ts";
import { ResultLink } from "./links.ts";
import { CancellationReason, TerminalRunPhase } from "./phases.ts";
import { type RunProjection, TruncationRecord } from "./projection.ts";
import { boundOneLineText } from "./text.ts";
import { ToolEntry, TranscriptItem } from "./transcript.ts";
import { UsageSnapshot } from "./usage.ts";

/**
 * The bound on a Run's label — the description a model passes to
 * `agent_start` or `agent_resume`.
 *
 * The label is identity, so Result bounding never removes it: a Result that
 * could not say which Run it belongs to would be worse than one over its
 * bound. That makes an unbounded label the one input a model can use to carry
 * a Result past its byte target after everything removable has been cut, and
 * the one input that can make the push sink retain an unbounded value while a
 * notice waits to land. Two hundred bytes is a line of orientation; the brief
 * itself goes in the prompt, which is bounded elsewhere.
 */
export const RUN_LABEL_MAX_BYTES = 200;

/**
 * Bound a description into a label: one line, at most the label bound.
 *
 * Applied once, at admission, before a Run exists — so the label that reaches
 * identity, the Result, and the notice is the same string everywhere, and no
 * later call site has to remember the rule.
 *
 * Truncate-and-record rather than refuse, per contributing invariant 11's
 * first branch: a label is orientation, and refusing a start over its length
 * would cost the model a round trip and buy no safety. What was removed is
 * reported so the Run can carry {@link labelShortenedDiagnostic}.
 */
export function boundRunLabel(description: string): {
  readonly label: string;
  readonly droppedBytes: number;
} {
  const bounded = boundOneLineText(description, RUN_LABEL_MAX_BYTES);
  return { label: bounded.text, droppedBytes: bounded.droppedBytes };
}

/**
 * What a Run says about having had its label shortened.
 *
 * The *record* half of truncate-and-record. It travels with the start or
 * resume request and is emitted onto the Run through the same observation
 * intake every other diagnostic uses, so the stored Result says the label was
 * shortened and by how much rather than the shortening being invisible.
 *
 * The category is `other` because none of the specific ones is true: nothing
 * a backend, a transport, a queue, or a Profile did caused it. The model's
 * description was long.
 */
export function labelShortenedDiagnostic(droppedBytes: number): RunDiagnostic {
  return runDiagnostic(
    "other",
    `the Run's label was shortened to ${RUN_LABEL_MAX_BYTES} bytes; ${droppedBytes} bytes were removed`,
  );
}

/** A wall-clock instant in milliseconds. */
const Instant = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Who a Run belongs to. Fixed when the Run is admitted. */
export const RunIdentity = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  backendId: BackendId,
  /** The Profile's name, as the caller asked for it. */
  agent: Schema.String,
  /**
   * The Run's label: what the caller said this Run is for.
   *
   * Bounded at admission by {@link boundRunLabel}, so what is stored here is
   * one line of at most {@link RUN_LABEL_MAX_BYTES}. The field keeps the name
   * a caller uses — `description` is what the tool schema calls it — while
   * every surface that shows it calls it the label.
   */
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
