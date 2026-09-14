/**
 * Presentation meaning carried beside an agent tool's model-visible prose.
 *
 * Tool-row facts are not domain values: they are the bounded facts needed to
 * draw one collapsed tool row. Construction translates every domain outcome
 * explicitly, while decoding treats the host-owned `details` slot as unknown.
 * Neither operation can decide Run meaning or Result hand-off.
 */

import type {
  CancelOutcome,
  ResultOutcome,
  ResumeOutcome,
  RunId,
  RunResult,
  StartOutcome,
  SteerOutcome,
  TerminalRunPhase,
  WaitOutcome,
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

/** One delivered Result in a compact collection or retrieval summary. */
export interface ResultRunSummary {
  readonly runId: string;
  readonly agent: string;
  readonly status: TerminalRunPhase;
  /** Characters retained in the Result's final output. */
  readonly outputCharacters: number;
}

/** Presentation-only facts for either Wait operation. */
export interface CollectedRunsToolRowFacts {
  readonly kind: "collection";
  /** This is the operation discriminator for the two collection renderers. */
  readonly scope: "named" | "all-active";
  readonly runs: readonly ResultRunSummary[];
  readonly stillRunning: number;
  readonly unknown: number;
  readonly unavailable: number;
  readonly noActiveRuns: boolean;
}

/** Presentation-only facts for one `agent_result` outcome. */
export type ResultToolRowFacts =
  | {
      readonly kind: "result";
      readonly outcome: "available";
      readonly run: ResultRunSummary;
    }
  | {
      readonly kind: "result";
      readonly outcome: "still-running" | "unknown";
      readonly runId: string;
    }
  | {
      readonly kind: "result";
      readonly outcome: "unavailable";
      readonly runId: string;
      readonly status: TerminalRunPhase;
    };

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
export type CancelRunToolRowOutcome =
  | { readonly kind: "requested"; readonly runId: string }
  | { readonly kind: "already requested"; readonly runId: string }
  | {
      readonly kind: "already terminal";
      readonly runId: string;
      readonly phase: TerminalRunPhase;
    }
  | { readonly kind: "unknown"; readonly runId: string };

/** Discriminated, presentation-only facts for one cancellation operation. */
export interface CancelToolRowFacts {
  readonly kind: "cancel";
  readonly outcomes: readonly CancelRunToolRowOutcome[];
}

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
  scope: CollectedRunsToolRowFacts["scope"],
  outcomes: readonly WaitOutcome[],
  noActiveRuns: boolean,
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
    noActiveRuns,
  };
}

/** Make the presentation decision for every named-Wait outcome. */
export function waitToolRowFacts(
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  return collectedToolRowFacts("named", outcomes, false);
}

/** Make the presentation decision for every collected wait-all outcome. */
export function waitAllToolRowFacts(
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  return collectedToolRowFacts("all-active", outcomes, false);
}

/** Make the wait-all presentation decision when there were no active Runs. */
export function noActiveWaitAllToolRowFacts(): CollectedRunsToolRowFacts {
  return collectedToolRowFacts("all-active", [], true);
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

const TERMINAL_PHASES: Readonly<Record<TerminalRunPhase, true>> = {
  completed: true,
  failed: true,
  cancelled: true,
};

function hasOwnKey<K extends string>(
  values: Readonly<Record<K, true>>,
  value: unknown,
): value is K {
  return typeof value === "string" && Object.hasOwn(values, value);
}

function isTerminalPhase(value: unknown): value is TerminalRunPhase {
  return hasOwnKey(TERMINAL_PHASES, value);
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

function decodeCancelOutcome(
  value: unknown,
): CancelRunToolRowOutcome | undefined {
  const outcome = recordOf(value);
  if (!outcome || !isIdentifier(outcome.runId)) return undefined;
  switch (outcome.kind) {
    case "requested":
    case "already requested":
    case "unknown":
      return hasExactly(outcome, ["kind", "runId"])
        ? { kind: outcome.kind, runId: outcome.runId }
        : undefined;
    case "already terminal":
      return hasExactly(outcome, ["kind", "runId", "phase"]) &&
        isTerminalPhase(outcome.phase)
        ? {
            kind: "already terminal",
            runId: outcome.runId,
            phase: outcome.phase,
          }
        : undefined;
    default:
      return undefined;
  }
}

function decodeCancel(
  value: Record<string, unknown>,
): CancelToolRowFacts | undefined {
  if (
    !hasExactly(value, ["kind", "outcomes"]) ||
    !Array.isArray(value.outcomes)
  ) {
    return undefined;
  }
  const outcomes = value.outcomes.map(decodeCancelOutcome);
  return outcomes.every((outcome) => outcome !== undefined)
    ? { kind: "cancel", outcomes: outcomes as CancelRunToolRowOutcome[] }
    : undefined;
}

function decodeRunSummary(value: unknown): ResultRunSummary | undefined {
  const run = recordOf(value);
  return run &&
    hasExactly(run, ["runId", "agent", "status", "outputCharacters"]) &&
    isIdentifier(run.runId) &&
    typeof run.agent === "string" &&
    isTerminalPhase(run.status) &&
    isCount(run.outputCharacters)
    ? {
        runId: run.runId,
        agent: run.agent,
        status: run.status,
        outputCharacters: run.outputCharacters,
      }
    : undefined;
}

function decodeCollection(
  value: Record<string, unknown>,
): CollectedRunsToolRowFacts | undefined {
  if (
    !hasExactly(value, [
      "kind",
      "scope",
      "runs",
      "stillRunning",
      "unknown",
      "unavailable",
      "noActiveRuns",
    ]) ||
    (value.scope !== "named" && value.scope !== "all-active") ||
    !Array.isArray(value.runs) ||
    !isCount(value.stillRunning) ||
    !isCount(value.unknown) ||
    !isCount(value.unavailable) ||
    typeof value.noActiveRuns !== "boolean"
  ) {
    return undefined;
  }
  const runs = value.runs.map(decodeRunSummary);
  if (!runs.every((run) => run !== undefined)) return undefined;
  if (
    value.noActiveRuns &&
    (value.scope !== "all-active" ||
      runs.length !== 0 ||
      value.stillRunning !== 0 ||
      value.unknown !== 0 ||
      value.unavailable !== 0)
  ) {
    return undefined;
  }
  return {
    kind: "collection",
    scope: value.scope,
    runs: runs as ResultRunSummary[],
    stillRunning: value.stillRunning,
    unknown: value.unknown,
    unavailable: value.unavailable,
    noActiveRuns: value.noActiveRuns,
  };
}

function decodeResult(
  value: Record<string, unknown>,
): ResultToolRowFacts | undefined {
  switch (value.outcome) {
    case "available": {
      if (!hasExactly(value, ["kind", "outcome", "run"])) return undefined;
      const run = decodeRunSummary(value.run);
      return run ? { kind: "result", outcome: "available", run } : undefined;
    }
    case "still-running":
    case "unknown":
      return hasExactly(value, ["kind", "outcome", "runId"]) &&
        isIdentifier(value.runId)
        ? { kind: "result", outcome: value.outcome, runId: value.runId }
        : undefined;
    case "unavailable":
      return hasExactly(value, ["kind", "outcome", "runId", "status"]) &&
        isIdentifier(value.runId) &&
        isTerminalPhase(value.status)
        ? {
            kind: "result",
            outcome: "unavailable",
            runId: value.runId,
            status: value.status,
          }
        : undefined;
    default:
      return undefined;
  }
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
        return decodeCancel(candidate);
      case "collection":
        return decodeCollection(candidate);
      case "result":
        return decodeResult(candidate);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
