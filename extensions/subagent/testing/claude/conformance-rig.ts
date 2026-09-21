/**
 * The conformance rig for the real Claude backend.
 *
 * The shared table owns provider-neutral plans, expectations, policy, and
 * driver levers. This rig supplies only Claude frame scripts, counters and Run
 * correlation, Claude-only instrumentation, an empty skip list, and reasoned
 * replacements for the rows whose honest Claude shape differs.
 */

import { Effect } from "effect";
import {
  CLAUDE_BACKEND_ID,
  CLAUDE_DISPLAY_NAME,
  type ClaudeQueryLoader,
  createClaudeBackend,
  TURN_BOUNDARY_WAIT_MILLIS,
} from "../../backend/claude/index.ts";
import type { Backend, BackendAgent } from "../../backend/contract.ts";
import { backendId, type Profile } from "../../domain/index.ts";
import {
  BACKEND_CONFORMANCE_SCENARIO_TABLE,
  type BackendConformanceRig,
  type BackendConformanceRigStructure,
  type BackendConformanceScenario,
  type BackendConformanceScenarioOverride,
  type BackendConformanceScenarioRow,
  composeConformanceFixture,
  conformanceRigStructure,
} from "../conformance.ts";
import { correlateRuns } from "../correlate.ts";
import type { ResourceCountersSnapshot } from "../fakes/counters.ts";
import {
  type ClaudeScript,
  createStandInClaudeQuery,
  STAND_IN_MODEL,
} from "./stand-in-query.ts";

const PROFILE: Profile = {
  name: "conformance-worker",
  description: "A conformance worker",
  backend: backendId(CLAUDE_BACKEND_ID),
  fields: {},
  systemPrompt: "Do the conformance fixture.",
};

/** One ordinary Claude Run: a tool call, its result, and an answer. */
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

const ORDINARY_TEXTS = ["", "40 lines", "the answer"] as const;

interface ClaudeInstrumentation {
  readonly openFails?: boolean;
  readonly profileFields?: Readonly<Record<string, unknown>>;
  readonly traceDecisions?: boolean;
  readonly recordCompetingDecisionAfterDecision?: boolean;
  readonly emitCleanupObservationOnScopeClose?: boolean;
}

interface DecisionInstrumentation {
  readonly trace: string[] | undefined;
  readonly recordCompetingDecisionAfterDecision: boolean;
  readonly emitCleanupObservationOnScopeClose: boolean;
}

function observeDecisions(
  backend: Backend,
  instrumentation: DecisionInstrumentation,
): Backend {
  return {
    ...backend,
    open: (profile, subagent) =>
      Effect.map(
        backend.open(profile, subagent),
        (agent): BackendAgent => ({
          ...agent,
          execute: (input, io) => {
            let execution = agent.execute(input, {
              ...io,
              recordDecision: (bundle) =>
                Effect.gen(function* () {
                  yield* io.recordDecision(bundle);
                  if (instrumentation.recordCompetingDecisionAfterDecision) {
                    yield* io.recordDecision({
                      ...bundle,
                      ending: { ending: "cancelled", reason: "shutdown" },
                    });
                  }
                  instrumentation.trace?.push(
                    `decision-recorded:${input.runId}`,
                  );
                }),
            });
            if (instrumentation.emitCleanupObservationOnScopeClose) {
              execution = Effect.acquireRelease(Effect.void, () =>
                io.emit({
                  kind: "diagnostic",
                  diagnostic: {
                    category: "other",
                    message: "test-only cleanup observation",
                  },
                }),
              ).pipe(Effect.andThen(execution));
            }
            return execution;
          },
        }),
      ),
  };
}

function claudeFixture(
  scripts: readonly ClaudeScript[],
  row: BackendConformanceScenarioRow,
  instrumentation: ClaudeInstrumentation | undefined,
) {
  const standIn = createStandInClaudeQuery({ scripts });
  const live = { count: 0 };

  const loadQuery: ClaudeQueryLoader = async () => {
    if (instrumentation?.openFails) {
      throw new Error("the stand-in SDK refused to load");
    }
    return standIn.query;
  };
  const handle = createClaudeBackend({
    loadQuery,
    env: { PATH: "/usr/bin" },
  });

  const counters = (): ResourceCountersSnapshot => {
    const record = standIn.record();
    const tally = handle.tally();
    return {
      opens: tally.opens,
      closes: tally.closes,
      executionsStarted: record.queries,
      liveExecutions: live.count,
      liveExecutionFibers: live.count,
      liveSubscriptions: record.liveQueries,
      controlsReceived: record.controls,
      maxConcurrentControls: record.maxConcurrentControls,
      controlsByRun: record.controlsByRun,
    };
  };

  const correlated = correlateRuns(handle.backend, standIn, {
    began: () => {
      live.count += 1;
    },
    ended: () => {
      live.count -= 1;
    },
  });
  const instrumentDecisions =
    instrumentation?.traceDecisions === true ||
    instrumentation?.recordCompetingDecisionAfterDecision === true ||
    instrumentation?.emitCleanupObservationOnScopeClose === true;
  const backend = instrumentDecisions
    ? observeDecisions(correlated, {
        trace: row.trace,
        recordCompetingDecisionAfterDecision:
          instrumentation?.recordCompetingDecisionAfterDecision ?? false,
        emitCleanupObservationOnScopeClose:
          instrumentation?.emitCleanupObservationOnScopeClose ?? false,
      })
    : correlated;

  return {
    backend,
    profile: {
      ...PROFILE,
      ...(instrumentation?.profileFields === undefined
        ? {}
        : { fields: instrumentation.profileFields }),
    },
    counters,
  };
}

const scripts = (...runScripts: readonly ClaudeScript[]) => runScripts;

/** One complete Claude-frame script sequence per conformance scenario. */
const CLAUDE_SCRIPTS = {
  "validation-is-deterministic": scripts(),
  "open-creates-no-run": scripts(ORDINARY),
  "capabilities-are-enforced": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "under way" },
    { step: "await-input", echo: true },
    { step: "assistant", messageId: "msg_2", text: "the answer" },
    { step: "result", text: "the answer", numTurns: 2, correlate: "awaited" },
  ]),
  "resume-or-honest-refusal": scripts(ORDINARY, ORDINARY),
  "close-is-idempotent": scripts(ORDINARY),
  "close-releases-every-resource": scripts(ORDINARY, ORDINARY),
  "a-failed-open-leaves-nothing-behind": scripts(),
  "one-active-run-per-subagent": scripts([{ step: "init" }, { step: "hang" }]),
  "observations-reduce-in-accepted-order": scripts(ORDINARY),
  "exactly-one-ending-is-emitted": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "the answer" },
    { step: "result", text: "the answer" },
    { step: "hang" },
  ]),
  "cancellation-terminates-with-partial-output": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "a partial answer" },
    {
      step: "assistant",
      messageId: "msg_2",
      toolCalls: [{ name: "Bash", callId: "toolu_1" }],
    },
    { step: "hang" },
  ]),
  "a decided bundle survives a later cancel": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "the answer" },
    { step: "result", text: "the answer" },
    { step: "hang" },
  ]),
  "result-follows-scope-closure": scripts(ORDINARY),
  "cleanup-observations-precede-the-core-ending": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "the answer" },
    { step: "result", text: "the answer", numTurns: 1 },
    { step: "hang" },
  ]),
  "a-failing-sink-cannot-strand-the-execution": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "first" },
    { step: "throw" },
  ]),
  "a-run-may-settle-with-no-observations": scripts([{ step: "hang" }]),
  "cancel-returns-immediately-and-settlement-bounds-an-ignored-stop": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "a partial answer" },
    { step: "ignore-abort" },
  ]),
  "an-execution-settles-when-the-provider-goes-quiet": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "the first answer" },
    { step: "await-input" },
    { step: "result", text: "the first answer", correlate: "prompt" },
    { step: "hang" },
  ]),
  "observations-carry-no-provider-vocabulary": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "under way" },
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
  ]),
  "capacity-rejection-is-immediate": scripts([
    { step: "init" },
    { step: "hang" },
  ]),
  "shutdown-rejects-new-work": scripts(ORDINARY),
  "a-late-waiter-reads-the-stored-result": scripts(ORDINARY),
  "an-evicted-result-answers-expired": scripts(ORDINARY),
  "steering-admission-follows-the-declared-capability": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "under way" },
    { step: "await-input", echo: true },
    { step: "await-input", echo: true },
    { step: "assistant", messageId: "msg_2", text: "the answer" },
    { step: "result", text: "the answer", numTurns: 2, correlate: "awaited" },
  ]),
  "controls-are-delivered-serially-in-order": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "under way" },
    { step: "await-input", echo: true },
    { step: "await-input", echo: true },
    { step: "await-input", echo: true },
    { step: "assistant", messageId: "msg_2", text: "the answer" },
    { step: "result", text: "the answer", numTurns: 2, correlate: "awaited" },
  ]),
  "a-control-cannot-leak-into-the-next-run": scripts(
    [
      { step: "init" },
      { step: "assistant", messageId: "msg_1", text: "first" },
      { step: "await-input" },
      { step: "result", text: "", numTurns: 1, correlate: "unowned" },
    ],
    [
      { step: "init" },
      { step: "assistant", messageId: "msg_2", text: "second" },
      { step: "result", text: "", numTurns: 1 },
    ],
  ),
  "a-user-observation-appears-only-on-confirmation": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "under way" },
    { step: "await-input", echo: true },
    { step: "await-input" },
    { step: "assistant", messageId: "msg_2", text: "the answer" },
    { step: "result", text: "the answer", numTurns: 2, correlate: "prompt" },
  ]),
  "a-full-mailbox-answers-immediately": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "under way" },
    { step: "await-input" },
    { step: "hang" },
  ]),
  "a-closed-mailbox-refuses-after-cancel": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "under way" },
    { step: "hang" },
  ]),
  "usage-deltas-are-run-local": scripts(ORDINARY),
  "reconciliation-does-not-double-count": scripts(ORDINARY),
  "context-occupancy-is-a-gauge": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "thinking" },
    { step: "await-input" },
    {
      step: "result",
      text: "thinking",
      numTurns: 1,
      correlate: "prompt",
      models: { [STAND_IN_MODEL]: { input: 1_000, window: 200_000 } },
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
  ]),
  "a-replayed-transcript-adds-no-usage": scripts(
    [
      { step: "init" },
      { step: "assistant", messageId: "msg_1", text: "the first answer" },
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
  ),
  "a-resumed-run-excludes-prior-usage": scripts(
    [
      { step: "init" },
      { step: "assistant", messageId: "msg_1", text: "the first answer" },
      {
        step: "result",
        text: "the first answer",
        numTurns: 1,
        models: { [STAND_IN_MODEL]: { input: 100, output: 40 } },
      },
    ],
    [
      { step: "init" },
      { step: "assistant", messageId: "msg_2", text: "the second answer" },
      {
        step: "result",
        text: "the second answer",
        numTurns: 1,
        models: { [STAND_IN_MODEL]: { input: 75, output: 25 } },
      },
    ],
  ),
  "only-the-repository-writes-snapshots": scripts(ORDINARY),
  "projections-stay-within-their-limits": scripts([
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
    { step: "result", text: "message 5", numTurns: 6 },
  ]),
  "settlement-stores-the-result-exactly-once": scripts([
    { step: "init" },
    { step: "assistant", messageId: "msg_1", text: "the answer" },
    { step: "result", text: "the answer" },
    { step: "hang" },
  ]),
  "wait-and-result-observe-the-same-value": scripts(ORDINARY),
  "a-notification-follows-storage": scripts(ORDINARY),
  "a-notification-retry-cannot-duplicate-or-alter-settlement":
    scripts(ORDINARY),
} satisfies Record<BackendConformanceScenario, readonly ClaudeScript[]>;

/** Claude mechanisms needed only by particular provider-shaped scripts. */
const CLAUDE_INSTRUMENTATION: Partial<
  Record<BackendConformanceScenario, ClaudeInstrumentation>
> = {
  "validation-is-deterministic": { profileFields: { nonsense: "x" } },
  "a-failed-open-leaves-nothing-behind": { openFails: true },
  "exactly-one-ending-is-emitted": {
    traceDecisions: true,
    recordCompetingDecisionAfterDecision: true,
  },
  "a decided bundle survives a later cancel": { traceDecisions: true },
  "cleanup-observations-precede-the-core-ending": {
    traceDecisions: true,
    emitCleanupObservationOnScopeClose: true,
  },
  "settlement-stores-the-result-exactly-once": {
    traceDecisions: true,
    recordCompetingDecisionAfterDecision: true,
  },
};

/** Named shared-row fields whose honest Claude shape differs. */
const CLAUDE_OVERRIDES: Partial<
  Record<BackendConformanceScenario, BackendConformanceScenarioOverride>
> = {
  "validation-is-deterministic": {
    reason:
      "Claude validates unknown Profile fields with its backend display name",
    replace: {
      expected: {
        runs: [],
        profileDiagnostics: [
          `${CLAUDE_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
        ],
      },
    },
  },
  "observations-reduce-in-accepted-order": {
    reason: "Claude reports the tool result as its own transcript item",
    replace: {
      expected: {
        runs: [
          {
            status: "completed",
            transcriptTexts: ORDINARY_TEXTS,
            finalOutput: "the answer",
            toolStatuses: ["completed"],
          },
        ],
      },
    },
  },
  "exactly-one-ending-is-emitted": {
    reason: "Claude records its decision before the rig adds a competing one",
    trace: true,
    replace: { plans: [{ cancel: true, cancelAfterDecision: true }] },
  },
  "a decided bundle survives a later cancel": {
    reason: "Claude's terminal snapshot restates its streamed answer",
    replace: {
      expected: {
        runs: [{ status: "completed", finalOutput: "the answer" }],
        duplicateDecisions: 0,
      },
    },
  },
  "cleanup-observations-precede-the-core-ending": {
    reason: "Claude closes the held Query after its decision is recorded",
    trace: true,
    replace: { plans: [{ cancel: true, cancelAfterDecision: true }] },
  },
  "cancel-returns-immediately-and-settlement-bounds-an-ignored-stop": {
    reason:
      "Effect interrupts Claude's provider wait promptly despite the ignored abort, so the retained conversation remains resumable and this scenario does not probe loss",
    replace: {
      providerStopsOnRequest: true,
      plans: [{ cancel: true, advanceClockAfterCancelMillis: 2_001 }],
      expected: {
        runs: [
          {
            status: "cancelled",
            cancellationReason: "requested",
            finalOutput: "a partial answer",
            diagnosticCategories: [],
          },
        ],
      },
    },
  },
  "an-execution-settles-when-the-provider-goes-quiet": {
    reason: "Claude advances its Turn-boundary wait after guidance is queued",
    replace: {
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
    },
  },
  "observations-carry-no-provider-vocabulary": {
    reason: "Claude exercises confinement with unacknowledged guidance",
    replace: {
      plans: [{ controls: [{ type: "steer", text: "a Control nobody took" }] }],
      expected: {
        runs: [{ status: "completed", steerOutcomes: ["accepted"] }],
      },
    },
  },
  "a-control-cannot-leak-into-the-next-run": {
    reason:
      "Claude pushes guidance into the first Run before proving the next gets none",
    replace: {
      plans: [
        { controls: [{ type: "steer", text: "only for the first Run" }] },
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
        controlsReceived: ["only for the first Run"],
      },
    },
  },
  "a-full-mailbox-answers-immediately": {
    reason:
      "Claude's non-eager consumer takes one Control while eight fill its mailbox",
    replace: {
      plans: [{ floodControls: 8, cancel: true }],
      expected: { runs: [{ status: "cancelled" }] },
    },
  },
  "usage-deltas-are-run-local": {
    reason:
      "Claude counts the ordinary tool-call message and answer as two turns",
    replace: {
      expected: {
        runs: [
          {
            status: "completed",
            usageTotals: { input: 40, output: 10 },
            turns: 2,
          },
        ],
      },
    },
  },
  "reconciliation-does-not-double-count": {
    reason:
      "Claude's terminal snapshot carries no usage and agrees with the stream",
    replace: {
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
    },
  },
  "context-occupancy-is-a-gauge": {
    reason:
      "Claude steers once so the second context reading arrives on a second Turn",
    replace: {
      plans: [{ controls: [{ type: "steer", text: "and mention the tests" }] }],
    },
  },
  "settlement-stores-the-result-exactly-once": {
    reason:
      "Claude records a competing decision only after its answer is decided",
    trace: true,
    replace: { plans: [{ cancel: true, cancelAfterDecision: true }] },
  },
};

/** Claude declares every capability and skips no shared scenario. */
const CLAUDE_SKIPS: readonly BackendConformanceScenario[] = [];

/** Structural declarations for the Claude conformance rig. */
export function claudeConformanceStructure(): BackendConformanceRigStructure {
  return conformanceRigStructure({
    name: "ClaudeBackend",
    scripts: CLAUDE_SCRIPTS,
    skips: CLAUDE_SKIPS,
    overrides: CLAUDE_OVERRIDES,
  });
}

export function claudeConformanceRig(): BackendConformanceRig {
  return {
    name: "ClaudeBackend",
    build(scenario) {
      if (CLAUDE_SKIPS.includes(scenario)) return undefined;
      const override = CLAUDE_OVERRIDES[scenario];
      return composeConformanceFixture({
        row: BACKEND_CONFORMANCE_SCENARIO_TABLE[scenario],
        script: CLAUDE_SCRIPTS[scenario],
        ...(override === undefined ? {} : { override }),
        build: (script, row) =>
          claudeFixture(script, row, CLAUDE_INSTRUMENTATION[scenario]),
      });
    },
  };
}

export function claudeConformanceSkips(): readonly BackendConformanceScenario[] {
  return CLAUDE_SKIPS;
}
