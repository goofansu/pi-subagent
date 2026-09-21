/**
 * Presentation meaning carried beside an agent tool's model-visible prose.
 *
 * Tool-row facts are not domain values: they are the bounded facts needed to
 * draw one collapsed tool row. Construction translates every domain outcome
 * explicitly, while decoding treats the host-owned `details` slot as unknown.
 * Neither operation can decide Run meaning or Result hand-off.
 */

import { Schema } from "effect";
import {
  type CancelOutcome,
  EXACT_KEYS,
  type ResultOutcome,
  type ResumeOutcome,
  type RunId,
  type RunResult,
  type StartOutcome,
  type SteerOutcome,
  TerminalRunPhase,
  type WaitOutcome,
} from "../domain/index.ts";

/** Discriminated, presentation-only facts for every start outcome. */
export type StartToolRowFacts =
  | {
      readonly kind: "start";
      readonly outcome: "started";
      readonly agent: string;
      readonly subagentId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "start";
      readonly outcome: Exclude<
        StartOutcome["outcome"],
        "started" | "delegation-depth exceeded"
      >;
      readonly agent: string;
    }
  | {
      readonly kind: "start";
      readonly outcome: "delegation-depth exceeded";
      readonly agent: string;
      readonly depth: number;
    };

export type StartedRunToolRowFacts = Extract<
  StartToolRowFacts,
  { readonly outcome: "started" }
>;

const IdentifierText = Schema.String.check(
  Schema.isLengthBetween(1, 128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
);
const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const ResultRunSummarySchema = Schema.Struct({
  runId: IdentifierText,
  agent: Schema.String,
  status: TerminalRunPhase,
  outputCharacters: Count,
});

/** One delivered Result in a compact collection or retrieval summary. */
export type ResultRunSummary = typeof ResultRunSummarySchema.Type;

const CollectionWithRunsSchema = Schema.Struct({
  kind: Schema.Literal("collection"),
  scope: Schema.Literals(["named", "all-active"]),
  runs: Schema.Array(ResultRunSummarySchema),
  stillRunning: Count,
  unknown: Count,
  unavailable: Count,
  noActiveRuns: Schema.Literal(false),
});

const EmptyCollectionSchema = Schema.Struct({
  kind: Schema.Literal("collection"),
  scope: Schema.Literal("all-active"),
  runs: Schema.Tuple([]),
  stillRunning: Schema.Literal(0),
  unknown: Schema.Literal(0),
  unavailable: Schema.Literal(0),
  noActiveRuns: Schema.Literal(true),
});

/** Presentation-only facts for either Wait operation. */
const CollectedRunsToolRowFactsSchema = Schema.Union([
  CollectionWithRunsSchema,
  EmptyCollectionSchema,
]);
export type CollectedRunsToolRowFacts =
  typeof CollectedRunsToolRowFactsSchema.Type;

/** Presentation-only facts for one `agent_result` outcome. */
const ResultToolRowFactsSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("result"),
    outcome: Schema.Literal("available"),
    run: ResultRunSummarySchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    outcome: Schema.Literals(["still-running", "unknown"]),
    runId: IdentifierText,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    outcome: Schema.Literal("unavailable"),
    runId: IdentifierText,
    status: TerminalRunPhase,
  }),
]);
export type ResultToolRowFacts = typeof ResultToolRowFactsSchema.Type;

export type ResumeToolRowFacts =
  | {
      readonly kind: "resume";
      readonly outcome: "started";
      readonly subagentId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "resume";
      readonly outcome: Exclude<ResumeOutcome["outcome"], "started">;
    };

export interface SteerToolRowFacts {
  readonly kind: "steer";
  readonly outcome: SteerOutcome["outcome"];
  readonly runId: string;
}

/** One cancellation-request admission outcome, separate from settlement. */
const CancelRunToolRowOutcomeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["requested", "already requested", "unknown"]),
    runId: IdentifierText,
  }),
  Schema.Struct({
    kind: Schema.Literal("already terminal"),
    runId: IdentifierText,
    phase: TerminalRunPhase,
  }),
]);
export type CancelRunToolRowOutcome = typeof CancelRunToolRowOutcomeSchema.Type;

/** Discriminated, presentation-only facts for one cancellation operation. */
const CancelToolRowFactsSchema = Schema.Struct({
  kind: Schema.Literal("cancel"),
  outcomes: Schema.Array(CancelRunToolRowOutcomeSchema),
});
export type CancelToolRowFacts = typeof CancelToolRowFactsSchema.Type;

const AggregateToolRowFactsSchema = Schema.Union([
  CollectedRunsToolRowFactsSchema,
  CancelToolRowFactsSchema,
  ResultToolRowFactsSchema,
]);
type AggregateToolRowFacts = typeof AggregateToolRowFactsSchema.Type;

/** The one presentation-owned fact vocabulary for all seven agent tools. */
export type ToolRowFacts =
  | StartToolRowFacts
  | ResumeToolRowFacts
  | SteerToolRowFacts
  | CollectedRunsToolRowFacts
  | ResultToolRowFacts
  | CancelToolRowFacts;

/** Build the shared compact vocabulary from one immutable Result. */
function resultRunSummaryOf(result: RunResult): ResultRunSummary {
  return {
    runId: result.runId,
    agent: result.agent,
    status: result.status,
    outputCharacters: result.finalOutput.length,
  };
}

/** Make the presentation decision for every `agent_start` outcome. */
export function startToolRowFacts(
  agent: string,
  outcome: StartOutcome,
): StartToolRowFacts {
  switch (outcome.outcome) {
    case "started":
      return {
        kind: "start",
        outcome: "started",
        agent,
        subagentId: outcome.subagentId,
        runId: outcome.runId,
      };
    case "unknown agent":
    case "invalid profile":
    case "empty label":
    case "at capacity":
    case "shutting down":
    case "backend unavailable":
      return { kind: "start", outcome: outcome.outcome, agent };
    case "delegation-depth exceeded":
      return {
        kind: "start",
        outcome: outcome.outcome,
        agent,
        depth: outcome.depth,
      };
    default:
      return outcome satisfies never;
  }
}

/** Make the presentation decision for every `agent_resume` outcome. */
export function resumeToolRowFacts(outcome: ResumeOutcome): ResumeToolRowFacts {
  switch (outcome.outcome) {
    case "started":
      return {
        kind: "resume",
        outcome: "started",
        subagentId: outcome.subagentId,
        runId: outcome.runId,
      };
    case "unknown Subagent":
    case "Subagent already running":
    case "empty label":
    case "resume unsupported":
    case "conversation lost":
    case "at capacity":
    case "shutting down":
      return { kind: "resume", outcome: outcome.outcome };
    default:
      return outcome satisfies never;
  }
}

/** Make the presentation decision for every `agent_steer` outcome. */
export function steerToolRowFacts(
  requestedRunId: RunId,
  outcome: SteerOutcome,
): SteerToolRowFacts {
  switch (outcome.outcome) {
    case "accepted":
    case "mailbox full":
    case "unsupported":
    case "mailbox closed":
    case "already completed":
    case "already failed":
    case "already cancelled":
    case "unknown Run":
      return { kind: "steer", outcome: outcome.outcome, runId: outcome.runId };
    case "invalid":
    case "shutting down":
      return { kind: "steer", outcome: outcome.outcome, runId: requestedRunId };
    default:
      return outcome satisfies never;
  }
}

/** Make the presentation decision for every nested `agent_cancel` outcome. */
export function cancelToolRowFacts(
  outcomes: readonly CancelOutcome[],
): CancelToolRowFacts {
  return {
    kind: "cancel",
    outcomes: outcomes.map((outcome): CancelRunToolRowOutcome => {
      switch (outcome.outcome) {
        case "admitted":
          return { kind: "requested", runId: outcome.runId };
        case "idempotent":
          return { kind: "already requested", runId: outcome.runId };
        case "already completed":
          return {
            kind: "already terminal",
            runId: outcome.runId,
            phase: "completed",
          };
        case "already failed":
          return {
            kind: "already terminal",
            runId: outcome.runId,
            phase: "failed",
          };
        case "already cancelled":
          return {
            kind: "already terminal",
            runId: outcome.runId,
            phase: "cancelled",
          };
        case "unknown Run":
          return { kind: "unknown", runId: outcome.runId };
        default:
          return outcome satisfies never;
      }
    }),
  };
}

function collectedToolRowFacts(
  scope: "named" | "all-active",
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  const runs: ResultRunSummary[] = [];
  let stillRunning = 0;
  let unknown = 0;
  let unavailable = 0;
  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "terminal":
        if (outcome.result === undefined) unavailable += 1;
        else runs.push(resultRunSummaryOf(outcome.result));
        break;
      case "still running":
        stillRunning += 1;
        break;
      case "unknown Run":
        unknown += 1;
        break;
      default:
        outcome satisfies never;
    }
  }
  return {
    kind: "collection",
    scope,
    runs,
    stillRunning,
    unknown,
    unavailable,
    noActiveRuns: false,
  };
}

/** Make the presentation decision for every named-Wait outcome. */
export function waitToolRowFacts(
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  return collectedToolRowFacts("named", outcomes);
}

/** Make the presentation decision for every collected wait-all outcome. */
export function waitAllToolRowFacts(
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  return collectedToolRowFacts("all-active", outcomes);
}

/** Make the wait-all presentation decision when there were no active Runs. */
export function noActiveWaitAllToolRowFacts(): CollectedRunsToolRowFacts {
  return {
    kind: "collection",
    scope: "all-active",
    runs: [],
    stillRunning: 0,
    unknown: 0,
    unavailable: 0,
    noActiveRuns: true,
  };
}

/** Make the presentation decision for every `agent_result` outcome. */
export function resultToolRowFacts(outcome: ResultOutcome): ResultToolRowFacts {
  switch (outcome.outcome) {
    case "result":
      return {
        kind: "result",
        outcome: "available",
        run: resultRunSummaryOf(outcome.result),
      };
    case "ResultExpired":
      return {
        kind: "result",
        outcome: "unavailable",
        runId: outcome.runId,
        status: outcome.status,
      };
    case "RunNotTerminal":
      return {
        kind: "result",
        outcome: "still-running",
        runId: outcome.runId,
      };
    case "unknown Run":
      return { kind: "result", outcome: "unknown", runId: outcome.runId };
    default:
      return outcome satisfies never;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const IDENTIFIER_MAX_LENGTH = 128;

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX_LENGTH &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasOwnKey<K extends string>(
  values: Readonly<Record<K, true>>,
  value: unknown,
): value is K {
  return typeof value === "string" && Object.hasOwn(values, value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactly(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

const START_REFUSALS: Readonly<
  Record<
    Exclude<StartOutcome["outcome"], "started" | "delegation-depth exceeded">,
    true
  >
> = {
  "unknown agent": true,
  "invalid profile": true,
  "empty label": true,
  "at capacity": true,
  "shutting down": true,
  "backend unavailable": true,
};

const RESUME_REFUSALS: Readonly<
  Record<Exclude<ResumeOutcome["outcome"], "started">, true>
> = {
  "unknown Subagent": true,
  "Subagent already running": true,
  "empty label": true,
  "resume unsupported": true,
  "conversation lost": true,
  "at capacity": true,
  "shutting down": true,
};

const STEER_OUTCOMES: Readonly<Record<SteerOutcome["outcome"], true>> = {
  accepted: true,
  "mailbox full": true,
  invalid: true,
  unsupported: true,
  "mailbox closed": true,
  "already completed": true,
  "already failed": true,
  "already cancelled": true,
  "unknown Run": true,
  "shutting down": true,
};

function decodeStart(
  value: Record<string, unknown>,
): StartToolRowFacts | undefined {
  if (typeof value.agent !== "string") return undefined;
  if (value.outcome === "started") {
    return hasExactly(value, [
      "kind",
      "outcome",
      "agent",
      "subagentId",
      "runId",
    ]) &&
      isIdentifier(value.subagentId) &&
      isIdentifier(value.runId)
      ? {
          kind: "start",
          outcome: "started",
          agent: value.agent,
          subagentId: value.subagentId,
          runId: value.runId,
        }
      : undefined;
  }
  if (value.outcome === "delegation-depth exceeded") {
    return hasExactly(value, ["kind", "outcome", "agent", "depth"]) &&
      isCount(value.depth)
      ? {
          kind: "start",
          outcome: value.outcome,
          agent: value.agent,
          depth: value.depth,
        }
      : undefined;
  }
  return hasExactly(value, ["kind", "outcome", "agent"]) &&
    hasOwnKey(START_REFUSALS, value.outcome)
    ? { kind: "start", outcome: value.outcome, agent: value.agent }
    : undefined;
}

function decodeResume(
  value: Record<string, unknown>,
): ResumeToolRowFacts | undefined {
  if (value.outcome === "started") {
    return hasExactly(value, ["kind", "outcome", "subagentId", "runId"]) &&
      isIdentifier(value.subagentId) &&
      isIdentifier(value.runId)
      ? {
          kind: "resume",
          outcome: "started",
          subagentId: value.subagentId,
          runId: value.runId,
        }
      : undefined;
  }
  return hasExactly(value, ["kind", "outcome"]) &&
    hasOwnKey(RESUME_REFUSALS, value.outcome)
    ? { kind: "resume", outcome: value.outcome }
    : undefined;
}

function decodeSteer(
  value: Record<string, unknown>,
): SteerToolRowFacts | undefined {
  return hasExactly(value, ["kind", "outcome", "runId"]) &&
    hasOwnKey(STEER_OUTCOMES, value.outcome) &&
    isIdentifier(value.runId)
    ? { kind: "steer", outcome: value.outcome, runId: value.runId }
    : undefined;
}

const decodeAggregateToolRowFacts = Schema.decodeUnknownResult(
  AggregateToolRowFactsSchema,
  EXACT_KEYS,
);
const encodeAggregateToolRowFacts = Schema.encodeUnknownSync(
  AggregateToolRowFactsSchema,
  EXACT_KEYS,
);

/**
 * Encode Tool-row facts for the host-owned details slot.
 *
 * The three schema-backed aggregate kinds cross through their schema encoder.
 * Start, resume, and steer remain unchanged until their own migration.
 */
export function encodeToolRowFacts(value: ToolRowFacts | undefined): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case "collection":
    case "cancel":
    case "result":
      return encodeAggregateToolRowFacts(value);
    case "start":
    case "resume":
    case "steer":
      return value;
    default:
      return value satisfies never;
  }
}

function decodeAggregate(value: unknown): AggregateToolRowFacts | undefined {
  const decoded = decodeAggregateToolRowFacts(value);
  return decoded._tag === "Success" ? decoded.success : undefined;
}

/**
 * Decode host-owned unknown details into Tool-row facts.
 *
 * Every operation discriminator and nested field is checked. Malformed,
 * foreign, legacy, and even accessor/proxy values return absence; none can
 * make this boundary throw.
 */
export function decodeToolRowFacts(value: unknown): ToolRowFacts | undefined {
  try {
    const candidate = recordOf(value);
    if (!candidate) return undefined;
    switch (candidate.kind) {
      case "start":
        return decodeStart(candidate);
      case "resume":
        return decodeResume(candidate);
      case "steer":
        return decodeSteer(candidate);
      case "cancel":
      case "collection":
      case "result":
        return decodeAggregate(candidate);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
