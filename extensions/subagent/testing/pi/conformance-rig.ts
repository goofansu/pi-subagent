/**
 * The conformance rig for the real Pi backend.
 *
 * It builds the actual adapter — the same `createPiBackend` the entry point
 * uses — with the stand-in session injected through the factory the adapter
 * already has for that purpose, and runs the shared 37-scenario suite against
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
import {
  DEFAULT_BACKEND_ID,
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

/** A policy with the bounds one scenario needs lowered. */
function lowered(overrides: Partial<RuntimePolicy>): RuntimePolicy {
  return { ...DEFAULT_RUNTIME_POLICY, ...overrides };
}

interface PiFixtureParts
  extends Omit<BackendConformanceFixture, "backend" | "profile" | "counters"> {
  readonly scripts: readonly PiScript[];
  /** Hold the first observation so a late Control is admitted deterministically. */
  readonly gateLateControlDrain?: boolean;
  /** Make the session factory refuse, which is how an open fails. */
  readonly openFails?: boolean;
  /** Extra Profile frontmatter, for the validation scenario. */
  readonly profileFields?: Readonly<Record<string, unknown>>;
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

function piFixture(parts: PiFixtureParts): BackendConformanceFixture {
  const {
    scripts,
    gateLateControlDrain: gateDrain,
    openFails,
    profileFields,
    ...rest
  } = parts;
  const standIn = createStandInPiSession({ scripts });
  const live = { count: 0 };
  let opens = 0;

  const handle = createPiBackend({
    sessionFactory: async () => {
      if (openFails) throw new Error("the stand-in refused to open");
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

  return {
    backend: gateDrain ? gateLateControlDrain(correlated, standIn) : correlated,
    profile: {
      ...PROFILE,
      ...(profileFields === undefined ? {} : { fields: profileFields }),
    },
    counters,
    ...rest,
  };
}

export function piConformanceRig(): BackendConformanceRig {
  return {
    name: "PiBackend",
    build(scenario: BackendConformanceScenario) {
      switch (scenario) {
        case "validation-is-deterministic":
          // Pi's validation is the real thing, so the deterministic diagnostic
          // is a real one: a field the backend has never heard of.
          return piFixture({
            scripts: [],
            profileFields: { nonsense: "x" },
            plans: [],
            expected: {
              runs: [],
              profileDiagnostics: [
                `${PI_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
              ],
            },
          });

        case "open-creates-no-run":
          return piFixture({
            scripts: [ORDINARY],
            plans: [],
            expected: { runs: [] },
          });

        case "capabilities-are-enforced":
          return piFixture({
            scripts: [
              [
                { step: "await-steer", confirm: true },
                { step: "assistant", text: "the answer" },
                { step: "terminal" },
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
          return piFixture({
            scripts: [ORDINARY, ORDINARY],
            plans: [{}, {}],
            expected: {
              runs: [{ status: "completed" }, { status: "completed" }],
            },
          });

        case "close-is-idempotent":
          // Shutdown closes the Subagent and the Session Scope closes it
          // again. One disposal, one shutdown event to the child.
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "close-releases-every-resource":
          return piFixture({
            scripts: [ORDINARY, ORDINARY],
            plans: [{}, {}],
            expected: {
              runs: [{ status: "completed" }, { status: "completed" }],
            },
          });

        case "a-failed-open-leaves-nothing-behind":
          return piFixture({
            scripts: [],
            openFails: true,
            plans: [],
            concurrentStarts: 1,
            expected: { runs: [], startOutcomes: ["backend unavailable"] },
          });

        case "one-active-run-per-subagent":
          return piFixture({
            scripts: [[{ step: "hang" }]],
            plans: [{ cancel: true }],
            resumeWhileRunning: true,
            expected: {
              runs: [{ status: "cancelled" }],
              resumeWhileRunning: "Subagent already running",
            },
          });

        case "observations-reduce-in-accepted-order":
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  // The first assistant message is a tool call and nothing
                  // else, so its text is empty and it is still a message.
                  transcriptTexts: ["", "the answer"],
                  finalOutput: "the answer",
                  toolStatuses: ["completed"],
                },
              ],
            },
          });

        case "exactly-one-ending-wins":
          // Pi's own version of two competing endings: the session finishes,
          // and the cancel arrives before the execution has returned. The
          // announced answer wins and the interruption is the late one.
          return piFixture({
            scripts: [
              [
                { step: "assistant", text: "the answer" },
                { step: "terminal" },
                { step: "hang" },
              ],
            ],
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "completed", finalOutput: "the answer" }],
            },
          });

        case "cancellation-terminates-with-partial-output":
          return piFixture({
            scripts: [
              [
                { step: "assistant", text: "a partial answer" },
                { step: "tool-start", callId: "c1", name: "bash" },
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
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            trace: [],
            expected: { runs: [{ status: "completed" }] },
          });

        case "late-events-cannot-mutate-a-terminal-run":
          // The session says one more thing while it is being aborted, which
          // is after the Run captured its ending and sealed its intake. It
          // reaches the seam, is counted, and changes nothing.
          return piFixture({
            scripts: [
              [
                { step: "speak-on-abort", text: "a frame nobody asked for" },
                { step: "assistant", text: "the answer" },
                { step: "terminal" },
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
                  usageTotals: { input: 0 },
                },
              ],
            },
          });

        case "a-failing-sink-cannot-strand-the-execution":
          return piFixture({
            scripts: [
              [{ step: "assistant", text: "first" }, { step: "reject" }],
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
          // The brief Pi echoes back is the Run's own goal, and the adapter
          // omits it — so a Run that did nothing else reported nothing at all.
          return piFixture({
            scripts: [[{ step: "hang" }]],
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "cancelled", cancellationReason: "requested" }],
            },
          });

        case "observations-carry-no-provider-vocabulary":
          return piFixture({
            scripts: [
              [
                { step: "await-steer", confirm: false, reject: true },
                {
                  step: "assistant",
                  text: "the answer",
                  model: { provider: "fixture", id: "model-a" },
                  usage: { input: 5, output: 2, totalTokens: 100 },
                },
                { step: "tool-start", callId: "c1", name: "grep" },
                {
                  step: "tool-end",
                  callId: "c1",
                  name: "grep",
                  result: "3 hits",
                },
                { step: "terminal" },
              ],
            ],
            plans: [
              { controls: [{ type: "steer", text: "a rejected steer" }] },
            ],
            expected: {
              runs: [{ status: "completed", steerOutcomes: ["accepted"] }],
            },
          });

        case "capacity-rejection-is-immediate":
          return piFixture({
            scripts: [[{ step: "hang" }]],
            plans: [{ cancel: true }],
            policy: lowered({ maxActiveRuns: 1 }),
            concurrentStarts: 2,
            expected: {
              runs: [{ status: "cancelled" }],
              startOutcomes: ["started", "at capacity"],
            },
          });

        case "shutdown-rejects-new-work":
          return piFixture({
            scripts: [ORDINARY],
            plans: [],
            concurrentStarts: 1,
            shutdownFirst: true,
            expected: { runs: [], startOutcomes: ["shutting down"] },
          });

        case "a-late-waiter-reads-the-stored-result":
          return piFixture({
            scripts: [ORDINARY],
            plans: [{ waitAfterSettlement: true }],
            expected: { runs: [{ status: "completed" }] },
          });

        case "an-evicted-result-answers-expired":
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            policy: lowered({ maxResultBytes: 4_096, resultStoreBytes: 8_192 }),
            evictOldest: true,
            expected: { runs: [{ status: "completed" }] },
          });

        case "steering-admission-follows-the-declared-capability":
          return piFixture({
            scripts: [
              [
                { step: "await-steer", confirm: true },
                { step: "await-steer", confirm: true },
                { step: "assistant", text: "the answer" },
                { step: "terminal" },
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
          return piFixture({
            scripts: [
              [
                { step: "assistant", text: "under way" },
                { step: "await-steer", confirm: true },
                { step: "await-steer", confirm: true },
                { step: "await-steer", confirm: true },
                { step: "assistant", text: "the answer" },
                { step: "terminal" },
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
          // Both prompts finish without polling for guidance. The Control is
          // admitted while the first execution is still draining; if the
          // adapter hands it to settled Pi, the stand-in's idle queue surfaces
          // it as a user message at the start of the resumed Run.
          return piFixture({
            gateLateControlDrain: true,
            scripts: [
              [{ step: "assistant", text: "first" }, { step: "terminal" }],
              [{ step: "assistant", text: "second" }, { step: "terminal" }],
            ],
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
          });

        case "a-user-observation-appears-only-on-confirmation":
          return piFixture({
            scripts: [
              [
                { step: "assistant", text: "under way" },
                { step: "await-steer", confirm: true },
                { step: "await-steer", confirm: false },
                { step: "assistant", text: "the answer" },
                { step: "terminal" },
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
          // The session never consumes the first steer, so the consumer is
          // blocked inside it and the mailbox is what fills up behind it.
          return piFixture({
            scripts: [
              [{ step: "assistant", text: "under way" }, { step: "hang" }],
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
          return piFixture({
            scripts: [
              [{ step: "assistant", text: "under way" }, { step: "hang" }],
            ],
            plans: [{ cancel: true, steerAfterCancel: true }],
            expected: { runs: [{ status: "cancelled" }] },
          });

        case "usage-deltas-are-run-local":
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 40, output: 10 },
                  // Pi counts one turn per assistant message, and the ordinary
                  // Run has two: the tool call and the answer.
                  turns: 2,
                },
              ],
            },
          });

        case "reconciliation-does-not-double-count":
          // Pi's own drift: the message the session retains is restated with
          // the authoritative usage, and the terminal frame carries it.
          return piFixture({
            scripts: [
              [
                {
                  step: "assistant",
                  text: "a partial answer",
                  usage: { input: 40, output: 10 },
                },
                { step: "restate-usage", usage: { input: 50, output: 12 } },
                { step: "terminal" },
              ],
            ],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 50, output: 12 },
                  turns: 1,
                  // The restated usage is genuine drift, so the Run carries
                  // the diagnostic that names it.
                  diagnosticCategories: ["reconciliation-difference"],
                },
              ],
              reconciliationDifferences: 1,
            },
          });

        case "context-occupancy-is-a-gauge":
          return piFixture({
            scripts: [
              [
                {
                  step: "assistant",
                  text: "thinking",
                  usage: { totalTokens: 1_000 },
                },
                {
                  step: "assistant",
                  text: "the answer",
                  usage: { totalTokens: 1_800 },
                },
                { step: "terminal" },
              ],
            ],
            plans: [{}],
            expected: {
              runs: [{ status: "completed", context: { tokens: 1_800 } }],
            },
          });

        case "a-replayed-transcript-adds-no-usage":
          // Pi's analogue of a replay: a resumed Run that restates the
          // question and answers from what the session already holds. It
          // produces messages and spends nothing, which is the property.
          return piFixture({
            scripts: [
              [
                {
                  step: "assistant",
                  text: "first answer",
                  usage: { input: 100 },
                },
                { step: "terminal" },
              ],
              [
                { step: "user", text: "the same question, restated" },
                {
                  step: "tool-result",
                  text: "answered from the retained conversation",
                },
                { step: "terminal" },
              ],
            ],
            plans: [{}, {}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 100 },
                  turns: 1,
                },
                { status: "completed", usageTotals: { input: 0 }, turns: 0 },
              ],
            },
          });

        case "a-resumed-run-excludes-prior-usage":
          // Pi reports usage per message, so Run-locality comes from the
          // message baseline: the resumed Run's terminal frame carries the
          // whole conversation and the adapter subtracts what was already
          // there.
          return piFixture({
            scripts: [
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
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "projections-stay-within-their-limits":
          return piFixture({
            scripts: [
              [
                ...Array.from(
                  { length: 6 },
                  (_unused, index) =>
                    ({
                      step: "assistant",
                      text: `message ${index}`,
                    }) as const,
                ),
                { step: "terminal" },
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
          // Two candidates: the answer the session announced, and the
          // interruption that arrived after it. One result, one notification.
          return piFixture({
            scripts: [
              [
                { step: "assistant", text: "the answer" },
                { step: "terminal" },
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
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "a-notification-follows-storage":
          return piFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }], notifications: 1 },
          });

        case "a-notification-retry-cannot-duplicate-or-alter-settlement":
          return piFixture({
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
 * What a Pi rig skips.
 *
 * Nothing. Pi declares resume, steering, and a terminal snapshot, so every
 * scenario means something for it — and an empty list is what the rig test
 * asserts, so a skip could not be introduced quietly.
 */
export function piConformanceSkips(): readonly BackendConformanceScenario[] {
  return [];
}
