/**
 * `Subagents`: the one thing the host handlers call.
 *
 * Six functions, each of which does exactly three things — map a decoded tool
 * input to a supervisor request, call the supervisor, and hand the outcome to
 * presentation. It owns no state, holds no reference to a Session, and has no
 * fields: every operation is a function of its input, the Session facts the
 * host read at execute time, and the services it declares.
 *
 * The reason for the layer is v1's dispatcher. There, a host handler talked to
 * lifecycle, presentation, and delivery directly, and once three callers could
 * reach the same mutable Run record, no single place knew what a Run looked
 * like. Here the host cannot reach the repository, the store, or a backend at
 * all: it holds a managed runtime and calls these six functions, and the
 * boundary test says so.
 *
 * Nothing here decides what a rejection *says*. The prose lives in
 * presentation, so the same outcome cannot read two ways in two places.
 */

import { Effect } from "effect";
import type { RunId } from "../domain/index.ts";
import {
  type CollectedRuns,
  formatCancelOutcomes,
  formatResult,
  formatResultRejection,
  formatResumeOutcome,
  formatStartOutcome,
  formatSteerOutcome,
  formatWaitOutcomes,
  type ResumedRun,
  summaryOf,
} from "../presentation/index.ts";
import { ProfileCatalog } from "../runtime/profile-catalog.ts";
import { RunRepository } from "../runtime/repository.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import type {
  CancelInput,
  ResultInput,
  ResumeInput,
  SessionFacts,
  StartInput,
  SteerInput,
  WaitInput,
} from "./inputs.ts";

/** What a host handler returns to Pi: text the model reads, plus details. */
export interface ToolResponse {
  readonly text: string;
  /**
   * What the renderer draws the collapsed row from.
   *
   * `undefined` for the operations whose answer is already one line —
   * `agent_cancel` and `agent_steer` — because a summary of a sentence is the
   * sentence.
   */
  readonly details?: CollectedRuns | ResumedRun;
}

/** Every service the façade reaches. Three, and all of them read-mostly. */
export type SubagentsServices =
  | SubagentSupervisor
  | ProfileCatalog
  | RunRepository;

/**
 * Deduplicate while keeping the caller's order.
 *
 * An id named twice produces one observation, which is v1's behaviour and the
 * compatibility matrix's `agent_wait` row.
 */
function distinct(ids: readonly RunId[]): readonly RunId[] {
  return [...new Set(ids)];
}

/** The Profile name behind each of these Run ids, where the Session knows it. */
const agentNamesOf = (
  runIds: readonly RunId[],
): Effect.Effect<ReadonlyMap<RunId, string>, never, RunRepository> =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    const names = new Map<RunId, string>();
    for (const runId of runIds) {
      const snapshot = yield* repository.get(runId);
      if (snapshot) names.set(runId, snapshot.identity.agent);
    }
    return names;
  });

/**
 * `agent_start`.
 *
 * The Session facts are passed in rather than read here: a Run inherits the
 * working directory, the trust posture, and the parent model of the Session
 * that started it, and only the host can see a live Session.
 */
const start = (
  input: StartInput,
  facts: SessionFacts,
): Effect.Effect<ToolResponse, never, SubagentsServices> =>
  Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const profiles = yield* ProfileCatalog;
    const outcome = yield* supervisor.start({
      agent: input.agent,
      description: input.description,
      prompt: input.prompt,
      cwd: facts.cwd,
      childDepth: facts.childDepth,
      projectTrusted: facts.projectTrusted,
      ...(facts.parentModel === undefined
        ? {}
        : { parentModel: facts.parentModel }),
    });
    const available = profiles.list().map((profile) => profile.name);
    return { text: formatStartOutcome(input.agent, outcome, available) };
  });

/** `agent_resume`. A new Run on an idle Subagent, or a typed refusal. */
const resume = (
  input: ResumeInput,
): Effect.Effect<ToolResponse, never, SubagentsServices> =>
  Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const outcome = yield* supervisor.resume({
      subagentId: input.id,
      description: input.description,
      prompt: input.prompt,
    });
    return {
      text: formatResumeOutcome(input.id, outcome),
      ...(outcome.outcome === "started"
        ? {
            details: {
              subagentId: outcome.subagentId,
              runId: outcome.runId,
            } satisfies ResumedRun,
          }
        : {}),
    };
  });

/** `agent_steer`. One message, admitted locally or refused with a reason. */
const steer = (
  input: SteerInput,
): Effect.Effect<ToolResponse, never, SubagentsServices> =>
  Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    // The control is built inline rather than imported: the supervisor's
    // parameter type checks the literal, so the façade needs no edge to the
    // backend contract to say `steer`.
    const outcome = yield* supervisor.steer(input.id, {
      type: "steer",
      text: input.message,
    });
    return { text: formatSteerOutcome(input.id, outcome) };
  });

/** `agent_cancel`. Answers about request admission, never about terminality. */
const cancel = (
  input: CancelInput,
): Effect.Effect<ToolResponse, never, SubagentsServices> =>
  Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const outcomes = yield* supervisor.cancel(distinct(input.ids));
    return { text: formatCancelOutcomes(outcomes) };
  });

/**
 * `agent_wait`. Observes terminality; it never owns a Run.
 *
 * A zero timeout is the answer-now form the host uses when its turn was
 * aborted: the same reading, without waiting for it. That is why the timeout
 * is a number rather than a flag — operation semantics section 6 makes a
 * timeout and an abort behave identically, so they had better be the same
 * code path.
 */
const wait = (
  input: WaitInput,
): Effect.Effect<ToolResponse, never, SubagentsServices> =>
  Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const runIds = distinct(input.ids);
    const outcomes = yield* supervisor.wait(
      runIds,
      input.timeoutSeconds === undefined
        ? undefined
        : Math.max(0, Math.round(input.timeoutSeconds * 1_000)),
    );
    const agents = yield* agentNamesOf(runIds);
    const terminal = outcomes.flatMap((outcome) =>
      outcome.outcome === "terminal"
        ? [
            {
              runId: String(outcome.runId),
              agent: agents.get(outcome.runId) ?? String(outcome.runId),
              status: outcome.status,
            },
          ]
        : [],
    );
    const stillRunning = outcomes.filter(
      (outcome) => outcome.outcome === "still running",
    ).length;
    return {
      text: formatWaitOutcomes(outcomes, agents),
      details: { runs: terminal, stillRunning } satisfies CollectedRuns,
    };
  });

/** `agent_result`. The stored answer, or the reason there is not one. */
const result = (
  input: ResultInput,
): Effect.Effect<ToolResponse, never, SubagentsServices> =>
  Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const outcome = yield* supervisor.result(input.id);
    if (outcome.outcome !== "result") {
      return { text: formatResultRejection(outcome) };
    }
    return {
      text: formatResult(outcome.result),
      details: { runs: [summaryOf(outcome.result)] } satisfies CollectedRuns,
    };
  });

/**
 * The façade.
 *
 * A frozen object of functions rather than a class or a service: there is
 * nothing to construct, nothing to inject, and nothing to keep. A test calls
 * these the same way the host does.
 */
export const Subagents = Object.freeze({
  start,
  resume,
  steer,
  cancel,
  wait,
  result,
});
