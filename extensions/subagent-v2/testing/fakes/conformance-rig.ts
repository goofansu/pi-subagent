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
  type Profile,
  runDiagnostic,
  type SubagentContext,
  subagentId,
} from "../../domain/index.ts";
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

const context: SubagentContext = {
  subagentId: subagentId("conformance-subagent"),
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

/** Scenarios the one-shot backend genuinely cannot exercise. */
const ONE_SHOT_SKIPS: readonly BackendConformanceScenario[] = [
  // Steering is not declared, so there is no in-order delivery to observe,
  // no confirmation to require, and no admitted Control to leak.
  "controls-are-delivered-serially-in-order",
  "a-control-cannot-leak-into-the-next-run",
  "a-user-observation-appears-only-on-confirmation",
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
  parts: Omit<
    BackendConformanceFixture,
    "backend" | "profile" | "context" | "counters"
  >,
  diagnose?: FakeBackendOptions["diagnose"],
): BackendConformanceFixture {
  const handle = build(kind, {
    scripts: runScripts,
    ...(parts.trace === undefined ? {} : { trace: parts.trace }),
    ...(diagnose === undefined ? {} : { diagnose }),
    ...(parts.plans.some((plan) => plan.cancelWhen)
      ? { gates: { hold: Deferred.makeUnsafe<void>() } }
      : {}),
  });
  return {
    backend: handle.backend,
    profile,
    context,
    counters: handle.counters,
    ...parts,
  };
}

/** A script that answers after doing a little work. */
const ORDINARY: readonly FakeStep[] = [
  emitToolCall("read_file", "c1"),
  emitToolProgress("c1", "completed", "40 lines"),
  emitText("the answer"),
  { step: "cumulative-usage", total: { input: 40, output: 10 } },
  { step: "complete" },
];

export function fakeConformanceRig(kind: FakeKind): BackendConformanceRig {
  const skips = kind === "one-shot" ? ONE_SHOT_SKIPS : [];
  const name =
    kind === "resumable" ? "FakeResumableBackend" : "FakeOneShotBackend";

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
            (_subject, filePath) => [
              { filePath, reason: "the fixture always says this" },
            ],
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
              ...(kind === "resumable"
                ? [{ step: "await-control" as const, confirm: true }]
                : []),
              emitText("the answer"),
              { step: "complete" },
            ]),
            {
              plans: [
                { controls: [{ type: "steer", text: "an offered Control" }] },
              ],
              expected: { runs: [{ status: "completed" }] },
            },
          );

        case "resume-or-honest-refusal":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            expected: {
              runs: [{ status: "completed" }],
              resumeBefore:
                kind === "resumable" ? "conversation lost" : "unsupported",
              resumeAfter: kind === "resumable" ? "admitted" : "unsupported",
            },
          });

        case "close-is-idempotent":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            closeTwice: true,
            expected: { runs: [{ status: "completed" }] },
          });

        case "close-releases-every-resource":
          return fixtureOf(kind, scripts(ORDINARY, ORDINARY), {
            plans: kind === "resumable" ? [{}, {}] : [{}],
            expected: {
              runs:
                kind === "resumable"
                  ? [{ status: "completed" }, { status: "completed" }]
                  : [{ status: "completed" }],
            },
          });

        case "observations-reduce-in-accepted-order":
          return fixtureOf(kind, scripts(ORDINARY), {
            plans: [{}],
            expected: {
              runs: [
                {
                  status: "completed",
                  observationKinds: [
                    "message",
                    "tool_progress",
                    "message",
                    "usage",
                  ],
                  transcriptTexts: ["", "the answer"],
                  finalOutput: "the answer",
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
              plans: [{ cancelWhen: Deferred.makeUnsafe<void>() }],
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
              emitText("second"),
              emitText("third"),
              { step: "complete" },
            ]),
            {
              plans: [{ sinkFailsAt: 2 }],
              expected: {
                runs: [{ status: "failed", finalOutput: "first" }],
              },
            },
          );

        case "a-run-may-settle-with-no-observations":
          return fixtureOf(kind, scripts([{ step: "hang" }]), {
            plans: [{ cancelWhen: Deferred.makeUnsafe<void>() }],
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

        case "unsupported-steering-is-refused":
          // Only meaningful for a backend that declared no steering. A
          // steerable backend has nothing to refuse, so it is a visible skip.
          if (kind === "resumable") return undefined;
          return fixtureOf(kind, scripts(ORDINARY), {
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
                  steerOutcomes: ["unsupported", "unsupported"],
                },
              ],
              controlsReceived: [],
            },
          });

        case "controls-are-delivered-serially-in-order":
          return fixtureOf(
            kind,
            scripts([
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
              // The first Run is offered a Control and never takes it.
              [emitText("first"), { step: "complete" }],
              // The second Run asks for one and must get nothing.
              [
                { step: "await-control", confirm: true },
                emitText("second"),
                { step: "complete" },
              ],
            ),
            {
              plans: [
                { controls: [{ type: "steer", text: "never taken" }] },
                {},
              ],
              expected: {
                runs: [
                  { status: "completed", finalOutput: "first" },
                  { status: "completed", finalOutput: "second" },
                ],
                controlsReceived: [],
              },
            },
          );

        case "a-user-observation-appears-only-on-confirmation":
          return fixtureOf(
            kind,
            scripts([
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
                    transcriptTexts: ["confirmed", "the answer"],
                  },
                ],
                controlsReceived: ["confirmed", "unconfirmed"],
              },
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
                reconciliation: {
                  usage: { input: 50, output: 12 },
                  turns: 2,
                },
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
                  },
                ],
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
      }
    },
  };
}

/** The scenarios a rig for this fake is expected to skip. */
export function fakeConformanceSkips(
  kind: FakeKind,
): readonly BackendConformanceScenario[] {
  return kind === "one-shot"
    ? ONE_SHOT_SKIPS
    : ["unsupported-steering-is-refused"];
}
