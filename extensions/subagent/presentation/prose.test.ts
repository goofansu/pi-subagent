import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANCEL_OUTCOMES,
  type CancelOutcome,
  RESULT_OUTCOMES,
  RESUME_OUTCOMES,
  type ResumeOutcome,
  redactedDiagnostic,
  runDiagnostic,
  runId,
  START_OUTCOMES,
  STEER_OUTCOMES,
  type StartOutcome,
  type SteerOutcome,
  subagentId,
  WAIT_OUTCOMES,
  type WaitOutcome,
} from "../domain/index.ts";
import { fixtureResult } from "../testing/presentation-fixtures.ts";
import {
  formatCancelOutcomes,
  formatNoActiveRuns,
  formatResultRejection,
  formatResumeOutcome,
  formatStartOutcome,
  formatSteerOutcome,
  formatToolInputRejected,
  formatUnknownAgent,
  formatWaitOutcomes,
} from "./prose.ts";
import { formatResult } from "./run-card.ts";

const RUN = runId("run-1");
const OTHER_RUN = runId("run-2");
const SUBAGENT = subagentId("subagent-1");
const AVAILABLE = ["explore", "review"];

/**
 * Every variant of every union has a sentence.
 *
 * The union's own outcome-name list is the source of truth, so a union that
 * gains a member fails here as well as failing to compile in the formatter.
 * The two checks are not redundant: the compiler catches a missing `case`,
 * and this catches a `case` that returns something empty.
 */
function coversEveryOutcome(
  names: readonly string[],
  rendered: ReadonlyMap<string, string>,
): void {
  assert.deepEqual([...rendered.keys()].sort(), [...names].sort());
  for (const [name, text] of rendered) {
    assert.ok(text.length > 0, `${name} rendered nothing`);
  }
}

// ── agent_start ──────────────────────────────────────────────────────────────

test("agent_start renders the started ids as prose a model can act on", () => {
  const outcome: StartOutcome = {
    outcome: "started",
    runId: RUN,
    subagentId: SUBAGENT,
  };

  assert.equal(
    formatStartOutcome("explore", outcome, AVAILABLE),
    "Started explore:\n" +
      "subagent id subagent-1\n" +
      "run id run-1\n\n" +
      "Use run id run-1 for agent_wait, agent_result, agent_cancel, and " +
      "agent_steer. Its completion is delivered to you automatically when " +
      "the Run finishes; continue independent work until then, and wait only " +
      "if nothing else remains.",
  );
});

test("agent_start has one sentence per rejection, naming what to do next", () => {
  const rendered = new Map<string, string>();
  const outcomes: StartOutcome[] = [
    { outcome: "started", runId: RUN, subagentId: SUBAGENT },
    { outcome: "unknown agent", agent: "ghost" },
    {
      outcome: "invalid profile",
      diagnostics: [
        { filePath: "/agents/broken.md", reason: "no description" },
      ],
    },
    { outcome: "empty label" },
    { outcome: "at capacity" },
    { outcome: "shutting down" },
    { outcome: "delegation-depth exceeded", depth: 2 },
    {
      outcome: "backend unavailable",
      diagnostic: redactedDiagnostic("backend-failure"),
    },
  ];
  for (const outcome of outcomes) {
    rendered.set(
      outcome.outcome,
      formatStartOutcome("explore", outcome, AVAILABLE),
    );
  }

  coversEveryOutcome(START_OUTCOMES, rendered);
  assert.equal(
    rendered.get("unknown agent"),
    'Unknown agent: "ghost". Available: explore, review',
  );
  assert.equal(
    rendered.get("invalid profile"),
    "Cannot start explore: its Profile is not usable. Nothing was started.\n" +
      "- /agents/broken.md: no description",
  );
  assert.equal(
    rendered.get("at capacity"),
    "Cannot start explore: this Session is already running as many Subagent " +
      "Runs as it allows. Nothing was queued and no Run was started. Wait for " +
      "a Run to finish, or cancel one, then try again.",
  );
  assert.equal(
    rendered.get("shutting down"),
    "Cannot start explore: this Session is shutting down. No Run was started " +
      "and nothing was queued.",
  );
  assert.equal(
    rendered.get("delegation-depth exceeded"),
    "Cannot start explore: delegation is already 2 levels deep, which is as " +
      "far as it goes. No Run was started. Do this work directly instead of " +
      "delegating it again.",
  );
  assert.equal(
    rendered.get("backend unavailable"),
    "Cannot start explore: its backend could not be opened (backend-failure: " +
      "[redacted]). No Run was started and no id was handed out. Retrying may " +
      "work; a different agent will work if this backend is down.",
  );
});

test("an empty catalog says so rather than naming nothing", () => {
  assert.equal(
    formatUnknownAgent("ghost", []),
    'Unknown agent: "ghost". Available: none',
  );
});

test("a backend diagnostic authored by the core keeps its message", () => {
  assert.match(
    formatStartOutcome(
      "explore",
      {
        outcome: "backend unavailable",
        diagnostic: runDiagnostic(
          "backend-failure",
          "the backend did not open within 30000ms",
        ),
      },
      AVAILABLE,
    ),
    /\(backend-failure: the backend did not open within 30000ms\)/,
  );
});

// ── agent_resume ─────────────────────────────────────────────────────────────

test("agent_resume renders unknown, running, empty, unsupported, lost, capacity, and shutdown distinctly", () => {
  const rendered = new Map<string, string>();
  const outcomes: ResumeOutcome[] = [
    { outcome: "started", runId: RUN, subagentId: SUBAGENT },
    { outcome: "unknown Subagent", subagentId: SUBAGENT },
    { outcome: "Subagent already running", subagentId: SUBAGENT },
    { outcome: "empty label" },
    { outcome: "resume unsupported" },
    { outcome: "conversation lost" },
    { outcome: "at capacity" },
    { outcome: "shutting down" },
  ];
  for (const outcome of outcomes) {
    rendered.set(outcome.outcome, formatResumeOutcome(SUBAGENT, outcome));
  }

  coversEveryOutcome(RESUME_OUTCOMES, rendered);
  assert.equal(
    rendered.get("started"),
    "Resumed subagent subagent-1:\n" +
      "run id run-1\n\n" +
      "agent_resume returns immediately, not with the answer. Use run id " +
      "run-1 for agent_wait, agent_result, agent_cancel, and agent_steer. Its " +
      "completion is delivered to you automatically when the Run finishes; " +
      "continue independent work until then, and wait only if nothing else " +
      "remains.",
  );
  assert.equal(
    rendered.get("unknown Subagent"),
    "Cannot resume subagent subagent-1: unknown Subagent. Use a Subagent id " +
      "returned by agent_start in this Session, not a Run id.",
  );
  assert.equal(
    rendered.get("Subagent already running"),
    "Cannot resume subagent subagent-1: it already has an active Run. The " +
      "request was not queued and no provider work was started. Wait for that " +
      "Run to finish, then resume.",
  );
  assert.equal(
    rendered.get("resume unsupported"),
    "Cannot resume subagent subagent-1: its backend does not support resume. " +
      "No Run or provider work was started. Start a new Subagent to continue " +
      "this work.",
  );
  assert.equal(
    rendered.get("conversation lost"),
    "Cannot resume subagent subagent-1: its Conversation was lost. No Run or " +
      "provider work was started. Start a new Subagent to continue.",
  );
  assert.equal(
    rendered.get("at capacity"),
    "Cannot resume subagent subagent-1: this Session is already running as " +
      "many Subagent Runs as it allows. Nothing was queued. Wait for a Run to " +
      "finish, or cancel one, then try again.",
  );
  assert.equal(
    rendered.get("shutting down"),
    "Cannot resume subagent subagent-1: this Session is shutting down. No Run " +
      "was started and nothing was queued.",
  );
});

// ── agent_steer ──────────────────────────────────────────────────────────────

test("agent_steer states that acceptance is local admission only", () => {
  const accepted = formatSteerOutcome(RUN, { outcome: "accepted", runId: RUN });

  assert.equal(
    accepted,
    "Steering accepted for run run-1. The complete message was synchronously " +
      "admitted to this Run's local bounded mailbox, and that is all " +
      "acceptance means: it does not mean the backend dequeued it, a provider " +
      "accepted it, or a model consumed it. Do not resend this steering " +
      "message in a retry loop.",
  );
});

test("agent_steer uses the mailbox vocabulary and covers every outcome", () => {
  const rendered = new Map<string, string>();
  const outcomes: SteerOutcome[] = [
    { outcome: "accepted", runId: RUN },
    { outcome: "mailbox full", runId: RUN },
    {
      outcome: "invalid",
      reason:
        "a Control must be non-empty text within the per-message byte bound",
    },
    { outcome: "unsupported", runId: RUN },
    { outcome: "mailbox closed", runId: RUN },
    { outcome: "already completed", runId: RUN },
    { outcome: "already failed", runId: RUN },
    { outcome: "already cancelled", runId: RUN },
    { outcome: "unknown Run", runId: RUN },
    { outcome: "shutting down" },
  ];
  for (const outcome of outcomes) {
    rendered.set(outcome.outcome, formatSteerOutcome(RUN, outcome));
  }

  coversEveryOutcome(STEER_OUTCOMES, rendered);
  assert.equal(
    rendered.get("mailbox full"),
    "Cannot steer run run-1: its Control mailbox is full. Nothing was " +
      "truncated and nothing was dropped silently. Do not retry steering in a " +
      "loop.",
  );
  assert.equal(
    rendered.get("mailbox closed"),
    "Cannot steer run run-1: its Control mailbox is closed. The Run is " +
      "settling, was cancelled, or the Session is shutting down.",
  );
  assert.equal(
    rendered.get("invalid"),
    "Cannot steer run run-1: invalid message — a Control must be non-empty " +
      "text within the per-message byte bound.",
  );
  assert.equal(
    rendered.get("unsupported"),
    "Cannot steer run run-1: its backend declared no steering Control. No " +
      "message was admitted, and no later attempt on this Run will be.",
  );
  assert.equal(
    rendered.get("already failed"),
    "Cannot steer run run-1: it is already failed. Use agent_result with that " +
      "Run id to read what it produced.",
  );
  assert.equal(
    rendered.get("unknown Run"),
    "Cannot steer run run-1: unknown Run. Check the id against what " +
      "agent_start or agent_resume returned.",
  );
  assert.equal(
    rendered.get("shutting down"),
    "Cannot steer run run-1: this Session is shutting down. No message was " +
      "admitted.",
  );
});

// ── agent_cancel ─────────────────────────────────────────────────────────────

test("agent_cancel separates request, idempotence, terminal, and unknown", () => {
  const outcomes: CancelOutcome[] = [
    { outcome: "admitted", runId: RUN },
    { outcome: "idempotent", runId: OTHER_RUN },
    { outcome: "already completed", runId: runId("run-3") },
    { outcome: "unknown Run", runId: runId("run-4") },
  ];

  assert.equal(
    formatCancelOutcomes(outcomes),
    "Cancellation requested: run-1. Each Run stops when its execution and " +
      "cleanup finish, keeps whatever output it produced, and still sends its " +
      "own notification. " +
      "Already cancelling: run-2. The first request stands and this one " +
      "changed nothing. " +
      "Already finished, result kept: run-3 (completed). " +
      "Unknown run ids: run-4.",
  );
});

test("agent_cancel covers every outcome and every terminal status", () => {
  const rendered = new Map<string, string>();
  const outcomes: CancelOutcome[] = [
    { outcome: "admitted", runId: RUN },
    { outcome: "idempotent", runId: RUN },
    { outcome: "already completed", runId: RUN },
    { outcome: "already failed", runId: RUN },
    { outcome: "already cancelled", runId: RUN },
    { outcome: "unknown Run", runId: RUN },
  ];
  for (const outcome of outcomes) {
    rendered.set(outcome.outcome, formatCancelOutcomes([outcome]));
  }

  coversEveryOutcome(CANCEL_OUTCOMES, rendered);
  assert.match(rendered.get("already failed") ?? "", /run-1 \(failed\)/);
  assert.match(rendered.get("already cancelled") ?? "", /run-1 \(cancelled\)/);
});

test("agent_cancel with no ids says so", () => {
  assert.equal(formatCancelOutcomes([]), "No run ids were given.");
});

// ── agent_wait and agent_wait_all ────────────────────────────────────────────

const EVICTED =
  "but its output was evicted to keep this Session's result store bounded " +
  "and cannot be recovered.";

test("a wait delivers each terminal Run's Result as the card agent_result returns", () => {
  const result = fixtureResult({ finalOutput: "the answer" });
  const outcomes: WaitOutcome[] = [
    { outcome: "terminal", runId: RUN, status: "completed", result },
    { outcome: "still running", runId: OTHER_RUN },
    { outcome: "unknown Run", runId: runId("run-3") },
  ];

  assert.equal(
    formatWaitOutcomes(outcomes, new Map([[RUN, "explore"]])),
    `${formatResult(result)}\n\n` +
      "Still running: run-2. The wait gave up, not the Runs: each keeps going " +
      "and notifies on its own, so do not immediately wait on the same ids " +
      "again.\n\n" +
      "Unknown run ids: run-3.",
  );
  assert.match(formatWaitOutcomes(outcomes), /the answer$/m);
});

test("a wait names an evicted Run by agent and status, and says its output is gone", () => {
  // v1 rendered `cancelled (requested)` and `cancelled (shutdown)`, and the
  // two are different facts: only one of them is something the caller asked
  // for. A completed Run has no reason and must not grow a parenthesis.
  assert.equal(
    formatWaitOutcomes(
      [
        {
          outcome: "terminal",
          runId: RUN,
          status: "cancelled",
          cancellationReason: "requested",
        },
        {
          outcome: "terminal",
          runId: OTHER_RUN,
          status: "cancelled",
          cancellationReason: "shutdown",
        },
      ],
      new Map([
        [RUN, "explore"],
        [OTHER_RUN, "librarian"],
      ]),
    ),
    `explore (run-1): cancelled (requested), ${EVICTED}\n\n` +
      `librarian (run-2): cancelled (shutdown), ${EVICTED}`,
  );
  assert.equal(
    formatWaitOutcomes([
      { outcome: "terminal", runId: RUN, status: "completed" },
    ]),
    `run-1: completed, ${EVICTED}`,
  );
});

test("a wait covers every outcome and reports an unnamed Run by id", () => {
  const rendered = new Map<string, string>();
  const outcomes: WaitOutcome[] = [
    { outcome: "terminal", runId: RUN, status: "failed" },
    { outcome: "still running", runId: RUN },
    { outcome: "unknown Run", runId: RUN },
  ];
  for (const outcome of outcomes) {
    rendered.set(outcome.outcome, formatWaitOutcomes([outcome]));
  }

  coversEveryOutcome(WAIT_OUTCOMES, rendered);
  assert.equal(rendered.get("terminal"), `run-1: failed, ${EVICTED}`);
});

test("a wait with no ids says so, and a wait-all with nothing active says where the answers went", () => {
  assert.equal(formatWaitOutcomes([]), "No run ids were given.");
  assert.equal(
    formatNoActiveRuns(),
    "No Runs are active in this Session. Every Run started here has already " +
      "finished and is announced by its own completion notice; use " +
      "agent_result with a Run id to re-read one.",
  );
});

// ── agent_result ─────────────────────────────────────────────────────────────

test("a spent id and a wrong id read differently", () => {
  const expired = formatResultRejection({
    outcome: "ResultExpired",
    runId: RUN,
    subagentId: SUBAGENT,
    status: "completed",
  });
  const unknown = formatResultRejection({ outcome: "unknown Run", runId: RUN });

  assert.equal(
    expired,
    "Run run-1 (subagent subagent-1) completed, but its output was evicted to " +
      "keep this Session's result store bounded. The Run is still known and " +
      "its status still answers; the output itself is gone and cannot be " +
      "recovered.",
  );
  assert.equal(
    unknown,
    "No run with id run-1. Check the id against what agent_start or " +
      "agent_resume returned.",
  );
  assert.notEqual(expired, unknown);
});

test("agent_result covers every rejection, and the union's fourth member is the Result", () => {
  const rendered = new Map<string, string>([
    [
      "ResultExpired",
      formatResultRejection({
        outcome: "ResultExpired",
        runId: RUN,
        subagentId: SUBAGENT,
        status: "cancelled",
      }),
    ],
    [
      "RunNotTerminal",
      formatResultRejection({ outcome: "RunNotTerminal", runId: RUN }),
    ],
    [
      "unknown Run",
      formatResultRejection({ outcome: "unknown Run", runId: RUN }),
    ],
  ]);

  coversEveryOutcome(
    RESULT_OUTCOMES.filter((name) => name !== "result"),
    rendered,
  );
  assert.equal(
    rendered.get("RunNotTerminal"),
    "Run run-1 has not finished yet, so it has no result. Its completion is " +
      "delivered to you on its own; agent_wait blocks until then and returns " +
      "the result directly.",
  );
});

test("a start and a resume refuse an empty description in their own family's words", () => {
  // The lower half of the label bound. There is nothing to shorten and nothing
  // honest to invent, so this branch of contributing invariant 11 refuses with
  // a typed outcome — and it says what to send instead, because a model that
  // reads "empty" and not "send one" has no next move.
  assert.equal(
    formatStartOutcome("explore", { outcome: "empty label" }, AVAILABLE),
    "Cannot start explore: its description is empty. No Run was started and " +
      "no id was handed out. Send a one-line description of the task: it is " +
      "the label this Run is shown under everywhere.",
  );
  assert.equal(
    formatResumeOutcome(SUBAGENT, { outcome: "empty label" }),
    "Cannot resume subagent subagent-1: its description is empty. No Run was " +
      "started and nothing was queued. Send a one-line description of this " +
      "Run: it is the label this Run is shown under everywhere.",
  );
});

test("a rejected tool call names the field, says nothing started, and says what to do", () => {
  // A decode failure is a tool *outcome* rather than a throw, so this sentence
  // is what a model sees and what a session log records. It is the one
  // sentence here that no outcome union reaches, which is why it is asserted
  // on its own rather than through a union's coverage check.
  assert.equal(
    formatToolInputRejected("agent_start", "description must be a string"),
    "Cannot run agent_start: its arguments were not usable. description " +
      "must be a string. Nothing was started. Correct the arguments and call " +
      "it again.",
  );

  // The detail is the caller's, already bounded and value-free, and it is
  // placed rather than interpreted: a formatter that reworded it would be a
  // second opinion on what the schema said.
  assert.equal(
    formatToolInputRejected("agent_wait", "ids must have at least one entry"),
    "Cannot run agent_wait: its arguments were not usable. ids must have at " +
      "least one entry. Nothing was started. Correct the arguments and call " +
      "it again.",
  );
});
