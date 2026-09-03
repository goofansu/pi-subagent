/**
 * The conformance rig for the real Codex backend.
 *
 * It builds the actual adapter — the same `createCodexBackend` the entry point
 * uses — with the stand-in App Server injected through the spawn option the
 * adapter already has for that purpose, and runs the shared suite against it.
 * Nothing about the adapter is stubbed: validation, the process lifecycle, the
 * JSON-RPC framing, the bounded requests, the Subagent-scoped reader and its
 * routing table, the translation, the steering correlation, and the
 * cancellation path are all the production code, driven over the real wire.
 *
 * Two things are rig-side, and both are bookkeeping the contract deliberately
 * has no place for.
 *
 * **The counters.** Opens and effective closes come from the adapter's own
 * tally; the Turns and the steers come from the stand-in, which is where they
 * actually are; live executions come from a thin wrapper around `execute`.
 * `liveSubscriptions` is the adapter's **reader-fiber** count, and that is the
 * one place Codex's answer differs in kind from the other two adapters': the
 * stream is Subagent-scoped, so there is one reader for a BackendAgent rather
 * than one subscription per Run. It still has to read zero once the Session
 * has closed, which is what the leak check is about.
 *
 * **The Run correlation.** An App Server has no idea which Run it is serving,
 * so the wrapper tells the stand-in when each Run's execution begins and ends,
 * and the stand-in attributes each steer to the Run that was live.
 *
 * Where a scenario's shape is genuinely different for Codex it is written
 * differently here and the reason is in a comment beside it. Three are worth
 * knowing about before reading:
 *
 * - **A steering scenario is gated on the steer, not on timing.** The
 *   stand-in's `await-steer` frame makes the Turn's next frame depend on the
 *   guidance having reached the server, so "delivered in order" is a fact
 *   about the script rather than a hope about scheduling.
 * - **A competing ending is an answer plus a cancel.** Codex announces an
 *   ending in the stream only when a final agent message was already observed
 *   and a cancel then arrives — which is exactly the shape ADR-0012 is about,
 *   and the only shape that produces two endings to arbitrate.
 * - **"A replayed transcript adds no usage" is Codex's *retained context*.**
 *   There is no replay: a second Turn on a retained thread answers from the
 *   conversation without the client resending it, and the spike confirmed it.
 *   So the fixture is a resumed Turn whose cumulative reading has not moved —
 *   it answered from what the thread already held — and it is charged nothing.
 *   The scenario also asks for a turn count of zero, and a *completed* Codex
 *   Turn is always one turn, so the fixture's answer is observed and the Turn
 *   is then cut short. That is a real Codex shape rather than a contrivance:
 *   a final answer already observed is the Run's answer, whatever stops the
 *   Turn afterwards.
 *
 * Nothing about the suite is relaxed for Codex: every scenario runs, and none
 * is skipped.
 */

import { Effect, type Scope } from "effect";
import {
  CODEX_BACKEND_ID,
  CODEX_DISPLAY_NAME,
  createCodexBackend,
} from "../../backend/codex/index.ts";
import type {
  Backend,
  BackendAgent,
  ExecutionIO,
  RunInput,
  TerminalBundle,
} from "../../backend/contract.ts";
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
  type CodexScriptFrame,
  type CodexSteerPolicy,
  type CodexTurnScript,
  createStandInAppServer,
} from "./stand-in-app-server.ts";

/** The Profile every Codex fixture starts from: no fields, nothing pinned. */
const PROFILE: Profile = {
  name: "conformance-worker",
  description: "A conformance worker",
  backend: backendId(CODEX_BACKEND_ID),
  fields: {},
  systemPrompt: "Do the conformance fixture.",
};

/** The window every gauge in this file is read against. */
const WINDOW = 200_000;

/**
 * One Turn that runs a command and then answers.
 *
 * The shape is Codex's: an item started and completed for the command, a
 * completed agent message whose phase is the final answer, one cumulative
 * usage frame, and the completion frame that ends the Turn. One completed
 * Turn is one turn, which is what Codex counts.
 */
const ORDINARY: CodexTurnScript = {
  frames: [
    {
      frame: "item-started",
      item: { kind: "command", id: "c1", command: "rg TODO" },
    },
    {
      frame: "item-completed",
      item: {
        kind: "command",
        id: "c1",
        command: "rg TODO",
        status: "completed",
        output: "40 lines",
      },
    },
    {
      frame: "item-completed",
      item: {
        kind: "agentMessage",
        id: "m1",
        text: "the answer",
        phase: "final_answer",
      },
    },
    {
      frame: "usage",
      total: { totalTokens: 50, inputTokens: 40, outputTokens: 10 },
      last: { totalTokens: 50 },
      window: WINDOW,
    },
    { frame: "completed" },
  ],
};

/**
 * The transcript `ORDINARY` produces.
 *
 * Two items: the command's tool-call part, whose text is empty because a tool
 * call is not text, and the answer. The command's *completion* is a
 * `tool_progress` update rather than a transcript item, which is why there are
 * two and not three.
 */
const ORDINARY_TEXTS = ["", "the answer"] as const;

/** A Turn that answers and then stops talking, for the cancel fixtures. */
function answersThenHolds(text: string): CodexTurnScript {
  return {
    frames: [
      {
        frame: "item-completed",
        item: { kind: "agentMessage", id: "m1", text, phase: "final_answer" },
      },
      { frame: "hold" },
    ],
  };
}

/** A policy with the bounds one scenario needs lowered. */
function lowered(overrides: Partial<RuntimePolicy>): RuntimePolicy {
  return { ...DEFAULT_RUNTIME_POLICY, ...overrides };
}

interface CodexFixtureParts
  extends Omit<BackendConformanceFixture, "backend" | "profile" | "counters"> {
  readonly scripts: readonly CodexTurnScript[];
  /** Make the spawn throw, which is how a missing binary looks. */
  readonly spawnFails?: boolean;
  /** One policy per steer, consumed in order. The last one repeats. */
  readonly steerPolicies?: readonly CodexSteerPolicy[];
  /** What `turn/interrupt` does. */
  readonly onInterrupt?: "complete" | "ignore";
  /** Extra Profile frontmatter, for the validation scenario. */
  readonly profileFields?: Readonly<Record<string, unknown>>;
  /**
   * How many observations the Run must have received before the plan acts.
   *
   * The gate the cancel fixtures need, and the Codex counterpart of the
   * `await-steer` frame. Codex's stream is read by a Subagent-scoped fiber, so
   * "the server has written the answer" and "the Run has the answer" are two
   * different moments — and a fixture that cancelled between them would be
   * asserting on a race rather than on a rule. Counting at the seam makes the
   * second moment observable, so `untilUnderWay` waits for the Run to actually
   * hold what the script wrote.
   */
  readonly deliveredObservations?: number;
}

/**
 * Count what one Run has actually received, at the seam.
 *
 * Wrapped around the backend rather than built into it, because it is a rig's
 * bookkeeping and the contract has no place for it: `emit` is the function an
 * adapter is handed, and this is a rig counting how many times it was called.
 */
function countEmissions(backend: Backend, onEmit: () => void): Backend {
  return {
    id: backend.id,
    validateProfile: backend.validateProfile,
    open: (profile, subagent) =>
      Effect.map(
        backend.open(profile, subagent),
        (agent): BackendAgent => ({
          capabilities: agent.capabilities,
          admitResume: agent.admitResume,
          close: agent.close,
          execute: (
            input: RunInput,
            io: ExecutionIO,
          ): Effect.Effect<TerminalBundle, never, Scope.Scope> =>
            agent.execute(input, {
              controls: io.controls,
              emit: (observation) =>
                Effect.flatMap(Effect.sync(onEmit), () => io.emit(observation)),
            }),
        }),
      ),
  };
}

function codexFixture(parts: CodexFixtureParts): BackendConformanceFixture {
  const {
    scripts,
    spawnFails,
    steerPolicies,
    onInterrupt,
    profileFields,
    deliveredObservations,
    ...rest
  } = parts;
  const standIn = createStandInAppServer({
    scripts,
    ...(spawnFails === undefined ? {} : { spawnFails }),
    ...(steerPolicies === undefined ? {} : { steerPolicies }),
    ...(onInterrupt === undefined ? {} : { onInterrupt }),
  });
  const live = { count: 0 };
  const gate = deliveredObservations ?? 0;
  let received = 0;

  const handle = createCodexBackend({
    spawn: standIn.spawn,
    // A fixture environment, so no scenario depends on the machine it runs on.
    env: { PATH: "/usr/bin" },
  });

  const counters = (): ResourceCountersSnapshot => {
    const record = standIn.record();
    const tally = handle.tally();
    const probe = handle.probe();
    return {
      opens: tally.opens,
      closes: tally.closes,
      // Counted at the `turn/start` request rather than at the start of
      // `execute`, so a scenario that waits for an execution to be "under
      // way" has waited for the provider to actually have been asked — and,
      // where the fixture asks for it, for the Run to hold what the script
      // wrote. See `deliveredObservations`.
      executionsStarted:
        gate === 0 || record.turnStarts === 0 || received >= gate
          ? record.turnStarts
          : record.turnStarts - 1,
      liveExecutions: live.count,
      // Codex's stream is Subagent-scoped, so what a live subscription means
      // here is a reader fiber still owning stdout. See the module comment.
      liveSubscriptions: probe.readerFibers,
      controlsReceived: record.steers,
      maxConcurrentControls: record.maxConcurrentSteers,
      controlsByRun: record.steersByRun,
    };
  };

  return {
    backend: countEmissions(
      correlateRuns(handle.backend, standIn, {
        began: () => {
          live.count += 1;
          received = 0;
        },
        ended: () => {
          live.count -= 1;
        },
      }),
      () => {
        received += 1;
      },
    ),
    profile: {
      ...PROFILE,
      ...(profileFields === undefined ? {} : { fields: profileFields }),
    },
    counters,
    ...rest,
  };
}

/** One `await-steer` gate per Control the scenario offers. */
function gates(count: number): CodexScriptFrame[] {
  return Array.from({ length: count }, () => ({ frame: "await-steer" }));
}

export function codexConformanceRig(): BackendConformanceRig {
  return {
    name: "CodexBackend",
    build(scenario: BackendConformanceScenario) {
      switch (scenario) {
        case "validation-is-deterministic":
          // Codex's validation is the real thing, so the deterministic
          // diagnostic is a real one: a field the backend has never heard of.
          return codexFixture({
            scripts: [],
            profileFields: { nonsense: "x" },
            plans: [],
            expected: {
              runs: [],
              profileDiagnostics: [
                `${CODEX_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
              ],
            },
          });

        case "open-creates-no-run":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [],
            expected: { runs: [] },
          });

        case "capabilities-are-enforced":
          return codexFixture({
            scripts: [
              {
                frames: [
                  ...gates(1),
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the answer",
                      phase: "final_answer",
                    },
                  },
                  { frame: "completed" },
                ],
              },
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
          // Two sequential Turns on one retained ephemeral root, which is
          // Codex's resume mechanism: no `thread/resume`, no stored rollout.
          return codexFixture({
            scripts: [ORDINARY, ORDINARY],
            plans: [{}, {}],
            expected: {
              runs: [{ status: "completed" }, { status: "completed" }],
            },
          });

        case "close-is-idempotent":
          // Shutdown closes the Subagent and the Session Scope closes it
          // again. One effective close, one ended stdin, one exited process.
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "close-releases-every-resource":
          return codexFixture({
            scripts: [ORDINARY, ORDINARY],
            plans: [{}, {}],
            expected: {
              runs: [{ status: "completed" }, { status: "completed" }],
            },
          });

        case "a-failed-open-leaves-nothing-behind":
          return codexFixture({
            scripts: [],
            spawnFails: true,
            plans: [],
            concurrentStarts: 1,
            expected: { runs: [], startOutcomes: ["backend unavailable"] },
          });

        case "one-active-run-per-subagent":
          return codexFixture({
            scripts: [{ frames: [{ frame: "hold" }] }],
            plans: [{ cancel: true }],
            resumeWhileRunning: true,
            expected: {
              runs: [{ status: "cancelled" }],
              resumeWhileRunning: "Subagent already running",
            },
          });

        case "observations-reduce-in-accepted-order":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  transcriptTexts: [...ORDINARY_TEXTS],
                  finalOutput: "the answer",
                  toolStatuses: ["completed"],
                },
              ],
            },
          });

        case "exactly-one-ending-wins":
          // Codex's own version of two competing endings, and it is the one
          // ADR-0012 is about: the final agent message has been observed, and
          // the cancel arrives before the Turn's completion frame does. The
          // answer the Run already had wins and the interruption is late.
          return codexFixture({
            scripts: [answersThenHolds("the answer")],
            deliveredObservations: 1,
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "completed", finalOutput: "the answer" }],
            },
          });

        case "cancellation-terminates-with-partial-output":
          return codexFixture({
            scripts: [
              {
                frames: [
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "a partial answer",
                      phase: "commentary",
                    },
                  },
                  {
                    frame: "item-started",
                    item: { kind: "command", id: "c1", command: "sleep 60" },
                  },
                  { frame: "hold" },
                ],
              },
            ],
            // The commentary message, the command's tool-call part, its
            // running progress, and the activity that names it.
            deliveredObservations: 4,
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
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            trace: [],
            expected: { runs: [{ status: "completed" }] },
          });

        case "late-events-cannot-mutate-a-terminal-run":
          return codexFixture({
            scripts: [answersThenHolds("the answer")],
            deliveredObservations: 1,
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
          // The App Server dies mid-Turn, which is the transport failure the
          // adapter has to classify as failed while keeping what it saw. The
          // spike found that no terminal Turn frame ever arrives for this, so
          // the ending comes from process exit and from nothing else.
          return codexFixture({
            scripts: [
              {
                frames: [
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "first",
                      phase: "commentary",
                    },
                  },
                  { frame: "exit", code: null, signal: "SIGKILL" },
                ],
              },
            ],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "failed",
                  finalOutput: "first",
                  diagnosticCategories: ["transport-loss"],
                },
              ],
            },
          });

        case "a-run-may-settle-with-no-observations":
          // A Turn that was named and never said anything, cancelled before
          // the server had produced a frame. The stand-in ignores the
          // interrupt, so not even the interrupted completion frame arrives —
          // which is what makes "no observations at all" a fact rather than a
          // race with the reader.
          return codexFixture({
            scripts: [{ frames: [{ frame: "hold" }] }],
            onInterrupt: "ignore",
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "cancelled", cancellationReason: "requested" }],
            },
          });

        case "observations-carry-no-provider-vocabulary":
          return codexFixture({
            scripts: [
              {
                frames: [
                  ...gates(1),
                  {
                    frame: "item-started",
                    item: { kind: "webSearch", id: "w1", query: "effect" },
                  },
                  {
                    frame: "item-completed",
                    item: { kind: "webSearch", id: "w1", query: "effect" },
                  },
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the answer",
                      phase: "final_answer",
                    },
                  },
                  {
                    frame: "usage",
                    total: { totalTokens: 7, inputTokens: 5, outputTokens: 2 },
                    last: { totalTokens: 7 },
                    window: WINDOW,
                  },
                  { frame: "completed" },
                ],
              },
            ],
            // Taken and never echoed, so nothing claims it.
            steerPolicies: ["accept-silently"],
            plans: [
              {
                controls: [{ type: "steer", text: "a Control nobody echoed" }],
              },
            ],
            expected: {
              runs: [{ status: "completed", steerOutcomes: ["accepted"] }],
            },
          });

        case "capacity-rejection-is-immediate":
          return codexFixture({
            scripts: [{ frames: [{ frame: "hold" }] }],
            plans: [{ cancel: true }],
            policy: lowered({ maxActiveRuns: 1 }),
            concurrentStarts: 2,
            expected: {
              runs: [{ status: "cancelled" }],
              startOutcomes: ["started", "at capacity"],
            },
          });

        case "shutdown-rejects-new-work":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [],
            concurrentStarts: 1,
            shutdownFirst: true,
            expected: { runs: [], startOutcomes: ["shutting down"] },
          });

        case "a-late-waiter-reads-the-stored-result":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{ waitAfterSettlement: true }],
            expected: { runs: [{ status: "completed" }] },
          });

        case "an-evicted-result-answers-expired":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            policy: lowered({ maxResultBytes: 4_096, resultStoreBytes: 8_192 }),
            evictOldest: true,
            expected: { runs: [{ status: "completed" }] },
          });

        case "steering-admission-follows-the-declared-capability":
          return codexFixture({
            scripts: [
              {
                frames: [
                  ...gates(2),
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the answer",
                      phase: "final_answer",
                    },
                  },
                  { frame: "completed" },
                ],
              },
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
          // The protocol itself refuses guidance for the wrong Turn — every
          // steer names `expectedTurnId` — and the adapter's consumer awaits
          // each request, so one is in flight at a time by construction. The
          // `await-steer` gates make the *order* a fact about the script.
          return codexFixture({
            scripts: [
              {
                frames: [
                  ...gates(3),
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the answer",
                      phase: "final_answer",
                    },
                  },
                  { frame: "completed" },
                ],
              },
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
          // The Control is genuinely delivered to the first Run — the gate
          // proves it — and the second Run, on the same retained root, gets
          // nothing. The first Run is not cancelled, so the delivery side is
          // assertable rather than raced against a cancel.
          return codexFixture({
            scripts: [
              {
                frames: [
                  ...gates(1),
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "first",
                      phase: "final_answer",
                    },
                  },
                  { frame: "completed" },
                ],
              },
              {
                frames: [
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m2",
                      text: "second",
                      phase: "final_answer",
                    },
                  },
                  { frame: "completed" },
                ],
              },
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
                },
                { status: "completed", finalOutput: "second" },
              ],
              controlsReceived: ["only for the first Run"],
            },
          });

        case "a-user-observation-appears-only-on-confirmation":
          // The first steer is echoed as a user-message item carrying the
          // client id the adapter sent; the second is accepted and never
          // echoed. Only the first becomes a `user` observation, because only
          // the first has provider evidence behind it.
          return codexFixture({
            scripts: [
              {
                frames: [
                  ...gates(2),
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the answer",
                      phase: "final_answer",
                    },
                  },
                  { frame: "completed" },
                ],
              },
            ],
            steerPolicies: ["accept", "accept-silently"],
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
                  transcriptTexts: ["confirmed", "the answer"],
                },
              ],
              controlsReceived: ["confirmed", "unconfirmed"],
            },
          });

        case "a-full-mailbox-answers-immediately":
          // The server takes the first steer and never answers it, so the
          // consumer is still awaiting that request and everything behind it
          // stays in the mailbox — which is where the bound is, and where a
          // caller learns at once that there is no room.
          return codexFixture({
            scripts: [{ frames: [{ frame: "hold" }] }],
            steerPolicies: ["hang"],
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
          return codexFixture({
            scripts: [{ frames: [{ frame: "hold" }] }],
            plans: [{ cancel: true, steerAfterCancel: true }],
            expected: { runs: [{ status: "cancelled" }] },
          });

        case "usage-deltas-are-run-local":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 40, output: 10 },
                  // One completed Turn is one turn, which is what Codex counts.
                  turns: 1,
                },
              ],
            },
          });

        case "reconciliation-does-not-double-count":
          // Codex's terminal reconciliation carries turns and **no usage at
          // all**: the spike found that `turn/completed` reports no usage, so
          // the last usage notification before it is the Run's figure and
          // there is nothing authoritative to recompute a total from. The
          // property therefore holds by construction — nothing can be double
          // counted — and the streamed figure is the reported one exactly.
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  usageTotals: { input: 40, output: 10 },
                  turns: 1,
                },
              ],
            },
          });

        case "context-occupancy-is-a-gauge":
          // Two readings in one Turn. `tokenUsage.last` is the last request's
          // own total, so the second reading replaces the first rather than
          // adding to it.
          return codexFixture({
            scripts: [
              {
                frames: [
                  {
                    frame: "usage",
                    total: { totalTokens: 1_000, inputTokens: 1_000 },
                    last: { totalTokens: 1_000 },
                    window: WINDOW,
                  },
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the answer",
                      phase: "final_answer",
                    },
                  },
                  {
                    frame: "usage",
                    total: {
                      totalTokens: 1_800,
                      inputTokens: 1_600,
                      cachedInputTokens: 200,
                    },
                    last: { totalTokens: 1_800 },
                    window: WINDOW,
                  },
                  { frame: "completed" },
                ],
              },
            ],
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  // The latest reading, never the sum of the readings.
                  context: { tokens: 1_800, window: WINDOW },
                },
              ],
            },
          });

        case "a-replayed-transcript-adds-no-usage":
          // Codex's retained context, which is the thing this scenario is
          // about. See the module comment for why the second Turn is cut
          // short after its answer.
          return codexFixture({
            scripts: [
              {
                frames: [
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the first answer",
                      phase: "final_answer",
                    },
                  },
                  {
                    frame: "usage",
                    total: { totalTokens: 100, inputTokens: 100 },
                    last: { totalTokens: 100 },
                    window: WINDOW,
                  },
                  { frame: "completed" },
                ],
              },
              {
                frames: [
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m2",
                      text: "answered from the retained thread",
                      phase: "final_answer",
                    },
                  },
                  {
                    // The conversation's cumulative total has not moved: this
                    // Turn answered from what the thread already held.
                    frame: "usage",
                    total: { totalTokens: 100, inputTokens: 100 },
                    last: { totalTokens: 100 },
                    window: WINDOW,
                  },
                  { frame: "hold" },
                ],
              },
            ],
            // The answer, the usage delta, and the gauge that came with it.
            deliveredObservations: 3,
            plans: [{}, { cancel: true }],
            expected: {
              runs: [
                { status: "completed", usageTotals: { input: 100 }, turns: 1 },
                {
                  status: "completed",
                  usageTotals: { input: 0 },
                  turns: 0,
                  transcriptTexts: ["answered from the retained thread"],
                },
              ],
            },
          });

        case "a-resumed-run-excludes-prior-usage":
          // `tokenUsage.total` is conversation-cumulative, which is ADR-0027's
          // second exception. The adapter differences it against the total the
          // Turn started from, so the resumed Run is charged 75 rather than
          // the 175 the thread has now spent.
          return codexFixture({
            scripts: [
              {
                frames: [
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m1",
                      text: "the first answer",
                      phase: "final_answer",
                    },
                  },
                  {
                    frame: "usage",
                    total: {
                      totalTokens: 140,
                      inputTokens: 100,
                      outputTokens: 40,
                    },
                    last: { totalTokens: 140 },
                    window: WINDOW,
                  },
                  { frame: "completed" },
                ],
              },
              {
                frames: [
                  {
                    frame: "item-completed",
                    item: {
                      kind: "agentMessage",
                      id: "m2",
                      text: "the second answer",
                      phase: "final_answer",
                    },
                  },
                  {
                    frame: "usage",
                    total: {
                      totalTokens: 240,
                      inputTokens: 175,
                      outputTokens: 65,
                    },
                    last: { totalTokens: 100 },
                    window: WINDOW,
                  },
                  { frame: "completed" },
                ],
              },
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
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "projections-stay-within-their-limits":
          return codexFixture({
            scripts: [
              {
                frames: [
                  ...Array.from(
                    { length: 6 },
                    (_unused, index) =>
                      ({
                        frame: "item-completed",
                        item: {
                          kind: "agentMessage",
                          id: `m${index}`,
                          text: `message ${index}`,
                          phase: "final_answer",
                        },
                      }) as const,
                  ),
                  { frame: "completed" },
                ],
              },
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
          return codexFixture({
            scripts: [answersThenHolds("the answer")],
            deliveredObservations: 1,
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "completed", finalOutput: "the answer" }],
              notifications: 1,
            },
          });

        case "wait-and-result-observe-the-same-value":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "a-notification-follows-storage":
          return codexFixture({
            scripts: [ORDINARY],
            plans: [{}],
            expected: { runs: [{ status: "completed" }], notifications: 1 },
          });

        case "a-notification-retry-cannot-duplicate-or-alter-settlement":
          return codexFixture({
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
 * What a Codex rig skips.
 *
 * Nothing, and the M6 specification expected otherwise — it allowed skips
 * "where the terminal transcript snapshot capability gates a scenario". As
 * with Claude, it turns out no shared scenario is gated on that capability.
 * The two that came closest were `reconciliation-does-not-double-count`, which
 * Codex satisfies by carrying no usage in its snapshot at all — the spike
 * found that `turn/completed` reports none — and
 * `a-replayed-transcript-adds-no-usage`, which Codex demonstrates through its
 * retained thread rather than through replayed frames. Both run. So the skip
 * list is empty, and the rig test asserts the empty list rather than leaving
 * it to be read off the output.
 */
export function codexConformanceSkips(): readonly BackendConformanceScenario[] {
  return [];
}
