/**
 * The conformance rig for the real Pi backend.
 *
 * It builds the actual adapter — the same `createPiBackend` the entry point
 * uses — with the stand-in session injected through the factory the adapter
 * already has for that purpose, and runs the shared conformance suite against
 * it. Nothing about the adapter is stubbed: validation, the retained session,
 * the per-Run execution, the translation, the steering consumer, and the
 * cancellation path are all the production code.
 *
 * Two things are rig-side, and both are bookkeeping the contract deliberately
 * has no place for.
 *
 * **The counters.** The suite asks a rig for opens, closes, live executions,
 * live subscriptions, and the Controls the backend received, because "every
 * retained resource is released" is not a property a test can read off the
 * code. For the fakes those numbers come from inside the fake. Here they come
 * from the stand-in session — which is where they actually are — plus a thin
 * wrapper around `execute` that counts an execution in and out of its scope.
 *
 * **The Run correlation.** A native session has no idea which Run it is
 * serving, so the wrapper tells the stand-in when each Run's execution begins
 * and ends. That is what makes "a Control admitted to a cancelled Run never
 * reaches the next one" a real assertion for Pi rather than a vacuous one.
 *
 * Where a scenario's shape is genuinely different for Pi it is written
 * differently here and the reason is in a comment beside it. Nothing about the
 * suite is relaxed for Pi: every scenario runs, and none is skipped.
 */

import { Effect, Fiber } from "effect";
import type {
  Backend,
  BackendAgent,
  ExecutionIO,
} from "../../backend/contract.ts";
import {
  createPiBackend,
  PI_DISPLAY_NAME,
  type PiSessionOptions,
} from "../../backend/pi/index.ts";
import { DEFAULT_BACKEND_ID, type Profile } from "../../domain/index.ts";
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
import type { ResourceCountersSnapshot } from "../fakes/counters.ts";
import { correlateRuns } from "./correlate.ts";
import {
  createGate,
  createStandInPiSession,
  type PiScript,
  type StandInPiSession,
} from "./stand-in-session.ts";

/** The Profile every Pi fixture starts from: no fields, so nothing is pinned. */
const PROFILE: Profile = {
  name: "conformance-worker",
  description: "A conformance worker",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Do the conformance fixture.",
};

/**
 * One Run that reads a file and then answers.
 *
 * The shape is Pi's: an assistant message whose only part is a tool call, the
 * two tool-execution frames around the call, a second assistant message
 * carrying the answer and the usage for it, and the terminal frame with the
 * whole message list. Two assistant messages therefore means two turns, which
 * is what Pi counts.
 */
const ORDINARY: PiScript = [
  { step: "assistant", toolCalls: [{ name: "read_file", callId: "c1" }] },
  { step: "tool-start", callId: "c1", name: "read_file" },
  { step: "tool-end", callId: "c1", name: "read_file", result: "40 lines" },
  { step: "assistant", text: "the answer", usage: { input: 40, output: 10 } },
  { step: "terminal" },
];

interface PiInstrumentation {
  /** Hold the first observation so a late Control is admitted deterministically. */
  readonly gateLateControlDrain?: boolean;
  /** Make the session factory refuse, which is how an open fails. */
  readonly openFails?: boolean;
  /** Extra Profile frontmatter, for the validation scenario. */
  readonly profileFields?: Readonly<Record<string, unknown>>;
  /** Keep the wrapped execution open after Pi's execute Effect returns. */
  readonly holdAfterExecute?: boolean;
  /** Record a test-only second decision after Pi records its own. */
  readonly recordCompetingDecisionAfterDecision?: boolean;
  /** Emit from execution-scope cleanup before the core terminal observations. */
  readonly emitCleanupObservationOnScopeClose?: boolean;
}

/**
 * Keep Run 1 active after its native prompt settles, without keeping Pi busy.
 * The fixed adapter releases the held observation through its Control
 * diagnostic; the broken adapter releases it by calling the idle SDK steer,
 * whose queued guidance is then visible to Run 2.
 */
function gateLateControlDrain(
  backend: Backend,
  standIn: StandInPiSession,
): Backend {
  let gated = false;
  return {
    ...backend,
    open: (profile, subagent) =>
      Effect.map(
        backend.open(profile, subagent),
        (agent): BackendAgent => ({
          ...agent,
          execute: (input, io) => {
            if (gated) return agent.execute(input, io);
            gated = true;
            const releaseDrain = createGate();
            const firstEmitted = createGate();
            let heldFirst = false;
            const gatedIO: ExecutionIO = {
              recordDecision: io.recordDecision,
              controls: io.controls,
              emit: (observation) => {
                if (!heldFirst && observation.kind !== "diagnostic") {
                  heldFirst = true;
                  return Effect.promise(() => releaseDrain.promise).pipe(
                    Effect.andThen(io.emit(observation)),
                    Effect.ensuring(Effect.sync(firstEmitted.release)),
                  );
                }
                if (
                  observation.kind === "diagnostic" &&
                  observation.diagnostic.category === "control"
                ) {
                  releaseDrain.release();
                  return Effect.promise(() => firstEmitted.promise).pipe(
                    Effect.andThen(io.emit(observation)),
                  );
                }
                return io.emit(observation);
              },
            };
            return Effect.gen(function* () {
              const queued = yield* Effect.forkChild(
                Effect.gen(function* () {
                  while (standIn.record().steers.length === 0) {
                    yield* Effect.yieldNow;
                  }
                  releaseDrain.release();
                }),
              );
              const bundle = yield* agent.execute(input, gatedIO);
              yield* Fiber.interrupt(queued);
              return bundle;
            }).pipe(Effect.ensuring(Effect.sync(releaseDrain.release)));
          },
        }),
      ),
  };
}

interface DecisionInstrumentationOptions {
  readonly trace: string[] | undefined;
  readonly holdAfterExecute: boolean;
  readonly recordCompetingDecisionAfterDecision: boolean;
  readonly emitCleanupObservationOnScopeClose: boolean;
}

function observeDecisions(
  backend: Backend,
  options: DecisionInstrumentationOptions,
): Backend {
  if (
    options.trace === undefined &&
    !options.holdAfterExecute &&
    !options.recordCompetingDecisionAfterDecision &&
    !options.emitCleanupObservationOnScopeClose
  ) {
    return backend;
  }
  return {
    ...backend,
    open: (profile, subagent) =>
      Effect.map(
        backend.open(profile, subagent),
        (agent): BackendAgent => ({
          ...agent,
          execute: (input, io) => {
            let recorded = false;
            let execution = agent.execute(input, {
              ...io,
              recordDecision: (bundle) =>
                Effect.gen(function* () {
                  yield* io.recordDecision(bundle);
                  recorded = true;
                  if (!options.recordCompetingDecisionAfterDecision) {
                    options.trace?.push(`decision-recorded:${input.runId}`);
                  }
                }),
            });
            if (options.recordCompetingDecisionAfterDecision) {
              execution = execution.pipe(
                Effect.tap((bundle) =>
                  Effect.gen(function* () {
                    // This duplicate belongs to the conformance fixture, not
                    // the Pi adapter. The core keeps the adapter's first
                    // decision and counts this second one as a no-op.
                    yield* io.recordDecision({
                      ...bundle,
                      ending: { ending: "cancelled", reason: "shutdown" },
                    });
                    yield* Effect.yieldNow;
                    if (recorded) {
                      options.trace?.push(`decision-recorded:${input.runId}`);
                    }
                  }),
                ),
              );
            }
            if (options.emitCleanupObservationOnScopeClose) {
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
            return options.holdAfterExecute
              ? execution.pipe(Effect.andThen(Effect.never))
              : execution;
          },
        }),
      ),
  };
}

function piFixture(
  scripts: readonly PiScript[],
  row: BackendConformanceScenarioRow,
  instrumentation: PiInstrumentation | undefined,
) {
  const standIn = createStandInPiSession({ scripts });
  const live = { count: 0 };
  let opens = 0;

  const handle = createPiBackend({
    sessionFactory: async () => {
      if (instrumentation?.openFails) {
        throw new Error("the stand-in refused to open");
      }
      opens += 1;
      return { session: standIn.session };
    },
    // The options a real open builds read the agent directory and discover
    // resources. Neither is what a conformance scenario is about, and both
    // are proven separately against fixture paths.
    sessionOptionsFactory: async () => ({}) as PiSessionOptions,
  });

  const counters = (): ResourceCountersSnapshot => {
    const record = standIn.record();
    return {
      opens,
      // The adapter disposes exactly once however many times it is closed, so
      // disposals are what "closed" means here.
      closes: record.disposed,
      // Counted at the prompt rather than at the start of `execute`, so a
      // scenario that waits for an execution to be "under way" has waited for
      // the session to actually be doing something.
      executionsStarted: record.prompts,
      liveExecutions: live.count,
      liveSubscriptions: record.liveSubscriptions,
      controlsReceived: record.steers,
      maxConcurrentControls: record.maxConcurrentSteers,
      controlsByRun: record.steersByRun,
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

  const gated = instrumentation?.gateLateControlDrain
    ? gateLateControlDrain(correlated, standIn)
    : correlated;

  return {
    backend: observeDecisions(gated, {
      trace: row.trace,
      holdAfterExecute: instrumentation?.holdAfterExecute ?? false,
      recordCompetingDecisionAfterDecision:
        instrumentation?.recordCompetingDecisionAfterDecision ?? false,
      emitCleanupObservationOnScopeClose:
        instrumentation?.emitCleanupObservationOnScopeClose ?? false,
    }),
    profile: {
      ...PROFILE,
      ...(instrumentation?.profileFields === undefined
        ? {}
        : { fields: instrumentation.profileFields }),
    },
    counters,
  };
}

/** Collect one stand-in script for each Run a scenario drives. */
const scripts = (...runScripts: readonly PiScript[]): readonly PiScript[] =>
  runScripts;

/** One Pi-vocabulary script sequence for every shared scenario. */
const PI_SCRIPTS = {
  "validation-is-deterministic": scripts(),
  "open-creates-no-run": scripts(ORDINARY),
  "capabilities-are-enforced": scripts([
    { step: "await-steer", confirm: true },
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "resume-or-honest-refusal": scripts(ORDINARY, ORDINARY),
  "close-is-idempotent": scripts(ORDINARY),
  "close-releases-every-resource": scripts(ORDINARY, ORDINARY),
  "a-failed-open-leaves-nothing-behind": scripts(),
  "one-active-run-per-subagent": scripts([{ step: "hang" }]),
  "observations-reduce-in-accepted-order": scripts(ORDINARY),
  "exactly-one-ending-is-emitted": scripts([
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "cancellation-terminates-with-partial-output": scripts([
    { step: "assistant", text: "a partial answer" },
    { step: "tool-start", callId: "c1", name: "bash" },
    { step: "hang" },
  ]),
  "a decided bundle survives a later cancel": scripts([
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "result-follows-scope-closure": scripts(ORDINARY),
  "cleanup-observations-precede-the-core-ending": scripts([
    { step: "speak-on-abort", text: "a frame nobody asked for" },
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "a-failing-sink-cannot-strand-the-execution": scripts([
    { step: "assistant", text: "first" },
    { step: "reject" },
  ]),
  "a-run-may-settle-with-no-observations": scripts([{ step: "hang" }]),
  "cancel-returns-immediately-and-settlement-bounds-an-ignored-stop": scripts([
    { step: "assistant", text: "a partial answer" },
    { step: "ignore-abort" },
  ]),
  "an-execution-settles-when-the-provider-goes-quiet": scripts([
    { step: "await-steer", confirm: false, settle: false },
    { step: "terminal" },
  ]),
  "observations-carry-no-provider-vocabulary": scripts([
    { step: "await-steer", confirm: false, reject: true },
    {
      step: "assistant",
      text: "the answer",
      model: { provider: "fixture", id: "model-a" },
      usage: { input: 5, output: 2, totalTokens: 100 },
    },
    { step: "tool-start", callId: "c1", name: "grep" },
    { step: "tool-end", callId: "c1", name: "grep", result: "3 hits" },
    { step: "terminal" },
  ]),
  "capacity-rejection-is-immediate": scripts([{ step: "hang" }]),
  "shutdown-rejects-new-work": scripts(ORDINARY),
  "a-late-waiter-reads-the-stored-result": scripts(ORDINARY),
  "an-evicted-result-answers-expired": scripts(ORDINARY),
  "steering-admission-follows-the-declared-capability": scripts([
    { step: "await-steer", confirm: true },
    { step: "await-steer", confirm: true },
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "controls-are-delivered-serially-in-order": scripts([
    { step: "assistant", text: "under way" },
    { step: "await-steer", confirm: true },
    { step: "await-steer", confirm: true },
    { step: "await-steer", confirm: true },
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "a-control-cannot-leak-into-the-next-run": scripts(
    [{ step: "assistant", text: "first" }, { step: "terminal" }],
    [{ step: "assistant", text: "second" }, { step: "terminal" }],
  ),
  "a-user-observation-appears-only-on-confirmation": scripts([
    { step: "assistant", text: "under way" },
    { step: "await-steer", confirm: true },
    { step: "await-steer", confirm: false },
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "a-full-mailbox-answers-immediately": scripts([
    { step: "assistant", text: "under way" },
    { step: "hang" },
  ]),
  "a-closed-mailbox-refuses-after-cancel": scripts([
    { step: "assistant", text: "under way" },
    { step: "hang" },
  ]),
  "usage-deltas-are-run-local": scripts(ORDINARY),
  "reconciliation-does-not-double-count": scripts([
    {
      step: "assistant",
      text: "a partial answer",
      usage: { input: 40, output: 10 },
    },
    { step: "restate-usage", usage: { input: 50, output: 12 } },
    { step: "terminal" },
  ]),
  "context-occupancy-is-a-gauge": scripts([
    { step: "assistant", text: "thinking", usage: { totalTokens: 1_000 } },
    {
      step: "assistant",
      text: "the answer",
      usage: { totalTokens: 1_800 },
    },
    { step: "terminal" },
  ]),
  "a-replayed-transcript-adds-no-usage": scripts(
    [
      { step: "assistant", text: "first answer", usage: { input: 100 } },
      { step: "terminal" },
    ],
    [
      { step: "user", text: "the same question, restated" },
      { step: "tool-result", text: "answered from the retained conversation" },
      { step: "terminal" },
    ],
  ),
  "a-resumed-run-excludes-prior-usage": scripts(
    [
      {
        step: "assistant",
        text: "first answer",
        usage: { input: 100, output: 40 },
      },
      { step: "terminal" },
    ],
    [
      {
        step: "assistant",
        text: "second answer",
        usage: { input: 75, output: 25 },
      },
      { step: "terminal" },
    ],
  ),
  "only-the-repository-writes-snapshots": scripts(ORDINARY),
  "projections-stay-within-their-limits": scripts([
    ...Array.from(
      { length: 6 },
      (_unused, index) =>
        ({ step: "assistant", text: `message ${index}` }) as const,
    ),
    { step: "terminal" },
  ]),
  "settlement-stores-the-result-exactly-once": scripts([
    { step: "assistant", text: "the answer" },
    { step: "terminal" },
  ]),
  "wait-and-result-observe-the-same-value": scripts(ORDINARY),
  "a-notification-follows-storage": scripts(ORDINARY),
  "a-notification-retry-cannot-duplicate-or-alter-settlement":
    scripts(ORDINARY),
} satisfies Record<BackendConformanceScenario, readonly PiScript[]>;

/** Pi mechanisms needed to make particular provider-shaped scripts observable. */
const PI_INSTRUMENTATION: Partial<
  Record<BackendConformanceScenario, PiInstrumentation>
> = {
  "validation-is-deterministic": { profileFields: { nonsense: "x" } },
  "a-failed-open-leaves-nothing-behind": { openFails: true },
  "exactly-one-ending-is-emitted": {
    holdAfterExecute: true,
    recordCompetingDecisionAfterDecision: true,
  },
  "a decided bundle survives a later cancel": { holdAfterExecute: true },
  "cleanup-observations-precede-the-core-ending": {
    holdAfterExecute: true,
    emitCleanupObservationOnScopeClose: true,
  },
  "a-control-cannot-leak-into-the-next-run": { gateLateControlDrain: true },
  "settlement-stores-the-result-exactly-once": {
    holdAfterExecute: true,
    recordCompetingDecisionAfterDecision: true,
  },
};

/** Named shared-row fields whose honest Pi shape differs from the common case. */
const PI_OVERRIDES: Partial<
  Record<BackendConformanceScenario, BackendConformanceScenarioOverride>
> = {
  "validation-is-deterministic": {
    reason: "Pi validates unknown Profile fields with its backend display name",
    replace: {
      expected: {
        runs: [],
        profileDiagnostics: [
          `${PI_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
        ],
      },
    },
  },
  "exactly-one-ending-is-emitted": {
    reason: "Pi records its decision before the rig adds a competing decision",
    trace: true,
    replace: { plans: [{ cancel: true, cancelAfterDecision: true }] },
  },
  "a decided bundle survives a later cancel": {
    reason: "Pi's terminal snapshot restates its streamed answer without drift",
    replace: {
      expected: {
        runs: [{ status: "completed", finalOutput: "the answer" }],
        duplicateDecisions: 0,
      },
    },
  },
  "cleanup-observations-precede-the-core-ending": {
    reason:
      "Pi closes the held native execution after its decision is recorded",
    trace: true,
    replace: {
      plans: [{ cancel: true, cancelAfterDecision: true }],
      expected: {
        runs: [
          {
            status: "completed",
            finalOutput: "the answer",
            transcriptTexts: ["the answer"],
            usageTotals: { input: 0 },
            diagnosticCategories: ["other"],
          },
        ],
      },
    },
  },
  "an-execution-settles-when-the-provider-goes-quiet": {
    reason: "Pi observes its terminal frame directly and needs no test clock",
    replace: {
      testClock: false,
      plans: [
        { controls: [{ type: "steer", text: "guidance awaiting a turn" }] },
      ],
    },
  },
  "observations-carry-no-provider-vocabulary": {
    reason: "Pi exercises confinement with a rejected native steering request",
    replace: {
      plans: [{ controls: [{ type: "steer", text: "a rejected steer" }] }],
      expected: {
        runs: [{ status: "completed", steerOutcomes: ["accepted"] }],
      },
    },
  },
  "a-control-cannot-leak-into-the-next-run": {
    reason: "Pi's eager consumer is gated while the first prompt drains",
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
            diagnosticCategories: ["control"],
          },
          {
            status: "completed",
            finalOutput: "second",
            transcriptTexts: ["second"],
          },
        ],
        controlsReceived: [],
      },
    },
  },
  "a-full-mailbox-answers-immediately": {
    reason:
      "Pi's eager consumer takes one Control while eight fill its mailbox",
    replace: {
      plans: [{ floodControls: 8, cancel: true }],
      expected: { runs: [{ status: "cancelled" }] },
    },
  },
  "usage-deltas-are-run-local": {
    reason: "Pi counts the ordinary tool-call message and answer as two turns",
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
    reason: "Pi emits one assistant message before restating its usage",
    replace: {
      expected: {
        runs: [
          {
            status: "completed",
            usageTotals: { input: 50, output: 12 },
            turns: 1,
            diagnosticCategories: ["reconciliation-difference"],
          },
        ],
        reconciliationDifferences: 1,
      },
    },
  },
  "context-occupancy-is-a-gauge": {
    reason: "Pi reports context occupancy without a context-window size",
    replace: {
      expected: {
        runs: [{ status: "completed", context: { tokens: 1_800 } }],
      },
    },
  },
  "settlement-stores-the-result-exactly-once": {
    reason: "Pi records a competing decision only after its answer is decided",
    trace: true,
    replace: { plans: [{ cancel: true, cancelAfterDecision: true }] },
  },
};

/** Pi declares every capability and skips no shared scenario. */
const PI_SKIPS: readonly BackendConformanceScenario[] = [];

/** Structural declarations for the Pi conformance rig. */
export function piConformanceStructure(): BackendConformanceRigStructure {
  return conformanceRigStructure({
    name: "PiBackend",
    scripts: PI_SCRIPTS,
    skips: PI_SKIPS,
    overrides: PI_OVERRIDES,
  });
}

export function piConformanceRig(): BackendConformanceRig {
  return {
    name: "PiBackend",
    build(scenario) {
      if (PI_SKIPS.includes(scenario)) return undefined;
      const override = PI_OVERRIDES[scenario];
      return composeConformanceFixture({
        row: BACKEND_CONFORMANCE_SCENARIO_TABLE[scenario],
        script: PI_SCRIPTS[scenario],
        ...(override === undefined ? {} : { override }),
        build: (script, row) =>
          piFixture(script, row, PI_INSTRUMENTATION[scenario]),
      });
    },
  };
}

/** Pi declares every capability and runs every shared scenario. */
export function piConformanceSkips(): readonly BackendConformanceScenario[] {
  return PI_SKIPS;
}
