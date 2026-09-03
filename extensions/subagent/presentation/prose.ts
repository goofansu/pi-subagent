/**
 * Every model-facing sentence about a Run.
 *
 * The six operation outcome unions are transcribed from
 * `docs/v2/operation-semantics.md`, and every variant of every one of them has
 * exactly one sentence here. Nothing else in v2 writes prose about a Run: the
 * façade maps outcomes to these functions, and the host handlers pass the
 * result through. That is what stops the same rejection reading two different
 * ways in two different places, which is what happened in v1 whenever a new
 * caller needed a message and wrote its own.
 *
 * Exhaustiveness is a compile error rather than a review note. Each formatter
 * switches on the union's discriminant and ends at {@link unreachable}, so a
 * variant added to a union with no sentence for it fails to build.
 *
 * The wording is ported from v1 where v1 had a sentence, so a model that
 * learned v1's rhythm reads the same answers. The v2-only variants — `at
 * capacity`, `shutting down`, `backend unavailable`, `mailbox full`, `mailbox
 * closed`, `ResultExpired`, `RunNotTerminal`, `idempotent` — are written here
 * for the first time, and each one says what the caller should do next,
 * because a rejection a model cannot act on is a rejection it will retry.
 */

import type {
  CancelOutcome,
  ProfileDiagnostic,
  ResultOutcome,
  ResumeOutcome,
  RunDiagnostic,
  RunId,
  StartOutcome,
  SteerOutcome,
  SubagentId,
  WaitOutcome,
} from "../domain/index.ts";

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

/** How every operation points a caller at the Run it just heard about. */
function runPointer(runId: RunId): string {
  return (
    `Use run id ${runId} for agent_wait, agent_result, agent_cancel, and ` +
    "agent_steer."
  );
}

/** How a notice-bearing operation tells a caller not to poll. */
const NOTIFICATION_PROMISE =
  "Its notification will arrive when the Run finishes; carry on until then.";

/**
 * Profile diagnostics as one line each.
 *
 * Shared by the two places a user or a model is told a Profile does not work —
 * `agent_start`'s `invalid profile` rejection and the Session's start-up
 * warning — because the same fact read two ways in two places is how a reader
 * ends up unsure whether they are the same fact.
 */
function diagnosticLines(
  diagnostics: readonly ProfileDiagnostic[],
): readonly string[] {
  return diagnostics.map(
    (diagnostic) => `- ${diagnostic.filePath}: ${diagnostic.reason}`,
  );
}

/** A backend diagnostic as one clause. The category is the useful part. */
function describeDiagnostic(diagnostic: RunDiagnostic): string {
  return `${diagnostic.category}: ${diagnostic.message}`;
}

/* ------------------------------------------------------------------ */
/* agent_start                                                         */
/* ------------------------------------------------------------------ */

/** The unknown-agent diagnostic, which needs to name what does exist. */
export function formatUnknownAgent(
  agent: string,
  available: readonly string[],
): string {
  return `Unknown agent: "${agent}". Available: ${available.join(", ") || "none"}`;
}

/**
 * `agent_start`, as prose.
 *
 * `available` is the Profile catalog's list, needed by exactly one variant and
 * passed in rather than looked up, because presentation reads no services.
 */
export function formatStartOutcome(
  agent: string,
  outcome: StartOutcome,
  available: readonly string[],
): string {
  switch (outcome.outcome) {
    case "started":
      return (
        `Started ${agent}:\nsubagent id ${outcome.subagentId}\n` +
        `run id ${outcome.runId}\n\n` +
        `${runPointer(outcome.runId)} ${NOTIFICATION_PROMISE}`
      );
    case "unknown agent":
      return formatUnknownAgent(outcome.agent, available);
    case "invalid profile":
      return [
        `Cannot start ${agent}: its Profile is not usable. Nothing was started.`,
        ...diagnosticLines(outcome.diagnostics),
      ].join("\n");
    case "at capacity":
      return (
        `Cannot start ${agent}: this Session is already running as many ` +
        "Subagent Runs as it allows. Nothing was queued and no Run was " +
        "started. Wait for a Run to finish, or cancel one, then try again."
      );
    case "shutting down":
      return (
        `Cannot start ${agent}: this Session is shutting down. No Run was ` +
        "started and nothing was queued."
      );
    case "delegation-depth exceeded":
      return (
        `Cannot start ${agent}: delegation is already ${outcome.depth} ` +
        "levels deep, which is as far as it goes. No Run was started. Do this " +
        "work directly instead of delegating it again."
      );
    case "backend unavailable":
      return (
        `Cannot start ${agent}: its backend could not be opened ` +
        `(${describeDiagnostic(outcome.diagnostic)}). No Run was started and ` +
        "no id was handed out. Retrying may work; a different agent will work " +
        "if this backend is down."
      );
    default:
      return unreachable(outcome);
  }
}

/* ------------------------------------------------------------------ */
/* agent_resume                                                        */
/* ------------------------------------------------------------------ */

export function formatResumeOutcome(
  subagentId: SubagentId,
  outcome: ResumeOutcome,
): string {
  switch (outcome.outcome) {
    case "started":
      return (
        `Resumed subagent ${subagentId}:\nrun id ${outcome.runId}\n\n` +
        "agent_resume returns immediately, not with the answer. " +
        `${runPointer(outcome.runId)} ${NOTIFICATION_PROMISE}`
      );
    case "unknown Subagent":
      return (
        `Cannot resume subagent ${outcome.subagentId}: unknown Subagent. ` +
        "Use a Subagent id returned by agent_start in this Session, not a Run id."
      );
    case "Subagent already running":
      return (
        `Cannot resume subagent ${outcome.subagentId}: it already has an ` +
        "active Run. The request was not queued and no provider work was " +
        "started. Wait for that Run to finish, then resume."
      );
    case "resume unsupported":
      return (
        `Cannot resume subagent ${subagentId}: its backend does not support ` +
        "resume. No Run or provider work was started. Start a new Subagent to " +
        "continue this work."
      );
    case "conversation lost":
      return (
        `Cannot resume subagent ${subagentId}: its Conversation was lost. ` +
        "No Run or provider work was started. Start a new Subagent to continue."
      );
    case "at capacity":
      return (
        `Cannot resume subagent ${subagentId}: this Session is already ` +
        "running as many Subagent Runs as it allows. Nothing was queued. Wait " +
        "for a Run to finish, or cancel one, then try again."
      );
    case "shutting down":
      return (
        `Cannot resume subagent ${subagentId}: this Session is shutting down. ` +
        "No Run was started and nothing was queued."
      );
    default:
      return unreachable(outcome);
  }
}

/* ------------------------------------------------------------------ */
/* agent_steer                                                         */
/* ------------------------------------------------------------------ */

/**
 * The whole point of `accepted`, said every time it is reported.
 *
 * Operation semantics section 7 is emphatic that acceptance is a statement
 * about the local mailbox and nothing else, and a caller that reads it as
 * confirmation retries in a loop. So the sentence is part of the outcome
 * rather than a note in the tool description a model may not still have.
 */
const LOCAL_ADMISSION_ONLY =
  "The complete message was synchronously admitted to this Run's local " +
  "bounded mailbox, and that is all acceptance means: it does not mean the " +
  "backend dequeued it, a provider accepted it, or a model consumed it. Do " +
  "not resend this steering message in a retry loop.";

export function formatSteerOutcome(
  runId: RunId,
  outcome: SteerOutcome,
): string {
  switch (outcome.outcome) {
    case "accepted":
      return `Steering accepted for run ${outcome.runId}. ${LOCAL_ADMISSION_ONLY}`;
    case "mailbox full":
      return (
        `Cannot steer run ${outcome.runId}: its Control mailbox is full. ` +
        "Nothing was truncated and nothing was dropped silently. Do not retry " +
        "steering in a loop."
      );
    case "invalid":
      return `Cannot steer run ${runId}: invalid message — ${outcome.reason}.`;
    case "unsupported":
      return (
        `Cannot steer run ${outcome.runId}: its backend declared no steering ` +
        "Control. No message was admitted, and no later attempt on this Run " +
        "will be."
      );
    case "mailbox closed":
      return (
        `Cannot steer run ${outcome.runId}: its Control mailbox is closed. ` +
        "The Run is settling, was cancelled, or the Session is shutting down."
      );
    case "already completed":
    case "already failed":
    case "already cancelled":
      return (
        `Cannot steer run ${outcome.runId}: it is ${outcome.outcome}. ` +
        "Use agent_result with that Run id to read what it produced."
      );
    case "unknown Run":
      return (
        `Cannot steer run ${outcome.runId}: unknown Run. Check the id against ` +
        "what agent_start or agent_resume returned."
      );
    case "shutting down":
      return (
        `Cannot steer run ${runId}: this Session is shutting down. No message ` +
        "was admitted."
      );
    default:
      return unreachable(outcome);
  }
}

/* ------------------------------------------------------------------ */
/* agent_cancel                                                        */
/* ------------------------------------------------------------------ */

/**
 * `agent_cancel`, grouped by what happened rather than listed per id.
 *
 * Cancelling ten Runs and reading ten sentences is worse than reading four
 * groups, and the grouping is what makes the one distinction that matters
 * legible: an admitted *request* is not a terminal cancellation, and the
 * notice that arrives later is.
 */
export function formatCancelOutcomes(
  outcomes: readonly CancelOutcome[],
): string {
  const admitted: RunId[] = [];
  const idempotent: RunId[] = [];
  const terminal: { readonly runId: RunId; readonly status: string }[] = [];
  const unknown: RunId[] = [];

  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "admitted":
        admitted.push(outcome.runId);
        break;
      case "idempotent":
        idempotent.push(outcome.runId);
        break;
      case "already completed":
      case "already failed":
      case "already cancelled":
        terminal.push({
          runId: outcome.runId,
          status: outcome.outcome.slice("already ".length),
        });
        break;
      case "unknown Run":
        unknown.push(outcome.runId);
        break;
      default:
        unreachable(outcome);
    }
  }

  const parts: string[] = [];
  if (admitted.length > 0) {
    parts.push(
      `Cancellation requested: ${admitted.join(", ")}. Each Run stops when ` +
        "its execution and cleanup finish, keeps whatever output it produced, " +
        "and still sends its own notification.",
    );
  }
  if (idempotent.length > 0) {
    parts.push(
      `Already cancelling: ${idempotent.join(", ")}. The first request stands ` +
        "and this one changed nothing.",
    );
  }
  if (terminal.length > 0) {
    parts.push(
      `Already finished, result kept: ${terminal
        .map((entry) => `${entry.runId} (${entry.status})`)
        .join(", ")}.`,
    );
  }
  if (unknown.length > 0) {
    parts.push(`Unknown run ids: ${unknown.join(", ")}.`);
  }
  if (parts.length === 0) parts.push("No run ids were given.");
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* agent_wait                                                          */
/* ------------------------------------------------------------------ */

/**
 * `agent_wait`, which reports lifecycle state and never output.
 *
 * `agents` supplies the Profile name behind each Run id so a barrier over
 * several agents reads as a list of specialists rather than a list of
 * identifiers. An id the Session no longer names is reported by id alone,
 * which is honest rather than blank.
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
            ? `${outcome.runId}: ${status}`
            : `${agent} (${outcome.runId}): ${status}`,
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
  if (sections.length === 0) sections.push("No run ids were given.");
  return sections.join("\n\n");
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
  switch (outcome.outcome) {
    case "ResultExpired":
      return (
        `Run ${outcome.runId} (subagent ${outcome.subagentId}) ${outcome.status}, ` +
        "but its output was evicted to keep this Session's result store " +
        "bounded. The Run is still known and its status still answers; the " +
        "output itself is gone and cannot be recovered."
      );
    case "RunNotTerminal":
      return (
        `Run ${outcome.runId} has not finished yet, so it has no result. Its ` +
        "notification will arrive on its own, and agent_wait blocks until it " +
        "does."
      );
    case "unknown Run":
      return (
        `No run with id ${outcome.runId}. Check the id against what ` +
        "agent_start or agent_resume returned."
      );
    default:
      return unreachable(outcome);
  }
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
    ...diagnosticLines(diagnostics),
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
