/**
 * The conformance rig for the two fake backends.
 *
 * One rig builder, parameterized by which fake it is building for. That is
 * deliberate for the same reason the two fakes share a script runner: if the
 * resumable rig and the one-shot rig were written separately, a capability
 * scenario could pass because the two rigs differ rather than because the core
 * enforces anything.
 *
 * Where the one-shot backend cannot support a scenario, the rig returns
 * `undefined` and the suite records a visible skip. Those skips are the whole
 * observable difference between the two rigs, and the tests that use this
 * builder assert exactly which ones they are.
 */

import { Deferred } from "effect";
import {
  contextGauge,
  DEFAULT_BACKEND_ID,
  DEFAULT_PROJECTION_BOUNDS,
  type Profile,
  runDiagnostic,
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
import {
  createFakeOneShotBackend,
  createFakeResumableBackend,
  type FakeBackendHandle,
  type FakeBackendOptions,
} from "./backend.ts";
import {
  emitText,
  emitToolCall,
  emitToolProgress,
  type FakeRunScript,
  type FakeStep,
  scripts,
} from "./script.ts";

export type FakeKind = "resumable" | "one-shot";

const profile: Profile = {
  name: "conformance-worker",
  description: "A conformance worker",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Do the conformance fixture.",
};

/** Scenarios the one-shot backend genuinely cannot exercise. */
const ONE_SHOT_SKIPS: readonly BackendConformanceScenario[] = [
  // Steering is not declared, so there is no in-order delivery to observe,
  // no confirmation to require, no admitted Control to leak, and no mailbox
  // to fill or to close.
  "controls-are-delivered-serially-in-order",
  "a-control-cannot-leak-into-the-next-run",
  "a-user-observation-appears-only-on-confirmation",
  "a-full-mailbox-answers-immediately",
  "a-closed-mailbox-refuses-after-cancel",
  // No terminal snapshot, so there is no reconciliation to double count.
  "reconciliation-does-not-double-count",
  // No resume, so there is no second Run on the same conversation.
  "a-replayed-transcript-adds-no-usage",
  "a-resumed-run-excludes-prior-usage",
];

function build(kind: FakeKind, options: FakeBackendOptions): FakeBackendHandle {
  return kind === "resumable"
    ? createFakeResumableBackend(options)
    : createFakeOneShotBackend(options);
}

/** A fixture over one fake, with the plans and expectations of one scenario. */
function fixtureOf(
  kind: FakeKind,
  runScripts: readonly FakeRunScript[],
  parts: Omit<BackendConformanceFixture, "backend" | "profile" | "counters">,
  extra?: {
    readonly diagnose?: FakeBackendOptions["diagnose"];
    readonly open?: FakeBackendOptions["open"];
  },
): BackendConformanceFixture {
  const handle = build(kind, {
    scripts: runScripts,
    ...(parts.trace === undefined ? {} : { trace: parts.trace }),
    ...(extra?.diagnose === undefined ? {} : { diagnose: extra.diagnose }),
    ...(extra?.open === undefined ? {} : { open: extra.open }),
    // Every scenario that cancels or holds a Run open waits on this gate, and
    // nothing ever completes it: the cancel is what ends the Run.
    gates: { hold: holdGate() },
  });
  return {
    backend: handle.backend,
    profile: { ...profile, backend: handle.backend.id },
    counters: handle.counters,
    ...parts,
  };
}

/**
 * A gate nothing completes.
 *
 * Built per fixture so two fixtures cannot share one, and made outside an
 * Effect because a rig is plain data the suite runs later.
 */
function holdGate(): Deferred.Deferred<void> {
  return Deferred.makeUnsafe<void>();
}

/** A script that answers after doing a little work. */
const ORDINARY: readonly FakeStep[] = [
  emitToolCall("read_file", "c1"),
  emitToolProgress("c1", "completed", "40 lines"),
  emitText("the answer"),
  { step: "cumulative-usage", total: { input: 40, output: 10 } },
  { step: "complete" },
];

/** A policy with the bounds one scenario needs lowered. */
function lowered(overrides: Partial<RuntimePolicy>): RuntimePolicy {
  return { ...DEFAULT_RUNTIME_POLICY, ...overrides };
}

export function fakeConformanceRig(kind: FakeKind): BackendConformanceRig {
  const skips = kind === "one-shot" ? ONE_SHOT_SKIPS : [];
  const name =
    kind === "resumable" ? "FakeResumableBackend" : "FakeOneShotBackend";
  const steerable = kind === "resumable";

  return {
    name,
    build(scenario) {
      if (skips.includes(scenario)) return undefined;

      switch (scenario) {
        case "validation-is-deterministic":
          return fixtureOf(
            kind,
            scripts(),
            {
              plans: [],
              expected: {
                runs: [],
                profileDiagnostics: ["the fixture always says this"],
              },
            },
            {
              diagnose: (_subject, filePath) => [
                { filePath, reason: "the fixture always says this" },
              ],
            },
          );

        case "open-creates-no-run":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [],
            expected: { runs: [] },
          });

        case "capabilities-are-enforced":
          return fixtureOf(
            kind,
            scripts([
              ...(steerable
                ? [{ step: "await-control" as const, confirm: true }]
                : []),
              emitText("the answer"),
              { step: "complete" },
            ]),
            {
              plans: [
                { controls: [{ type: "steer", text: "an offered Control" }] },
              ],
              expected: {
                runs: [
                  {
                    status: "completed",
                    steerOutcomes: [steerable ? "accepted" : "unsupported"],
                  },
                ],
                controlsReceived: steerable ? ["an offered Control"] : [],
              },
            },
          );

        case "resume-or-honest-refusal":
          return fixtureOf(kind, scripts(ORDINARY, ORDINARY), {
            plans: steerable ? [{}, {}] : [{}],
            expected: {
              runs: steerable
                ? [{ status: "completed" }, { status: "completed" }]
                : [{ status: "completed" }],
            },
          });

        case "close-is-idempotent":
          // The Session Scope closes the BackendAgent once, however many ways
          // it is reached: shutdown closes the Subagent, and the scope closes
          // it again on the way out.
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "close-releases-every-resource":
          return fixtureOf(kind, scripts(ORDINARY, ORDINARY), {
            plans: steerable ? [{}, {}] : [{}],
            expected: {
              runs: steerable
                ? [{ status: "completed" }, { status: "completed" }]
                : [{ status: "completed" }],
            },
          });

        case "a-failed-open-leaves-nothing-behind":
          return fixtureOf(
            kind,
            scripts(ORDINARY),
            {
              plans: [],
              concurrentStarts: 1,
              expected: { runs: [], startOutcomes: ["backend unavailable"] },
            },
            { open: { open: "fails", reason: "the provider said no" } },
          );

        case "one-active-run-per-subagent":
          return fixtureOf(
            kind,
            scripts([{ step: "await-gate", gate: "hold" }, emitText("done")]),
            {
              plans: [{ cancel: true }],
              resumeWhileRunning: true,
              expected: {
                runs: [{ status: "cancelled" }],
                resumeWhileRunning: "Subagent already running",
              },
            },
          );

        case "observations-reduce-in-accepted-order":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  transcriptTexts: ["", "the answer"],
                  finalOutput: "the answer",
                  toolStatuses: ["completed"],
                },
              ],
            },
          });

        case "exactly-one-ending-wins":
          return fixtureOf(
            kind,
            scripts([
              emitText("the answer"),
              { step: "announce-ending", ending: { ending: "answered" } },
              {
                step: "complete",
                ending: { ending: "cancelled", reason: "shutdown" },
              },
            ]),
            {
              plans: [{}],
              // The first ending wins; the bundle's later one is reported late.
              expected: {
                runs: [{ status: "completed", finalOutput: "the answer" }],
              },
            },
          );

        case "cancellation-terminates-with-partial-output":
          return fixtureOf(
            kind,
            scripts([
              emitText("a partial answer"),
              emitToolCall("bash", "c1"),
              { step: "await-gate", gate: "hold" },
              emitText("never said"),
              { step: "complete" },
            ]),
            {
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
            },
          );

        case "result-follows-scope-closure":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            trace: [],
            expected: { runs: [{ status: "completed" }] },
          });

        case "late-events-cannot-mutate-a-terminal-run":
          return fixtureOf(
            kind,
            scripts([
              emitText("the answer"),
              { step: "announce-ending", ending: { ending: "answered" } },
              emitText("a frame nobody asked for"),
              { step: "cumulative-usage", total: { input: 9_999 } },
              { step: "complete" },
            ]),
            {
              plans: [{}],
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
            },
          );

        case "a-failing-sink-cannot-strand-the-execution":
          return fixtureOf(
            kind,
            scripts([
              emitText("first"),
              { step: "defect", message: "the adapter threw" },
            ]),
            {
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
            },
          );

        case "a-run-may-settle-with-no-observations":
          return fixtureOf(kind, scripts([{ step: "hang" }]), {
            plans: [{ cancel: true }],
            expected: {
              runs: [{ status: "cancelled", cancellationReason: "requested" }],
            },
          });

        case "observations-carry-no-provider-vocabulary":
          return fixtureOf(
            kind,
            scripts([
              ...ORDINARY.slice(0, -1),
              {
                step: "emit",
                observation: {
                  kind: "diagnostic",
                  diagnostic: runDiagnostic("other", "something happened"),
                },
              },
              {
                step: "emit",
                observation: { kind: "activity", activity: "working" },
              },
              {
                step: "emit",
                observation: { kind: "model", model: "model-a" },
              },
              {
                step: "emit",
                observation: { kind: "context", context: contextGauge(100) },
              },
              { step: "complete" },
            ]),
            {
              plans: [{}],
              expected: { runs: [{ status: "completed" }] },
            },
          );

        case "capacity-rejection-is-immediate":
          return fixtureOf(
            kind,
            scripts([{ step: "await-gate", gate: "hold" }, emitText("done")]),
            {
              plans: [{ cancel: true }],
              policy: lowered({ maxActiveRuns: 1 }),
              concurrentStarts: 2,
              expected: {
                runs: [{ status: "cancelled" }],
                startOutcomes: ["started", "at capacity"],
              },
            },
          );

        case "shutdown-rejects-new-work":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [],
            concurrentStarts: 1,
            shutdownFirst: true,
            expected: { runs: [], startOutcomes: ["shutting down"] },
          });

        case "a-late-waiter-reads-the-stored-result":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{ waitAfterSettlement: true }],
            expected: { runs: [{ status: "completed" }] },
          });

        case "an-evicted-result-answers-expired":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            // Room for a couple of results, so filler forces the choice.
            policy: lowered({ maxResultBytes: 4_096, resultStoreBytes: 8_192 }),
            evictOldest: true,
            expected: { runs: [{ status: "completed" }] },
          });

        case "steering-admission-follows-the-declared-capability": {
          // The same two Controls are offered to both kinds of backend. What
          // differs is only what each declared, which is the point.
          return fixtureOf(
            kind,
            scripts([
              ...(steerable
                ? [
                    { step: "await-control" as const, confirm: true },
                    { step: "await-control" as const, confirm: true },
                  ]
                : []),
              emitText("the answer"),
              { step: "complete" },
            ]),
            {
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
                    steerOutcomes: steerable
                      ? ["accepted", "accepted"]
                      : ["unsupported", "unsupported"],
                  },
                ],
                controlsReceived: steerable ? ["first", "second"] : [],
              },
            },
          );
        }

        case "controls-are-delivered-serially-in-order":
          return fixtureOf(
            kind,
            scripts([
              emitText("under way"),
              { step: "await-control", confirm: true },
              { step: "await-control", confirm: true },
              { step: "await-control", confirm: true },
              emitText("the answer"),
              { step: "complete" },
            ]),
            {
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
            },
          );

        case "a-control-cannot-leak-into-the-next-run":
          return fixtureOf(
            kind,
            scripts(
              // The first Run is offered a Control and never takes it: it is
              // waiting when the cancel arrives, and cancellation discards
              // what was admitted and never sent.
              [emitText("first"), { step: "await-gate", gate: "hold" }],
              // The second Run asks for one. Nothing is admitted to it, so it
              // waits — and what releases it is its own mailbox closing when
              // it is cancelled, with `undefined` meaning drained. If the
              // first Run's Control could reach it, this is where it would.
              [
                emitText("second"),
                { step: "await-control", confirm: true },
                // Whatever the take answered, the Run cannot finish on its
                // own: the cancel is what ends it, so the outcome does not
                // depend on which of the two got there first.
                { step: "await-gate", gate: "hold" },
              ],
            ),
            {
              plans: [
                {
                  controls: [{ type: "steer", text: "never taken" }],
                  cancel: true,
                },
                { cancel: true },
              ],
              expected: {
                runs: [
                  {
                    status: "cancelled",
                    finalOutput: "first",
                    steerOutcomes: ["accepted"],
                  },
                  { status: "cancelled", finalOutput: "second" },
                ],
                controlsReceived: [],
              },
            },
          );

        case "a-user-observation-appears-only-on-confirmation":
          return fixtureOf(
            kind,
            scripts([
              emitText("under way"),
              { step: "await-control", confirm: true },
              { step: "await-control", confirm: false },
              emitText("the answer"),
              { step: "complete" },
            ]),
            {
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
                    // Only the confirmed one is in the transcript.
                    transcriptTexts: ["under way", "confirmed", "the answer"],
                  },
                ],
                controlsReceived: ["confirmed", "unconfirmed"],
              },
            },
          );

        case "a-full-mailbox-answers-immediately":
          return fixtureOf(
            kind,
            scripts([
              emitText("under way"),
              { step: "await-gate", gate: "hold" },
              { step: "complete" },
            ]),
            {
              // Two fit; the third is refused at once with nothing queued.
              policy: lowered({
                controls: {
                  maxPending: 2,
                  maxMessageBytes: 16 * 1024,
                  maxPendingBytes: 64 * 1024,
                },
              }),
              plans: [{ floodControls: 3, cancel: true }],
              expected: {
                runs: [
                  {
                    status: "cancelled",
                    floodOutcomes: ["accepted", "accepted", "mailbox full"],
                  },
                ],
              },
            },
          );

        case "a-closed-mailbox-refuses-after-cancel":
          return fixtureOf(
            kind,
            scripts([
              emitText("under way"),
              { step: "await-gate", gate: "hold" },
              { step: "complete" },
            ]),
            {
              plans: [{ cancel: true, steerAfterCancel: true }],
              expected: { runs: [{ status: "cancelled" }] },
            },
          );

        case "usage-deltas-are-run-local":
          return fixtureOf(kind, scripts(ORDINARY), {
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

        case "reconciliation-does-not-double-count":
          return fixtureOf(
            kind,
            scripts([
              emitText("a partial answer"),
              { step: "cumulative-usage", total: { input: 40, output: 10 } },
              {
                step: "complete",
                reconciliation: { usage: { input: 50, output: 12 }, turns: 2 },
              },
            ]),
            {
              plans: [{}],
              expected: {
                runs: [
                  {
                    status: "completed",
                    // Replaced, not 40 + 50.
                    usageTotals: { input: 50, output: 12 },
                    turns: 2,
                    // The snapshot disagreed about usage and raised the turn
                    // count, so the Run says so in its own diagnostics.
                    diagnosticCategories: ["reconciliation-difference"],
                  },
                ],
                reconciliationDifferences: 1,
              },
            },
          );

        case "context-occupancy-is-a-gauge":
          return fixtureOf(
            kind,
            scripts([
              {
                step: "emit",
                observation: { kind: "context", context: contextGauge(1_000) },
              },
              emitText("thinking"),
              {
                step: "emit",
                observation: {
                  kind: "context",
                  context: contextGauge(1_800, 200_000),
                },
              },
              emitText("the answer"),
              { step: "complete" },
            ]),
            {
              plans: [{}],
              expected: {
                runs: [
                  {
                    status: "completed",
                    // The latest reading, not 1000 + 1800.
                    context: { tokens: 1_800, window: 200_000 },
                  },
                ],
              },
            },
          );

        case "a-replayed-transcript-adds-no-usage":
          return fixtureOf(
            kind,
            scripts(
              [
                emitText("first answer"),
                { step: "cumulative-usage", total: { input: 100 } },
                { step: "complete" },
              ],
              [
                // The provider replays the conversation, then does no work.
                { step: "replay-history" },
                { step: "complete" },
              ],
            ),
            {
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
            },
          );

        case "a-resumed-run-excludes-prior-usage":
          return fixtureOf(
            kind,
            scripts(
              [
                emitText("first answer"),
                { step: "cumulative-usage", total: { input: 100, output: 40 } },
                { step: "complete" },
              ],
              [
                emitText("second answer"),
                { step: "cumulative-usage", total: { input: 175, output: 65 } },
                { step: "complete" },
              ],
            ),
            {
              plans: [{}, {}],
              expected: {
                runs: [
                  {
                    status: "completed",
                    usageTotals: { input: 100, output: 40 },
                  },
                  {
                    status: "completed",
                    // The difference alone, though the provider's cumulative
                    // reading covers both Runs.
                    usageTotals: { input: 75, output: 25 },
                  },
                ],
              },
            },
          );

        case "only-the-repository-writes-snapshots":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "projections-stay-within-their-limits":
          return fixtureOf(
            kind,
            scripts([
              ...Array.from({ length: 6 }, (_unused, index) =>
                emitText(`message ${index}`),
              ),
              { step: "complete" },
            ]),
            {
              // Tight enough that the Run overruns them and the bounding has
              // to say so.
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
            },
          );

        case "settlement-stores-the-result-exactly-once":
          // Two endings compete, so a runtime that settled twice would have
          // something to settle twice *with*. A script with one ending would
          // make the counter zero by construction.
          return fixtureOf(
            kind,
            scripts([
              emitText("the answer"),
              { step: "announce-ending", ending: { ending: "answered" } },
              { step: "complete", ending: { ending: "failed" } },
            ]),
            {
              plans: [{}],
              expected: {
                runs: [{ status: "completed", finalOutput: "the answer" }],
                notifications: 1,
              },
            },
          );

        case "wait-and-result-observe-the-same-value":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            expected: { runs: [{ status: "completed" }] },
          });

        case "a-notification-follows-storage":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            expected: { runs: [{ status: "completed" }], notifications: 1 },
          });

        case "a-notification-retry-cannot-duplicate-or-alter-settlement":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            sinkFailsOnce: true,
            // No delay between attempts, so the retry runs without a clock.
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
 * The scenarios a rig for this fake is expected to skip.
 *
 * A backend that declares every capability skips nothing: every scenario is
 * written so that it means something for whichever capabilities the backend
 * under test declared, and a skip therefore always names a capability the
 * backend does not have.
 */
export function fakeConformanceSkips(
  kind: FakeKind,
): readonly BackendConformanceScenario[] {
  return kind === "one-shot" ? ONE_SHOT_SKIPS : [];
}
