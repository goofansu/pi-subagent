/**
 * The conformance rig for the real Claude backend.
 *
 * It builds the actual adapter — the same `createClaudeBackend` the entry
 * point uses — with the stand-in query function injected through the loader
 * the adapter already has for that purpose, and runs the shared suite against
 * it. Nothing about the adapter is stubbed: validation, the identity state
 * machine, the per-Run Query, the client-owned input stream, the steering
 * correlation, the translation, and the cancellation path are all the
 * production code.
 *
 * Two things are rig-side, and both are bookkeeping the contract deliberately
 * has no place for.
 *
 * **The counters.** The suite asks a rig for opens, closes, live executions,
 * live subscriptions, and the Controls the backend received. Opens and
 * effective closes come from the adapter's own tally; the Query counts and the
 * pushed Controls come from the stand-in, which is where they actually are;
 * live executions come from a thin wrapper around `execute`.
 *
 * **The Run correlation.** A Query has no idea which Run it is serving, so the
 * wrapper tells the stand-in when each Run's execution begins and ends.
 *
 * Where a scenario's shape is genuinely different for Claude it is written
 * differently here and the reason is in a comment beside it. Two are worth
 * knowing about before reading:
 *
 * - **A Run with several provider turns is how Claude reaches two result
 *   frames.** The context-gauge scenario needs two readings in one Run, and a
 *   result frame is a Turn boundary rather than settlement while guidance is
 *   outstanding — so the fixture steers, and the second reading arrives with
 *   the steered turn. That is the shape the M0 spike observed live.
 * - **The mailbox fills because the consumer is not eager.** Claude's steering
 *   consumer takes one Control at a time and only when the provider-visible
 *   slot is free, so a provider that never acknowledges guidance leaves the
 *   rest of it in the mailbox — which is what lets the bound scenario mean
 *   something here. The Pi gate recorded that a backend whose consumer is not
 *   eager would not have Pi's problem, and this is that backend.
 *
 * Nothing about the suite is relaxed for Claude: every scenario runs, and none
 * is skipped.
 */

import {
  CLAUDE_BACKEND_ID,
  CLAUDE_DISPLAY_NAME,
  type ClaudeQueryLoader,
  createClaudeBackend,
  TURN_BOUNDARY_WAIT_MILLIS,
} from "../../backend/claude/index.ts";
import {
  backendId,
  DEFAULT_PROJECTION_BOUNDS,
  type Profile,
} from "../../domain/index.ts";
import {
  DEFAULT_RUNTIME_POLICY,
  type RuntimePolicy,
} from "../../runtime/policy.ts";
import type {
  BackendConformanceFixture,
  BackendConformanceRig,
  BackendConformanceScenario,
} from "../conformance.ts";
import { correlateRuns } from "../correlate.ts";
import type { ResourceCountersSnapshot } from "../fakes/counters.ts";
import {
  type ClaudeScript,
  createStandInClaudeQuery,
  STAND_IN_MODEL,
} from "./stand-in-query.ts";

/** The Profile every Claude fixture starts from: no fields, nothing pinned. */
const PROFILE: Profile = {
  name: "conformance-worker",
  description: "A conformance worker",
  backend: backendId(CLAUDE_BACKEND_ID),
  fields: {},
  systemPrompt: "Do the conformance fixture.",
};

/**
 * One Run that reads a file and then answers.
 *
 * The shape is Claude's: the init frame naming the resolved model, an
 * assistant frame whose only block is a tool use, the tool result on a
 * following user frame, a second assistant frame carrying the answer, and one
 * result frame with the usage for the whole turn. Two root assistant messages
 * therefore means two turns, which is what Claude counts.
 */
const ORDINARY: ClaudeScript = [
  { step: "init" },
  {
    step: "assistant",
    messageId: "msg_1",
    toolCalls: [{ name: "Read", callId: "toolu_1" }],
  },
  { step: "tool-result", callId: "toolu_1", text: "40 lines" },
  { step: "assistant", messageId: "msg_2", text: "the answer" },
  {
    step: "result",
    text: "the answer",
    numTurns: 2,
    models: { [STAND_IN_MODEL]: { input: 40, output: 10 } },
  },
];

/** The transcript `ORDINARY` produces: a tool call, its result, the answer. */
const ORDINARY_TEXTS = ["", "40 lines", "the answer"] as const;

/** A policy with the bounds one scenario needs lowered. */
function lowered(overrides: Partial<RuntimePolicy>): RuntimePolicy {
  return { ...DEFAULT_RUNTIME_POLICY, ...overrides };
}

interface ClaudeFixtureParts
  extends Omit<BackendConformanceFixture, "backend" | "profile" | "counters"> {
  readonly scripts: readonly ClaudeScript[];
  /** Make the SDK loader refuse, which is how an open fails. */
  readonly openFails?: boolean;
  /** Extra Profile frontmatter, for the validation scenario. */
  readonly profileFields?: Readonly<Record<string, unknown>>;
}

function claudeFixture(parts: ClaudeFixtureParts): BackendConformanceFixture {
  const { scripts, openFails, profileFields, ...rest } = parts;
  const standIn = createStandInClaudeQuery({ scripts });
  const live = { count: 0 };

  const loadQuery: ClaudeQueryLoader = async () => {
    if (openFails) throw new Error("the stand-in SDK refused to load");
    return standIn.query;
  };
  const handle = createClaudeBackend({
    loadQuery,
    // A fixture environment, so no scenario depends on the machine it runs on.
    env: { PATH: "/usr/bin" },
  });

  const counters = (): ResourceCountersSnapshot => {
    const record = standIn.record();
    const tally = handle.tally();
    return {
      opens: tally.opens,
      // Claude has no SDK close call, so "closed" means a close that took
      // effect: dropped the identity and aborted whatever Query was live.
      closes: tally.closes,
      // Counted at the Query rather than at the start of `execute`, so a
      // scenario that waits for an execution to be "under way" has waited for
      // the provider to actually be running.
      executionsStarted: record.queries,
      liveExecutions: live.count,
      // The Query *is* the event channel — there is no session-level
      // subscription to attach or release — so a Query still iterating is
      // what a live subscription means for Claude.
      liveSubscriptions: record.liveQueries,
      controlsReceived: record.controls,
      maxConcurrentControls: record.maxConcurrentControls,
      controlsByRun: record.controlsByRun,
    };
  };

  return {
    backend: correlateRuns(handle.backend, standIn, {
      began: () => {
        live.count += 1;
      },
      ended: () => {
        live.count -= 1;
      },
    }),
    profile: {
      ...PROFILE,
      ...(profileFields === undefined ? {} : { fields: profileFields }),
    },
    counters,
    ...rest,
  };
}

export function claudeConformanceRig(): BackendConformanceRig {
  return {
    name: "ClaudeBackend",
    build(scenario: BackendConformanceScenario) {
      switch (scenario) {
        case "validation-is-deterministic":
          // Claude's validation is the real thing, so the deterministic
          // diagnostic is a real one: a field the backend has never heard of.
          return claudeFixture({
            scripts: [],
            profileFields: { nonsense: "x" },
            plans: [],
            expected: {
              runs: [],
              profileDiagnostics: [
                `${CLAUDE_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
              ],
            },
          });

        case "open-creates-no-run":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [],
            expected: { runs: [] },
          });

        case "capabilities-are-enforced":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "under way" },
                { step: "await-input", echo: true },
                { step: "assistant", messageId: "msg_2", text: "the answer" },
                {
                  step: "result",
                  text: "the answer",
                  numTurns: 2,
                  correlate: "awaited",
                },
              ],
            ],
            plans: [
              { controls: [{ type: "steer", text: "an offered Control" }] },
            ],
            expected: {
              runs: [{ status: "completed", steerOutcomes: ["accepted"] }],
              controlsReceived: ["an offered Control"],
            },
          });

        case "resume-or-honest-refusal":
          return claudeFixture({
            scripts: [ORDINARY, ORDINARY],
            plans: [{}, {}],
            expected: {
              runs: [{ status: "completed" }, { status: "completed" }],
            },
          });

        case "close-is-idempotent":
          // Shutdown closes the Subagent and the Session Scope closes it
          // again. One effective close, and no SDK call made twice because
          // there is no SDK call to make.
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "close-releases-every-resource":
          return claudeFixture({
            scripts: [ORDINARY, ORDINARY],
            plans: [{}, {}],
            expected: {
              runs: [{ status: "completed" }, { status: "completed" }],
            },
          });

        case "a-failed-open-leaves-nothing-behind":
          return claudeFixture({
            scripts: [],
            openFails: true,
            plans: [],
            concurrentStarts: 1,
            expected: { runs: [], startOutcomes: ["backend unavailable"] },
          });

        case "one-active-run-per-subagent":
          return claudeFixture({
            scripts: [[{ step: "init" }, { step: "hang" }]],
            plans: [{ cancel: true }],
            resumeWhileRunning: true,
            expected: {
              runs: [{ status: "cancelled" }],
              resumeWhileRunning: "Subagent already running",
            },
          });

        case "observations-reduce-in-accepted-order":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  // The first assistant frame is a tool use and nothing else,
                  // so its text is empty and it is still a message.
                  transcriptTexts: [...ORDINARY_TEXTS],
                  finalOutput: "the answer",
                  toolStatuses: ["completed"],
                },
              ],
            },
          });

        case "exactly-one-ending-wins":
          // Claude's own version of two competing endings: the Query reports
          // its result, and the cancel arrives before the execution has
          // returned. The announced answer wins and the interruption is late.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "the answer" },
                { step: "result", text: "the answer" },
                { step: "hang" },
              ],
            ],
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "completed", finalOutput: "the answer" }],
            },
          });

        case "cancellation-terminates-with-partial-output":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                {
                  step: "assistant",
                  messageId: "msg_1",
                  text: "a partial answer",
                },
                {
                  step: "assistant",
                  messageId: "msg_2",
                  toolCalls: [{ name: "Bash", callId: "toolu_1" }],
                },
                { step: "hang" },
              ],
            ],
            plans: [{ cancel: true }],
            expected: {
              runs: [
                {
                  status: "cancelled",
                  cancellationReason: "requested",
                  finalOutput: "a partial answer",
                  toolStatuses: ["cancelled"],
                },
              ],
            },
          });

        case "result-follows-scope-closure":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            trace: [],
            expected: { runs: [{ status: "completed" }] },
          });

        case "late-events-cannot-mutate-a-terminal-run":
          // The Query reports its answer and then keeps the stream open. The
          // cancel that follows finds a Run that already has an ending, so the
          // announced answer wins and the interruption is the late one.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "the answer" },
                { step: "result", text: "the answer", numTurns: 1 },
                { step: "hang" },
              ],
            ],
            plans: [{ cancel: true }],
            expected: {
              runs: [
                {
                  status: "completed",
                  finalOutput: "the answer",
                  transcriptTexts: ["the answer"],
                },
              ],
            },
          });

        case "a-failing-sink-cannot-strand-the-execution":
          // The Query dies mid-stream, which is the transport failure the
          // adapter has to classify as failed while keeping what it saw.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "first" },
                { step: "throw" },
              ],
            ],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "failed",
                  finalOutput: "first",
                  diagnosticCategories: ["backend-failure"],
                },
              ],
            },
          });

        case "a-run-may-settle-with-no-observations":
          // The spike's Query-loss shape: an abort early enough produced no
          // frames at all, not even the init frame.
          return claudeFixture({
            scripts: [[{ step: "hang" }]],
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "cancelled", cancellationReason: "requested" }],
            },
          });

        case "an-execution-settles-when-the-provider-goes-quiet":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                {
                  step: "assistant",
                  messageId: "msg_1",
                  text: "the first answer",
                },
                { step: "await-input" },
                {
                  step: "result",
                  text: "the first answer",
                  correlate: "prompt",
                },
                { step: "hang" },
              ],
            ],
            testClock: true,
            plans: [
              {
                controls: [{ type: "steer", text: "guidance awaiting a turn" }],
                advanceClockMillis: TURN_BOUNDARY_WAIT_MILLIS + 1,
              },
            ],
            expected: {
              runs: [
                {
                  status: "completed",
                  finalOutput: "the first answer",
                  steerOutcomes: ["accepted"],
                  diagnosticCategories: ["control"],
                },
              ],
              controlsReceived: ["guidance awaiting a turn"],
            },
          });

        case "observations-carry-no-provider-vocabulary":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "under way" },
                // Taken and never acknowledged, so nothing claims it.
                { step: "await-input" },
                {
                  step: "assistant",
                  messageId: "msg_2",
                  text: "the answer",
                  toolCalls: [{ name: "Grep", callId: "toolu_1" }],
                },
                { step: "tool-result", callId: "toolu_1", text: "3 hits" },
                {
                  step: "result",
                  text: "the answer",
                  numTurns: 2,
                  correlate: "unowned",
                  models: {
                    [STAND_IN_MODEL]: { input: 5, output: 2, window: 200_000 },
                  },
                },
              ],
            ],
            plans: [
              { controls: [{ type: "steer", text: "a Control nobody took" }] },
            ],
            expected: {
              runs: [{ status: "completed", steerOutcomes: ["accepted"] }],
            },
          });

        case "capacity-rejection-is-immediate":
          return claudeFixture({
            scripts: [[{ step: "init" }, { step: "hang" }]],
            plans: [{ cancel: true }],
            policy: lowered({ maxActiveRuns: 1 }),
            concurrentStarts: 2,
            expected: {
              runs: [{ status: "cancelled" }],
              startOutcomes: ["started", "at capacity"],
            },
          });

        case "shutdown-rejects-new-work":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [],
            startsAfterClose: 1,
            expected: { runs: [], startOutcomes: ["shutting down"] },
          });

        case "a-late-waiter-reads-the-stored-result":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{ waitAfterSettlement: true }],
            expected: { runs: [{ status: "completed" }] },
          });

        case "an-evicted-result-answers-expired":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            policy: lowered({ maxResultBytes: 4_096, resultStoreBytes: 8_192 }),
            evictOldest: true,
            expected: { runs: [{ status: "completed" }] },
          });

        case "steering-admission-follows-the-declared-capability":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "under way" },
                { step: "await-input", echo: true },
                { step: "await-input", echo: true },
                { step: "assistant", messageId: "msg_2", text: "the answer" },
                {
                  step: "result",
                  text: "the answer",
                  numTurns: 2,
                  correlate: "awaited",
                },
              ],
            ],
            plans: [
              {
                controls: [
                  { type: "steer", text: "first" },
                  { type: "steer", text: "second" },
                ],
              },
            ],
            expected: {
              runs: [
                {
                  status: "completed",
                  steerOutcomes: ["accepted", "accepted"],
                },
              ],
              controlsReceived: ["first", "second"],
            },
          });

        case "controls-are-delivered-serially-in-order":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "under way" },
                { step: "await-input", echo: true },
                { step: "await-input", echo: true },
                { step: "await-input", echo: true },
                { step: "assistant", messageId: "msg_2", text: "the answer" },
                {
                  step: "result",
                  text: "the answer",
                  numTurns: 2,
                  correlate: "awaited",
                },
              ],
            ],
            plans: [
              {
                controls: ["first", "second", "third"].map((text) => ({
                  type: "steer" as const,
                  text,
                })),
              },
            ],
            expected: {
              runs: [
                {
                  status: "completed",
                  steerOutcomes: ["accepted", "accepted", "accepted"],
                },
              ],
              controlsReceived: ["first", "second", "third"],
              maxConcurrentControls: 1,
            },
          });

        case "a-control-cannot-leak-into-the-next-run":
          // Claude's consumer takes what it can push, so the Control *is*
          // pushed into the first Run's input stream — and the proof is that
          // the second Run, on the same retained conversation, gets nothing.
          //
          // The first Run is not cancelled, and that is what makes the
          // delivery side assertable. The script's `await-input` step cannot
          // finish until the Control has actually been pushed, so the Run
          // reaches its result frame only after delivery has happened; a
          // fixture that cancelled instead would be racing the cancel against
          // the consumer, which is the race the Pi gate recorded as a gap.
          // The result correlates to an input this Run does not own, so the
          // outstanding guidance is discarded and the answer stands.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "first" },
                { step: "await-input" },
                {
                  step: "result",
                  text: "",
                  numTurns: 1,
                  correlate: "unowned",
                },
              ],
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_2", text: "second" },
                { step: "result", text: "", numTurns: 1 },
              ],
            ],
            plans: [
              {
                controls: [{ type: "steer", text: "only for the first Run" }],
              },
              {},
            ],
            expected: {
              runs: [
                {
                  status: "completed",
                  finalOutput: "first",
                  steerOutcomes: ["accepted"],
                },
                { status: "completed", finalOutput: "second" },
              ],
              // Unlike the Pi fixture, the delivery side *is* asserted here.
              // This is the gap the Pi exit gate carried into M5.
              controlsReceived: ["only for the first Run"],
            },
          });

        case "a-user-observation-appears-only-on-confirmation":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "under way" },
                { step: "await-input", echo: true },
                // Taken, pushed, and never acknowledged.
                { step: "await-input" },
                { step: "assistant", messageId: "msg_2", text: "the answer" },
                // Correlated to the prompt, so the outstanding guidance makes
                // this a Turn boundary and the stream's end settles the Run.
                {
                  step: "result",
                  text: "the answer",
                  numTurns: 2,
                  correlate: "prompt",
                },
              ],
            ],
            plans: [
              {
                controls: ["confirmed", "unconfirmed"].map((text) => ({
                  type: "steer" as const,
                  text,
                })),
              },
            ],
            expected: {
              runs: [
                {
                  status: "completed",
                  transcriptTexts: ["under way", "confirmed", "the answer"],
                },
              ],
              controlsReceived: ["confirmed", "unconfirmed"],
            },
          });

        case "a-full-mailbox-answers-immediately":
          // The Query takes the first Control and never acknowledges it, so
          // the consumer waits for the slot and everything behind it stays in
          // the mailbox — which is where the bound is.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "under way" },
                { step: "await-input" },
                { step: "hang" },
              ],
            ],
            policy: lowered({
              controls: {
                maxPending: 2,
                maxMessageBytes: 16 * 1024,
                maxPendingBytes: 64 * 1024,
              },
            }),
            plans: [{ floodControls: 8, cancel: true }],
            expected: { runs: [{ status: "cancelled" }] },
          });

        case "a-closed-mailbox-refuses-after-cancel":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "under way" },
                { step: "hang" },
              ],
            ],
            plans: [{ cancel: true, steerAfterCancel: true }],
            expected: { runs: [{ status: "cancelled" }] },
          });

        case "usage-deltas-are-run-local":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 40, output: 10 },
                  // Two root assistant messages, and the result's own total
                  // agrees, so nothing is raised.
                  turns: 2,
                },
              ],
            },
          });

        case "reconciliation-does-not-double-count":
          // Claude's terminal reconciliation carries turns and the model and
          // **no usage at all**, because the frames were the transcript and
          // there is no authoritative message list to recompute a total from.
          // So the property holds by construction: there is nothing to double
          // count, and the streamed figure is the reported one exactly.
          //
          // And the two fields it does carry are the two that were streamed:
          // the same turn count and the same model. So the snapshot agrees
          // with the stream in every particular, the Run carries no
          // difference diagnostic, and the counter reads zero. That is the
          // honest answer for this backend, and the rig declares it rather
          // than passing on a count of arrivals.
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 40, output: 10 },
                  turns: 2,
                  diagnosticCategories: [],
                },
              ],
              reconciliationDifferences: 0,
            },
          });

        case "context-occupancy-is-a-gauge":
          // Two readings in one Run, which for Claude means two provider
          // turns: the first result frame is a Turn boundary because guidance
          // is still outstanding, and the second carries the later reading.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "thinking" },
                { step: "await-input" },
                {
                  step: "result",
                  text: "thinking",
                  numTurns: 1,
                  correlate: "prompt",
                  models: {
                    [STAND_IN_MODEL]: { input: 1_000, window: 200_000 },
                  },
                },
                { step: "echo-input" },
                { step: "assistant", messageId: "msg_2", text: "the answer" },
                {
                  step: "result",
                  text: "the answer",
                  numTurns: 2,
                  correlate: "awaited",
                  models: {
                    [STAND_IN_MODEL]: {
                      input: 1_600,
                      cacheRead: 200,
                      window: 200_000,
                    },
                  },
                },
              ],
            ],
            plans: [
              { controls: [{ type: "steer", text: "and mention the tests" }] },
            ],
            expected: {
              runs: [
                {
                  status: "completed",
                  // The latest reading, never the sum of the readings.
                  context: { tokens: 1_800, window: 200_000 },
                },
              ],
            },
          });

        case "a-replayed-transcript-adds-no-usage":
          // Claude's is the literal case: a resumed Query replays history the
          // provider flags, and the live frames answer from what the
          // conversation already holds without spending anything.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                {
                  step: "assistant",
                  messageId: "msg_1",
                  text: "the first answer",
                },
                {
                  step: "result",
                  text: "the first answer",
                  numTurns: 1,
                  models: { [STAND_IN_MODEL]: { input: 100 } },
                },
              ],
              [
                { step: "history", role: "user", text: "the old question" },
                { step: "init" },
                { step: "assistant", text: "replayed", replay: true },
                {
                  step: "tool-result",
                  callId: "toolu_9",
                  text: "answered from the retained conversation",
                },
                {
                  step: "result",
                  text: "",
                  numTurns: 0,
                  models: { [STAND_IN_MODEL]: {} },
                },
              ],
            ],
            plans: [{}, {}],
            expected: {
              runs: [
                { status: "completed", usageTotals: { input: 100 }, turns: 1 },
                { status: "completed", usageTotals: { input: 0 }, turns: 0 },
              ],
            },
          });

        case "a-resumed-run-excludes-prior-usage":
          // The provider's per-model reading is cumulative across the turns of
          // one Query and starts fresh on a resumed one. The adapter's
          // translator is created per Run, so each Run is charged its own
          // reading and nothing subtracts a previous conversation.
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                {
                  step: "assistant",
                  messageId: "msg_1",
                  text: "the first answer",
                },
                {
                  step: "result",
                  text: "the first answer",
                  numTurns: 1,
                  models: { [STAND_IN_MODEL]: { input: 100, output: 40 } },
                },
              ],
              [
                { step: "init" },
                {
                  step: "assistant",
                  messageId: "msg_2",
                  text: "the second answer",
                },
                {
                  step: "result",
                  text: "the second answer",
                  numTurns: 1,
                  models: { [STAND_IN_MODEL]: { input: 75, output: 25 } },
                },
              ],
            ],
            plans: [{}, {}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 100, output: 40 },
                },
                { status: "completed", usageTotals: { input: 75, output: 25 } },
              ],
            },
          });

        case "only-the-repository-writes-snapshots":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "projections-stay-within-their-limits":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                ...Array.from(
                  { length: 6 },
                  (_unused, index) =>
                    ({
                      step: "assistant",
                      messageId: `msg_${index}`,
                      text: `message ${index}`,
                    }) as const,
                ),
                // The same text as the last assistant frame, so the result
                // adds no answer of its own.
                { step: "result", text: "message 5", numTurns: 6 },
              ],
            ],
            policy: lowered({
              projection: {
                ...DEFAULT_PROJECTION_BOUNDS,
                maxTranscriptItems: 2,
              },
            }),
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  transcriptTexts: ["message 4", "message 5"],
                },
              ],
            },
          });

        case "settlement-stores-the-result-exactly-once":
          return claudeFixture({
            scripts: [
              [
                { step: "init" },
                { step: "assistant", messageId: "msg_1", text: "the answer" },
                { step: "result", text: "the answer" },
                { step: "hang" },
              ],
            ],
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "completed", finalOutput: "the answer" }],
              notifications: 1,
            },
          });

        case "wait-and-result-observe-the-same-value":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "a-notification-follows-storage":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }], notifications: 1 },
          });

        case "a-notification-retry-cannot-duplicate-or-alter-settlement":
          return claudeFixture({
            scripts: [ORDINARY],
            plans: [{}],
            sinkFailsOnce: true,
            policy: lowered({
              deliveryRetryBudget: { attempts: 3, delayMillis: 0 },
            }),
            expected: { runs: [{ status: "completed" }], notifications: 1 },
          });
      }
    },
  };
}

/**
 * What a Claude rig skips.
 *
 * Nothing, and the spec expected otherwise — it allowed skips "where the
 * terminal transcript snapshot capability gates a scenario". It turns out no
 * shared scenario is gated on that capability. The two that come closest are
 * `reconciliation-does-not-double-count`, which Claude satisfies by carrying
 * no usage in its snapshot at all, and `a-replayed-transcript-adds-no-usage`,
 * which is the one scenario Claude can demonstrate *literally* rather than by
 * analogy. So the skip list is empty, and the rig test asserts the empty list
 * rather than leaving it to be read off the output.
 */
export function claudeConformanceSkips(): readonly BackendConformanceScenario[] {
  return [];
}
