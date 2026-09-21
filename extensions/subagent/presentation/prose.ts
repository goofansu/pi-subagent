/**
 * The model-facing prose entry points for agent tools.
 *
 * Start, resume, and steer delegate to the typed outcome tables beside their
 * Tool-row facts. The aggregate operations keep their grouping formatters
 * here. In both cases the façade calls these public functions and host handlers
 * pass the result through, so no caller writes a competing sentence.
 *
 * The wording is ported from v1 where v1 had a sentence. Every rejection says
 * what the caller should do next, because one it cannot act on is one it will
 * retry.
 */

import type {
  CancelOutcome,
  ProfileDiagnostic,
  ResultOutcome,
  ResumeOutcome,
  RunId,
  StartOutcome,
  SteerOutcome,
  SubagentId,
  WaitOutcome,
} from "../domain/index.ts";
import { formatResult } from "./run-card.ts";
import {
  CANCEL_BUCKET_PRESENTATION,
  type CancelToolRowFacts,
  type CollectedRunsToolRowFacts,
  cancelBuckets,
  cancelToolRowFacts,
  formatProfileDiagnosticLines,
  noActiveWaitAllToolRowFacts,
  type ResultToolRowFacts,
  type ResumeToolRowFacts,
  resultOutcomeSentence,
  resultToolRowFacts,
  resumeOutcomeSentence,
  resumeToolRowFacts,
  type StartToolRowFacts,
  type SteerToolRowFacts,
  startOutcomeSentence,
  startToolRowFacts,
  steerOutcomeSentence,
  steerToolRowFacts,
  unknownAgentSentence,
  waitAllToolRowFacts,
  waitToolRowFacts,
} from "./tool-row-facts.ts";

/**
 * The end of an exhaustive switch.
 *
 * Reached only if a union gained a member, and it cannot be reached at
 * runtime without a cast, so the throw is a compiler affordance rather than a
 * code path.
 */
function unreachable(outcome: never): never {
  throw new Error(
    `no sentence for outcome ${JSON.stringify((outcome as { outcome?: string }).outcome)}`,
  );
}

export interface OperationPresentation<Facts> {
  readonly text: string;
  readonly facts: Facts;
}

/* ------------------------------------------------------------------ */
/* agent_start                                                         */
/* ------------------------------------------------------------------ */

/** The unknown-agent diagnostic, which needs to name what does exist. */
export function formatUnknownAgent(
  agent: string,
  available: readonly string[],
): string {
  return unknownAgentSentence(agent, available);
}

/** Present one start outcome as one text-and-facts answer. */
export function presentStartOutcome(
  agent: string,
  outcome: StartOutcome,
  available: readonly string[],
): OperationPresentation<StartToolRowFacts> {
  return {
    text: startOutcomeSentence(agent, outcome, available),
    facts: startToolRowFacts(agent, outcome),
  };
}

/* ------------------------------------------------------------------ */
/* agent_resume                                                        */
/* ------------------------------------------------------------------ */

/** Present one resume outcome as one text-and-facts answer. */
export function presentResumeOutcome(
  subagentId: SubagentId,
  outcome: ResumeOutcome,
): OperationPresentation<ResumeToolRowFacts> {
  return {
    text: resumeOutcomeSentence(subagentId, outcome),
    facts: resumeToolRowFacts(outcome),
  };
}

/* ------------------------------------------------------------------ */
/* agent_steer                                                         */
/* ------------------------------------------------------------------ */

/** Present one steer outcome as one text-and-facts answer. */
export function presentSteerOutcome(
  runId: RunId,
  outcome: SteerOutcome,
): OperationPresentation<SteerToolRowFacts> {
  return {
    text: steerOutcomeSentence(runId, outcome),
    facts: steerToolRowFacts(runId, outcome),
  };
}

/* ------------------------------------------------------------------ */
/* agent_cancel                                                        */
/* ------------------------------------------------------------------ */

export interface CancelPresentation {
  readonly text: string;
  readonly facts: CancelToolRowFacts;
}

/**
 * `agent_cancel`, grouped by what happened rather than listed per id.
 *
 * Cancelling ten Runs and reading ten sentences is worse than reading four
 * groups, and the grouping is what makes the one distinction that matters
 * legible: an admitted *request* is not a terminal cancellation, and the
 * notice that arrives later is. This is the operation's one presentation
 * call: prose and facts are made from the same outcomes together.
 */
export function presentCancelOutcomes(
  outcomes: readonly CancelOutcome[],
): CancelPresentation {
  const facts = cancelToolRowFacts(outcomes);
  const parts = cancelBuckets(facts).map((bucket): string => {
    switch (bucket.kind) {
      case "requested":
        return (
          `${bucket.rowPhrase}: ${bucket.runIds.join(", ")}. Each Run stops when ` +
          "its execution and cleanup finish, or settles cancelled once its cleanup " +
          "outlives the cleanup budget; it keeps whatever output it produced and " +
          "still sends its own notification."
        );
      case "already requested":
        return (
          `${bucket.rowPhrase}: ${bucket.runIds.join(", ")}. The first request stands ` +
          "and this one changed nothing."
        );
      case "already terminal":
        return `${bucket.rowPhrase}: ${bucket.runs
          .map((entry) => `${entry.runId} (${entry.phase})`)
          .join(", ")}.`;
      case "unknown":
        return `${bucket.rowPhrase}: ${bucket.runIds.join(", ")}.`;
      default:
        return unreachable(bucket);
    }
  });
  if (parts.length === 0) {
    parts.push(CANCEL_BUCKET_PRESENTATION.empty.rowPhrase);
  }
  return { text: parts.join(" "), facts };
}

/* ------------------------------------------------------------------ */
/* agent_wait and agent_wait_all                                       */
/* ------------------------------------------------------------------ */

/**
 * What a wait says about a terminal Run whose output the store has let go.
 *
 * The same fact `agent_result` reports as `ResultExpired`, in the wait's own
 * grammar: the Run is named by agent and status like every other terminal
 * Run, and the sentence says the output is gone rather than leaving a card
 * missing.
 */
const OUTPUT_EVICTED =
  "its output was evicted to keep this Session's result store bounded and " +
  "cannot be recovered.";

/**
 * What a wait says when it waited the whole way and nothing is left over.
 *
 * Every other path explains the wait's own outcome: it gave up, the ids were
 * unknown, no ids were given. The successful path explained nothing, and left
 * a reader to infer from the absence of a complaint that the call had
 * returned at all — an inference a reader can fail to make, and then the only
 * remaining reading is that the wait is still blocking, which is the one
 * thing a returned wait is not.
 *
 * One line inside the width an expanded Tool row is drawn at, because a
 * sentence whose whole job is to be read at a glance should not be the one
 * that wraps.
 */
export const WAIT_RETURNED =
  "This wait has returned: every Run it covered is terminal, nothing outstanding.";

/**
 * A wait, which delivers the Result of each Run it waited for.
 *
 * A terminal Run that still has its Result renders as the same card
 * `agent_result` returns — identity, cost, recent transcript, and the answer —
 * so the parent has nothing further to fetch
 * ([ADR-0036](../../../docs/adr/0036-a-wait-delivers-the-result-it-waited-for.md)).
 * One whose output was evicted is named by agent and status and told so.
 *
 * `agents` supplies the Profile name behind each Run id for the outcomes that
 * carry no Result, so a barrier over several agents still reads as a list of
 * specialists. An id the Session no longer names is reported by id alone,
 * which is honest rather than blank.
 *
 * {@link WAIT_RETURNED} closes a wait that left nothing behind, in the same
 * trailing position every other sentence about the wait itself occupies. It
 * is the last thing before the parent's own next turn, which is where a
 * reader deciding whether it may speak yet is looking.
 */
export function formatWaitOutcomes(
  outcomes: readonly WaitOutcome[],
  agents: ReadonlyMap<RunId, string> = new Map(),
): string {
  const terminal: string[] = [];
  const stillRunning: RunId[] = [];
  const unknown: RunId[] = [];

  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "terminal": {
        if (outcome.result !== undefined) {
          terminal.push(formatResult(outcome.result));
          break;
        }
        const agent = agents.get(outcome.runId);
        // The reason is part of the lifecycle state rather than an extra: a
        // Run cancelled at shutdown and a Run cancelled on request stopped
        // for different reasons, and only one of them is the caller's own.
        const status =
          outcome.cancellationReason === undefined
            ? outcome.status
            : `${outcome.status} (${outcome.cancellationReason})`;
        terminal.push(
          agent === undefined
            ? `${outcome.runId}: ${status}, but ${OUTPUT_EVICTED}`
            : `${agent} (${outcome.runId}): ${status}, but ${OUTPUT_EVICTED}`,
        );
        break;
      }
      case "still running":
        stillRunning.push(outcome.runId);
        break;
      case "unknown Run":
        unknown.push(outcome.runId);
        break;
      default:
        unreachable(outcome);
    }
  }

  const outstanding = stillRunning.length > 0 || unknown.length > 0;
  const sections = [...terminal];
  if (stillRunning.length > 0) {
    sections.push(
      `Still running: ${stillRunning.join(", ")}. The wait gave up, not the ` +
        "Runs: each keeps going and notifies on its own, so do not " +
        "immediately wait on the same ids again.",
    );
  }
  if (unknown.length > 0) {
    sections.push(`Unknown run ids: ${unknown.join(", ")}.`);
  }
  if (terminal.length > 0 && !outstanding) sections.push(WAIT_RETURNED);
  if (sections.length === 0) sections.push("No run ids were given.");
  return sections.join("\n\n");
}

/**
 * `agent_wait_all` when nothing is active.
 *
 * Says where the answers went rather than showing an empty list: every Run
 * that finished before the call was announced by its own notification, so a
 * parent that expected something here has already been given it, or is about
 * to be.
 */
export function formatNoActiveRuns(): string {
  return (
    "No Runs are active in this Session. Every Run started here has already " +
    "finished and is announced by its own completion notice; use agent_result " +
    "with a Run id to re-read one."
  );
}

export interface WaitPresentation {
  readonly text: string;
  readonly facts: CollectedRunsToolRowFacts;
}

export type WaitPresentationRequest =
  | {
      readonly scope: "named" | "all-active";
      readonly outcomes: readonly WaitOutcome[];
      readonly agents?: ReadonlyMap<RunId, string>;
    }
  | {
      readonly scope: "all-active";
      readonly noActiveRuns: true;
    };

/**
 * Present any wait path as one text-and-facts answer.
 *
 * The façade chooses which Runs to wait for and independently states which
 * Results it delivered. This function owns only the two presentation values,
 * built together so their collection cannot drift.
 */
export function presentWait(
  request: WaitPresentationRequest,
): WaitPresentation {
  if ("noActiveRuns" in request) {
    return {
      text: formatNoActiveRuns(),
      facts: noActiveWaitAllToolRowFacts(),
    };
  }
  return {
    text: formatWaitOutcomes(request.outcomes, request.agents),
    facts:
      request.scope === "named"
        ? waitToolRowFacts(request.outcomes)
        : waitAllToolRowFacts(request.outcomes),
  };
}

/* ------------------------------------------------------------------ */
/* agent_result                                                        */
/* ------------------------------------------------------------------ */

/**
 * The three `agent_result` outcomes that are not the Result.
 *
 * A spent identifier and a wrong identifier are different mistakes, and this
 * is where they read differently. Rendering the Result itself is
 * {@link formatResult} in the result-body module, because it is a body rather
 * than a sentence.
 */
export function formatResultRejection(
  outcome: Exclude<ResultOutcome, { outcome: "result" }>,
): string {
  return resultOutcomeSentence(outcome);
}

export interface ResultPresentation {
  readonly text: string;
  readonly facts: ResultToolRowFacts;
}

/** Present one Result retrieval as one text-and-facts answer. */
export function presentResultOutcome(
  outcome: ResultOutcome,
): ResultPresentation {
  return {
    text: resultOutcomeSentence(outcome),
    facts: resultToolRowFacts(outcome),
  };
}

/* ------------------------------------------------------------------ */
/* The host boundary's own two sentences                               */
/* ------------------------------------------------------------------ */

/**
 * What a tool says when there is no live Session runtime to answer it.
 *
 * This is the teardown race, and it is a message rather than a crash: a tool
 * call can arrive between a Session ending and the next one starting, and Pi
 * registers tools once per process, so the handler exists whether or not a
 * runtime does.
 */
export function formatSessionNotReady(tool: string): string {
  return (
    `Cannot run ${tool}: this Session has no subagent runtime, so nothing ` +
    "was started. That happens only while a Session is starting or shutting " +
    "down; try again once it is ready."
  );
}

/**
 * How a Session start names the Profile files it could not use.
 *
 * A broken Profile has to be visible without opening a log: a user who wrote
 * one and got silence would conclude the feature does not work. One line per
 * diagnostic, in the same shape `agent_start` uses, because a Profile with two
 * mistakes should be fixable in one pass.
 */
export function formatInvalidProfilesWarning(
  diagnostics: readonly ProfileDiagnostic[],
): string {
  return [
    "Invalid subagent Profiles were skipped:",
    ...formatProfileDiagnosticLines(diagnostics),
  ].join("\n");
}

/**
 * What a tool says when its arguments did not decode.
 *
 * `detail` names the field and the rule it broke and carries no part of the
 * value — Effect Schema's messages are value-free, which was the M2 spike's
 * gating question. The caller bounds it before it gets here.
 */
export function formatToolInputRejected(tool: string, detail: string): string {
  return (
    `Cannot run ${tool}: its arguments were not usable. ${detail}. Nothing ` +
    "was started. Correct the arguments and call it again."
  );
}
