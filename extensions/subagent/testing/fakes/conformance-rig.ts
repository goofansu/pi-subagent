/**
 * The conformance rig for the two fake backends.
 *
 * One rig builder and one shared scenario table serve both fakes. The visible
 * skip list is the intended distinction in scenario coverage; that keeps a
 * capability scenario passing because the core enforces the declaration, not
 * because a separately built one-shot rig happens to agree.
 *
 * The provider-neutral plans and expectations live in the shared table. This
 * file contains only fake scripts, fake-only instrumentation, visible skips,
 * and reasoned capability-shaped row/script overrides. Those small overrides
 * express what an unsupported operation can drive or observe; they do not
 * create a second scenario definition.
 */

import { Deferred } from "effect";
import {
  contextGauge,
  DEFAULT_BACKEND_ID,
  type Profile,
  runDiagnostic,
} from "../../domain/index.ts";
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

interface FakeInstrumentation {
  readonly diagnose?: FakeBackendOptions["diagnose"];
  readonly open?: FakeBackendOptions["open"];
}

/** Fake mechanisms that are not part of the provider-neutral scenario row. */
const FAKE_INSTRUMENTATION: Partial<
  Record<BackendConformanceScenario, FakeInstrumentation>
> = {
  "validation-is-deterministic": {
    diagnose: (_subject, filePath) => [
      { filePath, reason: "the fixture always says this" },
    ],
  },
  "a-failed-open-leaves-nothing-behind": {
    open: { open: "fails", reason: "the provider said no" },
  },
};

/** A fixture over one fake, composed from the shared row and a fake script. */
function fixtureOf(
  kind: FakeKind,
  runScripts: readonly FakeRunScript[],
  row: BackendConformanceScenarioRow,
  instrumentation: FakeInstrumentation | undefined,
) {
  const handle = build(kind, {
    scripts: runScripts,
    ...(row.trace === undefined ? {} : { trace: row.trace }),
    ...(instrumentation?.diagnose === undefined
      ? {}
      : { diagnose: instrumentation.diagnose }),
    ...(instrumentation?.open === undefined
      ? {}
      : { open: instrumentation.open }),
    gates: { hold: holdGate() },
  });
  return {
    backend: handle.backend,
    profile: { ...profile, backend: handle.backend.id },
    counters: handle.counters,
  };
}

/** A gate nothing completes; cancellation is what releases the Run. */
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

const QUIET_PROVIDER_WAIT_MILLIS = 1_000;

/** One fake-vocabulary script sequence for every shared scenario. */
const FAKE_SCRIPTS = {
  "validation-is-deterministic": scripts(),
  "open-creates-no-run": scripts(ORDINARY),
  "capabilities-are-enforced": scripts([
    { step: "await-control", confirm: true },
    emitText("the answer"),
    { step: "complete" },
  ]),
  "resume-or-honest-refusal": scripts(ORDINARY, ORDINARY),
  "close-is-idempotent": scripts(ORDINARY),
  "close-releases-every-resource": scripts(ORDINARY, ORDINARY),
  "a-failed-open-leaves-nothing-behind": scripts(ORDINARY),
  "one-active-run-per-subagent": scripts([
    { step: "await-gate", gate: "hold" },
    emitText("done"),
  ]),
  "observations-reduce-in-accepted-order": scripts(ORDINARY),
  "exactly-one-ending-is-emitted": scripts([
    emitText("the answer"),
    { step: "decide", ending: { ending: "answered" } },
    { step: "decide", ending: { ending: "cancelled", reason: "shutdown" } },
    { step: "complete", ending: { ending: "cancelled", reason: "shutdown" } },
  ]),
  "cancellation-terminates-with-partial-output": scripts([
    emitText("a partial answer"),
    emitToolCall("bash", "c1"),
    { step: "await-gate", gate: "hold" },
    emitText("never said"),
    { step: "complete" },
  ]),
  "a decided bundle survives a later cancel": scripts([
    {
      step: "decide",
      reconciliation: { finalOutput: "the decided answer" },
    },
    { step: "await-gate", gate: "hold" },
  ]),
  "result-follows-scope-closure": scripts(ORDINARY),
  "cleanup-observations-precede-the-core-ending": scripts([
    {
      step: "emit-in-finalizer",
      observation: {
        kind: "diagnostic",
        diagnostic: {
          category: "other",
          message: "test-only cleanup observation",
        },
      },
    },
    emitText("the answer"),
    { step: "complete" },
  ]),
  "a-failing-sink-cannot-strand-the-execution": scripts([
    emitText("first"),
    { step: "defect", message: "the adapter threw" },
  ]),
  "a-run-may-settle-with-no-observations": scripts([{ step: "hang" }]),
  "cancel-returns-immediately-and-settlement-bounds-an-ignored-stop": scripts([
    emitText("a partial answer"),
    { step: "hang-on-stop" },
  ]),
  "an-execution-settles-when-the-provider-goes-quiet": scripts([
    {
      step: "result-then-quiet",
      waitMillis: QUIET_PROVIDER_WAIT_MILLIS,
    },
  ]),
  "observations-carry-no-provider-vocabulary": scripts([
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
    { step: "emit", observation: { kind: "model", model: "model-a" } },
    {
      step: "emit",
      observation: { kind: "context", context: contextGauge(100) },
    },
    { step: "complete" },
  ]),
  "capacity-rejection-is-immediate": scripts([
    { step: "await-gate", gate: "hold" },
    emitText("done"),
  ]),
  "shutdown-rejects-new-work": scripts(ORDINARY),
  "a-late-waiter-reads-the-stored-result": scripts(ORDINARY),
  "an-evicted-result-answers-expired": scripts(ORDINARY),
  "steering-admission-follows-the-declared-capability": scripts([
    { step: "await-control", confirm: true },
    { step: "await-control", confirm: true },
    emitText("the answer"),
    { step: "complete" },
  ]),
  "controls-are-delivered-serially-in-order": scripts([
    emitText("under way"),
    { step: "await-control", confirm: true },
    { step: "await-control", confirm: true },
    { step: "await-control", confirm: true },
    emitText("the answer"),
    { step: "complete" },
  ]),
  "a-control-cannot-leak-into-the-next-run": scripts(
    [emitText("first"), { step: "await-gate", gate: "hold" }],
    [
      emitText("second"),
      { step: "await-control", confirm: true },
      { step: "await-gate", gate: "hold" },
    ],
  ),
  "a-user-observation-appears-only-on-confirmation": scripts([
    emitText("under way"),
    { step: "await-control", confirm: true },
    { step: "await-control", confirm: false },
    emitText("the answer"),
    { step: "complete" },
  ]),
  "a-full-mailbox-answers-immediately": scripts([
    emitText("under way"),
    { step: "await-gate", gate: "hold" },
    { step: "complete" },
  ]),
  "a-closed-mailbox-refuses-after-cancel": scripts([
    emitText("under way"),
    { step: "await-gate", gate: "hold" },
    { step: "complete" },
  ]),
  "usage-deltas-are-run-local": scripts(ORDINARY),
  "reconciliation-does-not-double-count": scripts([
    emitText("a partial answer"),
    { step: "cumulative-usage", total: { input: 40, output: 10 } },
    {
      step: "complete",
      reconciliation: { usage: { input: 50, output: 12 }, turns: 2 },
    },
  ]),
  "context-occupancy-is-a-gauge": scripts([
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
  "a-replayed-transcript-adds-no-usage": scripts(
    [
      emitText("first answer"),
      { step: "cumulative-usage", total: { input: 100 } },
      { step: "complete" },
    ],
    [{ step: "replay-history" }, { step: "complete" }],
  ),
  "a-resumed-run-excludes-prior-usage": scripts(
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
  "only-the-repository-writes-snapshots": scripts(ORDINARY),
  "projections-stay-within-their-limits": scripts([
    ...Array.from({ length: 6 }, (_unused, index) =>
      emitText(`message ${index}`),
    ),
    { step: "complete" },
  ]),
  "settlement-stores-the-result-exactly-once": scripts([
    emitText("the answer"),
    { step: "decide", ending: { ending: "answered" } },
    { step: "decide", ending: { ending: "failed" } },
    { step: "complete", ending: { ending: "failed" } },
  ]),
  "wait-and-result-observe-the-same-value": scripts(ORDINARY),
  "a-notification-follows-storage": scripts(ORDINARY),
  "a-notification-retry-cannot-duplicate-or-alter-settlement":
    scripts(ORDINARY),
} satisfies Record<BackendConformanceScenario, readonly FakeRunScript[]>;

/**
 * Scripts that must not wait for Controls the one-shot capability rejects
 * before they can cross the backend seam.
 */
const ONE_SHOT_SCRIPT_OVERRIDES: Partial<
  Record<BackendConformanceScenario, readonly FakeRunScript[]>
> = {
  "capabilities-are-enforced": scripts([
    emitText("the answer"),
    { step: "complete" },
  ]),
  "steering-admission-follows-the-declared-capability": scripts([
    emitText("the answer"),
    { step: "complete" },
  ]),
};

/** Capability-shaped row replacements needed by the non-skipped one-shot cases. */
const ONE_SHOT_OVERRIDES: Partial<
  Record<BackendConformanceScenario, BackendConformanceScenarioOverride>
> = {
  "capabilities-are-enforced": {
    reason: "the one-shot fake declares no steering capability",
    replace: {
      expected: {
        runs: [{ status: "completed", steerOutcomes: ["unsupported"] }],
        controlsReceived: [],
      },
    },
  },
  "resume-or-honest-refusal": {
    reason: "the one-shot fake honestly refuses resume after its first Run",
    replace: {
      plans: [{}],
      expected: { runs: [{ status: "completed" }] },
    },
  },
  "close-releases-every-resource": {
    reason: "the one-shot fake has no resumable second Run to release",
    replace: {
      plans: [{}],
      expected: { runs: [{ status: "completed" }] },
    },
  },
  "cancel-returns-immediately-and-settlement-bounds-an-ignored-stop": {
    reason:
      "the one-shot fake cannot attempt resume after bounded cancellation",
    replace: {
      plans: [{ cancel: true, advanceClockAfterCancelMillis: 2_001 }],
    },
  },
  "an-execution-settles-when-the-provider-goes-quiet": {
    reason: "the one-shot fake proves the bound without admitting guidance",
    replace: {
      plans: [{ advanceClockMillis: QUIET_PROVIDER_WAIT_MILLIS + 1 }],
      expected: {
        runs: [{ status: "completed", diagnosticCategories: ["control"] }],
      },
    },
  },
  "steering-admission-follows-the-declared-capability": {
    reason: "the one-shot fake declares that steering is unsupported",
    replace: {
      expected: {
        runs: [
          {
            status: "completed",
            steerOutcomes: ["unsupported", "unsupported"],
          },
        ],
        controlsReceived: [],
      },
    },
  },
};

/** Structural declarations for one of the two fake conformance rigs. */
export function fakeConformanceStructure(
  kind: FakeKind,
): BackendConformanceRigStructure {
  const oneShot = kind === "one-shot";
  return conformanceRigStructure({
    name: oneShot ? "FakeOneShotBackend" : "FakeResumableBackend",
    scripts: FAKE_SCRIPTS,
    skips: oneShot ? ONE_SHOT_SKIPS : [],
    overrides: oneShot ? ONE_SHOT_OVERRIDES : {},
  });
}

export function fakeConformanceRig(kind: FakeKind): BackendConformanceRig {
  const skips = kind === "one-shot" ? ONE_SHOT_SKIPS : [];
  const name =
    kind === "resumable" ? "FakeResumableBackend" : "FakeOneShotBackend";

  return {
    name,
    build(scenario) {
      if (skips.includes(scenario)) return undefined;
      const scriptOverride =
        kind === "one-shot" ? ONE_SHOT_SCRIPT_OVERRIDES[scenario] : undefined;
      const rowOverride =
        kind === "one-shot" ? ONE_SHOT_OVERRIDES[scenario] : undefined;
      return composeConformanceFixture({
        row: BACKEND_CONFORMANCE_SCENARIO_TABLE[scenario],
        script: scriptOverride ?? FAKE_SCRIPTS[scenario],
        ...(rowOverride === undefined ? {} : { override: rowOverride }),
        build: (script, row) =>
          fixtureOf(kind, script, row, FAKE_INSTRUMENTATION[scenario]),
      });
    },
  };
}

/** The scenarios a rig for this fake is expected to skip. */
export function fakeConformanceSkips(
  kind: FakeKind,
): readonly BackendConformanceScenario[] {
  return kind === "one-shot" ? ONE_SHOT_SKIPS : [];
}
