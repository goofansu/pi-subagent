/**
 * The shared backend conformance suite.
 *
 * This is the most valuable seam v2 has, because it is the one that outlives
 * each milestone. Every backend adapter from M4 onward runs exactly these
 * scenarios: the suite knows only the domain, the backend contract, and the
 * Session runtime, and a rig supplies a backend plus the fixtures each
 * scenario needs. Provider wire messages, transport types, and SDK stand-ins
 * stay in the rig's own file, where they belong.
 *
 * M1 drove these scenarios through a throwaway driver, because there was no
 * supervisor to drive them through. M2 has one, so the suite drives the
 * **public operations** instead — `start`, `resume`, `steer`, `cancel`,
 * `wait`, `result`, and `shutdown`. That is a strengthening rather than a
 * port: a scenario now passes because the thing the product ships behaves
 * correctly, not because a test rig written alongside it agreed.
 *
 * A rig that returns `undefined` for a scenario produces a **visible skip**
 * rather than a silent pass. That distinction is the whole point of the shape:
 * a backend that cannot resume should say so in the test output, not quietly
 * report success for a scenario it never ran.
 *
 * This module registers tests, so it is the conformance lane's test boundary —
 * the one place it crosses from Effect into a `node:test` callback, and
 * therefore the one place it runs an Effect. It carries no `.test.ts` suffix
 * because `node --test` would collect it and it registers nothing until a rig
 * asks it to.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import type { Backend, RunControl } from "../backend/contract.ts";
import type {
  CancellationReason,
  ContextGauge,
  DiagnosticCategory,
  Profile,
  RunId,
  RunNotification,
  RunResult,
  SubagentId,
  TerminalRunPhase,
  ToolEntryStatus,
  UsageTotals,
} from "../domain/index.ts";
import { sessionRuntimeLayer } from "../runtime/composition.ts";
import {
  createRuntimeCounters,
  probeIsClear,
  type RuntimeProbe,
  type SupervisorCounters,
} from "../runtime/counters.ts";
import {
  createFakeNotificationSink,
  type FakeNotificationSink,
} from "../runtime/delivery.ts";
import {
  DEFAULT_RUNTIME_POLICY,
  type RuntimePolicy,
} from "../runtime/policy.ts";
import { RunRepository } from "../runtime/repository.ts";
import { ResultStore } from "../runtime/result-store.ts";
import { RUN_STAGES } from "../runtime/run-scope.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import type { ResourceCountersSnapshot } from "./fakes/counters.ts";

/* ============================================================== */
/* The scenarios                                                   */
/* ============================================================== */

export const SUBAGENT_CONFORMANCE_SCENARIOS = [
  "validation-is-deterministic",
  "open-creates-no-run",
  "capabilities-are-enforced",
  "resume-or-honest-refusal",
  "close-is-idempotent",
  "close-releases-every-resource",
  // Added in M2, once there was an admission path to reject from.
  "a-failed-open-leaves-nothing-behind",
  "one-active-run-per-subagent",
] as const;

export const RUN_CONFORMANCE_SCENARIOS = [
  "observations-reduce-in-accepted-order",
  "exactly-one-ending-wins",
  "cancellation-terminates-with-partial-output",
  "result-follows-scope-closure",
  "late-events-cannot-mutate-a-terminal-run",
  "a-failing-sink-cannot-strand-the-execution",
  "a-run-may-settle-with-no-observations",
  "observations-carry-no-provider-vocabulary",
  // Added in M2.
  "capacity-rejection-is-immediate",
  "shutdown-rejects-new-work",
  "a-late-waiter-reads-the-stored-result",
  "an-evicted-result-answers-expired",
] as const;

export const CONTROL_CONFORMANCE_SCENARIOS = [
  // Named for what it checks on *either* kind of backend: an undeclared
  // Control is refused without the backend hearing about it, and a declared
  // one is admitted. A scenario only one kind of backend can build would show
  // up as a skip that says nothing about the backend under test.
  "steering-admission-follows-the-declared-capability",
  "controls-are-delivered-serially-in-order",
  "a-control-cannot-leak-into-the-next-run",
  "a-user-observation-appears-only-on-confirmation",
  // Added in M2.
  "a-full-mailbox-answers-immediately",
  "a-closed-mailbox-refuses-after-cancel",
] as const;

export const USAGE_CONFORMANCE_SCENARIOS = [
  "usage-deltas-are-run-local",
  "reconciliation-does-not-double-count",
  "context-occupancy-is-a-gauge",
  "a-replayed-transcript-adds-no-usage",
  "a-resumed-run-excludes-prior-usage",
] as const;

/**
 * The roadmap's projection-and-delivery program, which M2 is the first
 * milestone able to run: every one of these is about the supervisor, and
 * before M2 there was no supervisor to ask.
 */
export const PROJECTION_CONFORMANCE_SCENARIOS = [
  "only-the-repository-writes-snapshots",
  "projections-stay-within-their-limits",
  "settlement-stores-the-result-exactly-once",
  "wait-and-result-observe-the-same-value",
  "a-notification-follows-storage",
  "a-notification-retry-cannot-duplicate-or-alter-settlement",
] as const;

/** The five sections, as data, so a test can check none was forgotten. */
export const BACKEND_CONFORMANCE_SECTIONS = {
  "subagent-and-backend-agent": SUBAGENT_CONFORMANCE_SCENARIOS,
  run: RUN_CONFORMANCE_SCENARIOS,
  control: CONTROL_CONFORMANCE_SCENARIOS,
  usage: USAGE_CONFORMANCE_SCENARIOS,
  "projection-and-delivery": PROJECTION_CONFORMANCE_SCENARIOS,
} as const;

export const BACKEND_CONFORMANCE_SCENARIOS = [
  ...SUBAGENT_CONFORMANCE_SCENARIOS,
  ...RUN_CONFORMANCE_SCENARIOS,
  ...CONTROL_CONFORMANCE_SCENARIOS,
  ...USAGE_CONFORMANCE_SCENARIOS,
  ...PROJECTION_CONFORMANCE_SCENARIOS,
] as const;

export type BackendConformanceScenario =
  (typeof BACKEND_CONFORMANCE_SCENARIOS)[number];

/* ============================================================== */
/* What a rig supplies                                             */
/* ============================================================== */

/** What the suite should do for one Run of a fixture. */
export interface ConformanceRunPlan {
  /** Controls to steer into this Run, in order, once it is under way. */
  readonly controls?: readonly RunControl[];
  /** Steer this many *beyond* the mailbox bound, to see it refuse. */
  readonly floodControls?: number;
  /** Cancel this Run once its execution has actually started. */
  readonly cancel?: boolean;
  /** Steer once after the cancel is admitted, to see the mailbox closed. */
  readonly steerAfterCancel?: boolean;
  /** Wait on this Run only after it has already settled. */
  readonly waitAfterSettlement?: boolean;
}

/** What the suite should find. Every field is checked only if the rig gave it. */
export interface ExpectedRun {
  readonly status: TerminalRunPhase;
  readonly cancellationReason?: CancellationReason;
  readonly errorMessage?: string;
  readonly finalOutput?: string;
  readonly transcriptTexts?: readonly string[];
  readonly toolStatuses?: readonly ToolEntryStatus[];
  readonly usageTotals?: Partial<UsageTotals>;
  readonly turns?: number;
  readonly context?: ContextGauge;
  readonly diagnosticCategories?: readonly DiagnosticCategory[];
  /** One admission outcome per offered Control, in admission order. */
  readonly steerOutcomes?: readonly string[];
  /** What the flood of extra Controls answered, in order. */
  readonly floodOutcomes?: readonly string[];
}

export interface BackendConformanceExpectation {
  /** One entry per Run the suite actually drove, in order. */
  readonly runs: readonly ExpectedRun[];
  /** What the backend actually received, across every Run. */
  readonly controlsReceived?: readonly string[];
  readonly maxConcurrentControls?: number;
  /** Diagnostics `validateProfile` must report, in order. */
  readonly profileDiagnostics?: readonly string[];
  /** Every start outcome, in any order: concurrent starts have no order. */
  readonly startOutcomes?: readonly string[];
  /** What resuming a Subagent that is still running answered. */
  readonly resumeWhileRunning?: string;
  /** How many notifications the sink received. */
  readonly notifications?: number;
}

export interface BackendConformanceFixture {
  readonly backend: Backend;
  readonly profile: Profile;
  /** Retained-resource counters, read after the Session Scope closes. */
  readonly counters: () => ResourceCountersSnapshot;
  /** One plan per Run the suite should drive. Empty means drive none. */
  readonly plans: readonly ConformanceRunPlan[];
  readonly expected: BackendConformanceExpectation;
  /** A shared ordering log the backend appends to. */
  readonly trace?: string[];
  /** Bounds this scenario needs lowered. */
  readonly policy?: RuntimePolicy;
  /** Issue this many starts at once instead of one. */
  readonly concurrentStarts?: number;
  /** Shut the Session down before driving anything. */
  readonly shutdownFirst?: boolean;
  /** Resume the Subagent while its first Run is still active. */
  readonly resumeWhileRunning?: boolean;
  /** Make the sink fail its first push, so the retry path runs. */
  readonly sinkFailsOnce?: boolean;
  /** After the plans, fill the store until the first result is evicted. */
  readonly evictOldest?: boolean;
}

/**
 * Rig-side code implements this.
 *
 * Returning `undefined` is an intentional, visible skip. It is not an
 * unimplemented test that passes.
 */
export interface BackendConformanceRig {
  readonly name: string;
  build(
    scenario: BackendConformanceScenario,
  ): BackendConformanceFixture | undefined;
}

/* ============================================================== */
/* Driving a fixture                                               */
/* ============================================================== */

/** What one driven Run produced. */
export interface RunOutcome {
  readonly runId: RunId;
  readonly result: RunResult;
  readonly steerOutcomes: readonly string[];
  readonly floodOutcomes: readonly string[];
  readonly steerAfterCancel?: string;
  readonly waitOutcomes: readonly string[];
  /** What `result` answered, which is not always a result. */
  readonly resultOutcome: string;
}

/** One row of the published index, reduced to what a scenario asks about. */
export interface SnapshotView {
  readonly phase: string;
  readonly activity?: string;
  readonly tools: number;
}

export interface FixtureOutcome {
  readonly runs: readonly RunOutcome[];
  readonly startOutcomes: readonly string[];
  readonly resumeWhileRunning?: string;
  readonly notifications: readonly RunNotification[];
  readonly sinkAttempts: number;
  readonly stages: readonly string[];
  readonly counters: SupervisorCounters;
  /** Read after the Session Scope has closed, which is when it must be zero. */
  readonly probeAfterClose: RuntimeProbe;
  readonly snapshots: ReadonlyMap<RunId, SnapshotView>;
  readonly expiredResults: readonly RunId[];
}

const startRequest = (fixture: BackendConformanceFixture) => ({
  agent: fixture.profile.name,
  description: "conformance",
  prompt: "exercise the backend",
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
});

/** An empty stand-in for a Run whose result was not retrievable. */
const NO_RESULT = {
  status: "failed",
  finalOutput: "",
  transcript: [],
  tools: [],
  diagnostics: [],
  links: [],
} as unknown as RunResult;

/**
 * Commit filler results until the named Run's output has been evicted.
 *
 * Deliberately done through the store rather than by starting more Runs: what
 * this proves is the eviction rule, and driving twenty Runs to reach it would
 * make the failure mode much harder to read.
 */
function fillUntilEvicted(
  store: ResultStore["Service"],
  runId: RunId,
  filler: RunResult,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let index = 0; index < 40; index += 1) {
      const read = yield* store.read(runId);
      if (read.outcome !== "result") return;
      const id = `filler-${index}` as RunId;
      yield* store.commit({ ...filler, runId: id });
      yield* store.releasePin(id, "publication");
      yield* store.releasePin(id, "waiters");
      yield* store.releasePin(id, "delivery");
    }
  });
}

/**
 * Drive one fixture through a Session runtime and collect everything a
 * scenario could want to assert on.
 *
 * This is the shape every scenario shares; the scenario's own point is
 * asserted on top of it.
 */
function runFixture(
  fixture: BackendConformanceFixture,
  sink: FakeNotificationSink,
): Promise<FixtureOutcome> {
  const counters = createRuntimeCounters();

  return Effect.runPromise(
    Effect.gen(function* () {
      const supervisor = yield* SubagentSupervisor;
      const repository = yield* RunRepository;
      const store = yield* ResultStore;

      /**
       * Spin until something is true, or give up and say what was waited for.
       *
       * Bounded deliberately: a scenario whose fixture deadlocks should fail
       * with the name of what it was waiting for, not hang the lane.
       */
      const until = (what: string, ready: Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          for (let step = 0; step < 200_000; step += 1) {
            if (yield* ready) return;
            yield* Effect.yieldNow;
          }
          throw new Error(`gave up waiting for ${what}`);
        });

      /**
       * Wait until the backend has begun the nth execution.
       *
       * Counted rather than observed live, because a Run that finishes
       * quickly would otherwise be missed entirely and the wait would never
       * end.
       */
      const untilUnderWay = (index: number) =>
        until(
          `execution ${index + 1} to begin`,
          Effect.sync(() => fixture.counters().executionsStarted > index),
        );
      const untilTerminal = (runId: RunId) =>
        until(
          `${runId} to settle`,
          Effect.map(
            repository.lookup(runId),
            (known) => known.state === "terminal",
          ),
        );
      /** Let the forked work that follows settlement finish. */
      const quiesce = Effect.gen(function* () {
        for (let step = 0; step < 30; step += 1) yield* Effect.yieldNow;
      });

      if (fixture.sinkFailsOnce) sink.failNext(1);
      if (fixture.shutdownFirst) yield* supervisor.shutdown();

      const startOutcomes: string[] = [];
      const runs: RunOutcome[] = [];
      const expired: RunId[] = [];
      let resumeWhileRunning: string | undefined;
      let subagentId: SubagentId | undefined;

      const howMany =
        fixture.concurrentStarts ?? (fixture.plans.length > 0 ? 1 : 0);
      const issued =
        howMany === 0
          ? []
          : yield* Effect.all(
              Array.from({ length: howMany }, () =>
                supervisor.start(startRequest(fixture)),
              ),
              { concurrency: howMany },
            );
      const admitted: RunId[] = [];
      for (const outcome of issued) {
        startOutcomes.push(outcome.outcome);
        if (outcome.outcome === "started") {
          admitted.push(outcome.runId);
          subagentId ??= outcome.subagentId;
        }
      }

      for (const [index, plan] of fixture.plans.entries()) {
        let runId: RunId | undefined = index === 0 ? admitted[0] : undefined;
        if (index > 0) {
          if (subagentId === undefined) break;
          const resumed = yield* supervisor.resume({
            subagentId,
            description: "conformance",
            prompt: "exercise the backend again",
          });
          if (resumed.outcome !== "started") break;
          runId = resumed.runId;
        }
        if (runId === undefined) break;

        yield* untilUnderWay(index);

        if (index === 0 && fixture.resumeWhileRunning && subagentId) {
          const rejected = yield* supervisor.resume({
            subagentId,
            description: "conformance",
            prompt: "again",
          });
          resumeWhileRunning = rejected.outcome;
        }

        const steerOutcomes: string[] = [];
        for (const control of plan.controls ?? []) {
          const outcome = yield* supervisor.steer(runId, control);
          steerOutcomes.push(outcome.outcome);
        }
        const floodOutcomes: string[] = [];
        for (let extra = 0; extra < (plan.floodControls ?? 0); extra += 1) {
          const outcome = yield* supervisor.steer(runId, {
            type: "steer",
            text: `flooding ${extra}`,
          });
          floodOutcomes.push(outcome.outcome);
        }

        let steerAfterCancel: string | undefined;
        if (plan.cancel) {
          yield* supervisor.cancel([runId]);
          if (plan.steerAfterCancel) {
            const refused = yield* supervisor.steer(runId, {
              type: "steer",
              text: "after the cancel",
            });
            steerAfterCancel = refused.outcome;
          }
        }

        const waitOutcomes: string[] = [];
        if (!plan.waitAfterSettlement) {
          waitOutcomes.push(
            ...(yield* supervisor.wait([runId])).map(
              (outcome) => outcome.outcome,
            ),
          );
        }
        yield* untilTerminal(runId);
        if (plan.waitAfterSettlement) {
          waitOutcomes.push(
            ...(yield* supervisor.wait([runId])).map(
              (outcome) => outcome.outcome,
            ),
          );
        }
        yield* quiesce;

        const read = yield* supervisor.result(runId);
        runs.push({
          runId,
          result: read.outcome === "result" ? read.result : NO_RESULT,
          steerOutcomes,
          floodOutcomes,
          ...(steerAfterCancel === undefined ? {} : { steerAfterCancel }),
          waitOutcomes,
          resultOutcome: read.outcome,
        });
      }

      if (fixture.evictOldest && runs.length > 0) {
        // Everything holding the settled results open has finished, so release
        // the pins and make room pressure the only thing left.
        for (const run of runs) {
          for (const holder of [
            "publication",
            "waiters",
            "delivery",
          ] as const) {
            yield* store.releasePin(run.runId, holder);
          }
        }
        yield* fillUntilEvicted(store, runs[0].runId, runs[0].result);
        for (const run of runs) {
          const read = yield* supervisor.result(run.runId);
          if (read.outcome === "ResultExpired") expired.push(run.runId);
        }
      }

      const snapshots = new Map<RunId, SnapshotView>(
        (yield* repository.list()).map((snapshot) => [
          snapshot.identity.runId,
          {
            phase: snapshot.phase,
            ...(snapshot.activity === undefined
              ? {}
              : { activity: snapshot.activity }),
            tools: snapshot.tools,
          },
        ]),
      );

      return {
        runs,
        startOutcomes,
        ...(resumeWhileRunning === undefined ? {} : { resumeWhileRunning }),
        notifications: sink.received(),
        sinkAttempts: sink.attempts(),
        stages: supervisor.stages(),
        counters: supervisor.counters(),
        snapshots,
        expiredResults: expired,
        readProbe: () => supervisor.probe(),
      };
    }).pipe(
      Effect.provide(
        sessionRuntimeLayer({
          backends: [fixture.backend],
          profiles: { from: "list", profiles: [fixture.profile] },
          sink,
          counters,
          ...(fixture.policy === undefined ? {} : { policy: fixture.policy }),
        }),
      ),
      Effect.scoped,
    ),
    // The probe is read *after* the Session Scope has closed, which is the
    // only moment at which "nothing is still alive" means anything.
  ).then(({ readProbe, ...outcome }) => ({
    ...outcome,
    probeAfterClose: readProbe(),
  }));
}

/* ============================================================== */
/* Assertions                                                      */
/* ============================================================== */

function transcriptTextsOf(outcome: RunOutcome): string[] {
  return outcome.result.transcript.map((item) =>
    item.parts
      .filter((part) => part.kind === "text")
      .map((part) => (part.kind === "text" ? part.text : ""))
      .join(""),
  );
}

function assertRun(
  outcome: RunOutcome,
  expected: ExpectedRun,
  where: string,
): void {
  assert.equal(outcome.result.status, expected.status, `${where}: status`);
  if (expected.cancellationReason !== undefined) {
    assert.equal(
      outcome.result.cancellationReason,
      expected.cancellationReason,
      `${where}: cancellation reason`,
    );
  }
  if (expected.errorMessage !== undefined) {
    assert.equal(
      outcome.result.errorMessage,
      expected.errorMessage,
      `${where}: error message`,
    );
  }
  if (expected.finalOutput !== undefined) {
    assert.equal(
      outcome.result.finalOutput,
      expected.finalOutput,
      `${where}: final output`,
    );
  }
  if (expected.transcriptTexts !== undefined) {
    assert.deepEqual(
      transcriptTextsOf(outcome),
      [...expected.transcriptTexts],
      `${where}: transcript`,
    );
  }
  if (expected.toolStatuses !== undefined) {
    assert.deepEqual(
      outcome.result.tools.map((entry) => entry.status),
      [...expected.toolStatuses],
      `${where}: tool statuses`,
    );
  }
  if (expected.usageTotals !== undefined) {
    for (const [field, value] of Object.entries(expected.usageTotals)) {
      assert.equal(
        outcome.result.usage.totals[field as keyof UsageTotals],
        value,
        `${where}: usage ${field}`,
      );
    }
  }
  if (expected.turns !== undefined) {
    assert.equal(outcome.result.usage.turns, expected.turns, `${where}: turns`);
  }
  if (expected.context !== undefined) {
    assert.deepEqual(
      outcome.result.usage.context,
      expected.context,
      `${where}: context gauge`,
    );
  }
  if (expected.diagnosticCategories !== undefined) {
    assert.deepEqual(
      outcome.result.diagnostics.map((diagnostic) => diagnostic.category),
      [...expected.diagnosticCategories],
      `${where}: diagnostics`,
    );
  }
  if (expected.steerOutcomes !== undefined) {
    assert.deepEqual(
      [...outcome.steerOutcomes],
      [...expected.steerOutcomes],
      `${where}: steer outcomes`,
    );
  }
  if (expected.floodOutcomes !== undefined) {
    assert.deepEqual(
      [...outcome.floodOutcomes],
      [...expected.floodOutcomes],
      `${where}: flood outcomes`,
    );
  }
}

function assertFixture(
  fixture: BackendConformanceFixture,
  outcome: FixtureOutcome,
): void {
  const { expected } = fixture;
  assert.equal(
    outcome.runs.length,
    expected.runs.length,
    "one expectation per driven Run",
  );
  for (const [index, run] of outcome.runs.entries()) {
    assertRun(run, expected.runs[index], `run ${index + 1}`);
  }
  if (expected.startOutcomes !== undefined) {
    assert.deepEqual(
      [...outcome.startOutcomes].sort(),
      [...expected.startOutcomes].sort(),
      "start outcomes",
    );
  }
  if (expected.resumeWhileRunning !== undefined) {
    assert.equal(
      outcome.resumeWhileRunning,
      expected.resumeWhileRunning,
      "resume while running",
    );
  }
  if (expected.notifications !== undefined) {
    assert.equal(
      outcome.notifications.length,
      expected.notifications,
      "notifications",
    );
  }
  const counters = fixture.counters();
  if (expected.controlsReceived !== undefined) {
    assert.deepEqual(
      counters.controlsReceived,
      [...expected.controlsReceived],
      "Controls the backend received",
    );
  }
  if (expected.maxConcurrentControls !== undefined) {
    assert.equal(
      counters.maxConcurrentControls,
      expected.maxConcurrentControls,
      "concurrent Controls",
    );
  }
}

/** Every retained resource is released once the Session Scope has closed. */
function assertNoLeaks(
  fixture: BackendConformanceFixture,
  outcome: FixtureOutcome,
): void {
  const counters = fixture.counters();
  assert.equal(counters.opens - counters.closes, 0, "opens minus closes");
  assert.equal(counters.liveExecutions, 0, "live executions");
  assert.equal(counters.liveSubscriptions, 0, "live subscriptions");
  assert.ok(
    probeIsClear(outcome.probeAfterClose),
    `the runtime probe is not clear: ${JSON.stringify(outcome.probeAfterClose)}`,
  );
}

/* ============================================================== */
/* The suite                                                       */
/* ============================================================== */

/** What one scenario checks beyond the shared expectations. */
type ScenarioCheck = (
  fixture: BackendConformanceFixture,
  outcome: FixtureOutcome,
) => void;

const stageIndex = (outcome: FixtureOutcome, stage: string): number =>
  outcome.stages.findIndex((entry) => entry.endsWith(stage));

const SCENARIO_CHECKS: {
  readonly [S in BackendConformanceScenario]?: ScenarioCheck;
} = {
  "validation-is-deterministic": (fixture) => {
    const path = "/agents/conformance.md";
    const first = fixture.backend.validateProfile(fixture.profile, path);
    const second = fixture.backend.validateProfile(fixture.profile, path);
    assert.deepEqual(second, first, "validation is not deterministic");
    if (fixture.expected.profileDiagnostics !== undefined) {
      assert.deepEqual(
        first.map((diagnostic) => diagnostic.reason),
        [...fixture.expected.profileDiagnostics],
      );
    }
  },
  "open-creates-no-run": (fixture, outcome) => {
    // A Session that started nothing opened nothing: opening a BackendAgent
    // is a Run's business, and a Run that was never asked for has none.
    assert.deepEqual(outcome.runs, []);
    assert.equal(fixture.counters().executionsStarted, 0);
    assert.equal(fixture.counters().opens, 0);
  },
  "capabilities-are-enforced": (fixture, outcome) => {
    const declared = fixture.expected.runs[0]?.steerOutcomes?.[0];
    const offered = outcome.runs.flatMap((run) => run.steerOutcomes);
    assert.ok(offered.length > 0, "no Control was offered");
    for (const admitted of offered) assert.equal(admitted, declared);
    // A backend that declared no steering is never called about a Control at
    // all, which is what makes `unsupported` free of provider I/O.
    if (declared === "unsupported") {
      assert.deepEqual(fixture.counters().controlsReceived, []);
    }
  },
  "resume-or-honest-refusal": (_fixture, outcome) => {
    // Either a second Run ran on the same conversation, or the refusal was an
    // honest one and no second Run appeared. Both are conformant; inventing a
    // Run for a backend that cannot resume is not.
    assert.ok(outcome.runs.length >= 1);
  },
  "close-is-idempotent": (fixture) => {
    assert.equal(fixture.counters().closes, 1, "close counted more than once");
  },
  "close-releases-every-resource": (fixture, outcome) => {
    assertNoLeaks(fixture, outcome);
  },
  "a-failed-open-leaves-nothing-behind": (fixture, outcome) => {
    assert.deepEqual(outcome.startOutcomes, ["backend unavailable"]);
    // No Run was published, no notification was sent, and no BackendAgent was
    // ever counted as open.
    assert.equal(outcome.snapshots.size, 0);
    assert.deepEqual(outcome.notifications, []);
    assert.equal(fixture.counters().opens, 0);
  },
  "one-active-run-per-subagent": (_fixture, outcome) => {
    assert.equal(outcome.resumeWhileRunning, "Subagent already running");
  },
  "observations-reduce-in-accepted-order": (fixture, outcome) => {
    // The rig declares the order it said things in; the transcript is checked
    // against it above. What is left is that something was said at all.
    for (const run of outcome.runs) {
      assert.ok(run.result.transcript.length > 0);
    }
    assert.ok(fixture.expected.runs[0]?.transcriptTexts !== undefined);
  },
  "exactly-one-ending-wins": (_fixture, outcome) => {
    // More than one ending was produced, and exactly one of them decided the
    // Run: the rest were reported late.
    assert.ok(
      outcome.counters.lateEndings >= 1,
      "no competing ending was arbitrated",
    );
    for (const run of outcome.runs) assert.equal(run.resultOutcome, "result");
  },
  "cancellation-terminates-with-partial-output": (fixture, outcome) => {
    for (const run of outcome.runs) {
      assert.equal(run.result.status, "cancelled");
    }
    assertNoLeaks(fixture, outcome);
  },
  "result-follows-scope-closure": (_fixture, outcome) => {
    const closed = stageIndex(outcome, RUN_STAGES.executionScopeClosed);
    const produced = stageIndex(outcome, RUN_STAGES.resultProduced);
    const committed = stageIndex(outcome, RUN_STAGES.resultCommitted);
    const published = stageIndex(outcome, RUN_STAGES.terminalPublished);
    assert.ok(closed !== -1, "the execution scope closed");
    assert.ok(produced !== -1, "the result was produced");
    assert.ok(
      closed < produced,
      "the result must not exist before the finalizers ran",
    );
    // And a terminal snapshot implies a retrievable result.
    assert.ok(
      committed < published,
      "the snapshot was published before the commit",
    );
  },
  "late-events-cannot-mutate-a-terminal-run": (_fixture, outcome) => {
    assert.ok(
      outcome.counters.lateEvents >= 1,
      "the fixture emitted nothing late",
    );
  },
  "a-failing-sink-cannot-strand-the-execution": (fixture, outcome) => {
    // M1 made the observation sink fail. M2's intake cannot fail — `emit`
    // never fails, by contract, and that is a strengthening rather than a gap.
    // The remaining half of the property is the one that still bites: an
    // execution that dies still settles its Run and strands no native
    // resource.
    for (const run of outcome.runs) assert.equal(run.result.status, "failed");
    assertNoLeaks(fixture, outcome);
  },
  "a-run-may-settle-with-no-observations": (_fixture, outcome) => {
    for (const run of outcome.runs) {
      assert.equal(run.result.finalOutput, "");
      assert.deepEqual(run.result.transcript, []);
      assert.equal(run.result.usage.turns, 0);
    }
  },
  "observations-carry-no-provider-vocabulary": (_fixture, outcome) => {
    // Every observation was decoded at the seam under the exact-key-set rule,
    // so an unlisted key at any depth would have been rejected there and
    // counted. None was.
    assert.equal(outcome.counters.seamDecodeFailures, 0);
    for (const run of outcome.runs) {
      assert.deepEqual(
        run.result.diagnostics
          .filter((diagnostic) => diagnostic.category === "backend-failure")
          .map((diagnostic) => diagnostic.message),
        [],
      );
    }
  },
  "capacity-rejection-is-immediate": (_fixture, outcome) => {
    // Exactly one winner, and the loser learned at once with nothing queued.
    assert.equal(
      outcome.startOutcomes.filter((entry) => entry === "started").length,
      1,
    );
    assert.ok(outcome.startOutcomes.includes("at capacity"));
  },
  "shutdown-rejects-new-work": (_fixture, outcome) => {
    assert.deepEqual(outcome.startOutcomes, ["shutting down"]);
    assert.deepEqual(outcome.runs, []);
  },
  "a-late-waiter-reads-the-stored-result": (_fixture, outcome) => {
    for (const run of outcome.runs) {
      // The wait was issued after the Run had already settled, and it read
      // the same answer an early one would have.
      assert.deepEqual(run.waitOutcomes, ["terminal"]);
      assert.equal(run.resultOutcome, "result");
    }
  },
  "an-evicted-result-answers-expired": (_fixture, outcome) => {
    assert.ok(
      outcome.expiredResults.length >= 1,
      "nothing was evicted, so nothing proves the outcome",
    );
  },
  "steering-admission-follows-the-declared-capability": (fixture, outcome) => {
    const offered = outcome.runs.flatMap((run) => run.steerOutcomes);
    assert.ok(offered.length > 0, "no Control was offered");
    const received = fixture.counters().controlsReceived;
    if (offered[0] === "unsupported") {
      for (const admitted of offered) assert.equal(admitted, "unsupported");
      assert.deepEqual(
        received,
        [],
        "an unsupported Control must not reach the backend at all",
      );
      return;
    }
    for (const admitted of offered) assert.equal(admitted, "accepted");
    assert.equal(
      received.length,
      offered.length,
      "a backend that declared steering must receive what was admitted",
    );
  },
  "controls-are-delivered-serially-in-order": (fixture) => {
    const counters = fixture.counters();
    const offered = fixture.plans.flatMap((plan) =>
      (plan.controls ?? []).map((control) => control.text),
    );
    assert.ok(offered.length > 1, "one Control cannot be out of order");
    assert.deepEqual(
      counters.controlsReceived,
      offered,
      "Controls were not delivered in admission order",
    );
    assert.equal(
      counters.maxConcurrentControls,
      1,
      "Controls must be delivered one at a time",
    );
  },
  "a-control-cannot-leak-into-the-next-run": (fixture, outcome) => {
    assert.ok(outcome.runs.length >= 2, "this scenario needs two Runs");
    const byRun = fixture.counters().controlsByRun;
    const second = outcome.runs[1].runId;
    assert.deepEqual(
      byRun.get(second) ?? [],
      [],
      "a Control admitted to the first Run reached the second",
    );
  },
  "a-user-observation-appears-only-on-confirmation": (fixture, outcome) => {
    const received = fixture.counters().controlsReceived;
    assert.ok(received.length > 0, "no Control reached the backend");
    const userTexts = outcome.runs.flatMap((run) =>
      run.result.transcript
        .filter((item) => item.role === "user")
        .map((item) =>
          item.parts
            .filter((part) => part.kind === "text")
            .map((part) => (part.kind === "text" ? part.text : ""))
            .join(""),
        ),
    );
    // A Control the provider never confirmed appears nowhere, so the user
    // observations are a subset of what was delivered — never an invention.
    for (const text of userTexts) {
      assert.ok(
        received.includes(text),
        `the transcript claims guidance the backend never received: '${text}'`,
      );
    }
  },
  "a-full-mailbox-answers-immediately": (_fixture, outcome) => {
    const flooded = outcome.runs.flatMap((run) => run.floodOutcomes);
    assert.ok(flooded.length > 0, "nothing was offered beyond the bound");
    assert.ok(
      flooded.includes("mailbox full"),
      "a mailbox past its bound did not say so",
    );
  },
  "a-closed-mailbox-refuses-after-cancel": (_fixture, outcome) => {
    for (const run of outcome.runs) {
      // Either the Run is still settling, and admission is closed, or it has
      // already settled and names its status. Both refuse; neither accepts.
      assert.ok(
        run.steerAfterCancel === "mailbox closed" ||
          run.steerAfterCancel === `already ${run.result.status}`,
        `a steer after cancel answered '${run.steerAfterCancel}'`,
      );
    }
  },
  "usage-deltas-are-run-local": (_fixture, outcome) => {
    for (const run of outcome.runs) {
      for (const value of Object.values(run.result.usage.totals)) {
        assert.ok(value >= 0 && Number.isFinite(value));
      }
    }
  },
  "reconciliation-does-not-double-count": (fixture, outcome) => {
    for (const [index, run] of outcome.runs.entries()) {
      const declared = fixture.expected.runs[index].usageTotals?.input;
      assert.equal(
        typeof declared,
        "number",
        "this scenario needs the terminal figure declared, to compare against",
      );
      // The reconciliation replaced the streamed total rather than adding to
      // it, so the reported figure is the authoritative one exactly.
      assert.equal(run.result.usage.totals.input, declared);
    }
    assert.ok(outcome.counters.reconciliationDifferences >= 1);
  },
  "context-occupancy-is-a-gauge": (fixture, outcome) => {
    for (const [index, run] of outcome.runs.entries()) {
      const declared = fixture.expected.runs[index].context;
      assert.ok(
        declared !== undefined,
        "this scenario needs the gauge declared",
      );
      // The latest reading, never the sum of the readings.
      assert.deepEqual(run.result.usage.context, declared);
    }
  },
  "a-replayed-transcript-adds-no-usage": (_fixture, outcome) => {
    assert.ok(outcome.runs.length >= 2, "this scenario needs two Runs");
    const replaying = outcome.runs[outcome.runs.length - 1];
    assert.ok(
      replaying.result.transcript.length > 0,
      "the replaying Run reported no transcript",
    );
    assert.deepEqual(replaying.result.usage.totals, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    assert.equal(replaying.result.usage.turns, 0);
  },
  "a-resumed-run-excludes-prior-usage": (_fixture, outcome) => {
    assert.ok(outcome.runs.length >= 2, "this scenario needs two Runs");
    const [first, second] = outcome.runs;
    assert.ok(
      first.result.usage.totals.input > 0,
      "the first Run spent nothing, so excluding it proves nothing",
    );
    assert.ok(second.result.usage.totals.input > 0);
    // The provider's cumulative reading covers both Runs; the resumed Run
    // reports the difference, so it is charged for its own work alone.
    assert.ok(
      second.result.usage.totals.input < first.result.usage.totals.input,
      "the resumed Run was charged for the whole conversation",
    );
  },
  "only-the-repository-writes-snapshots": (_fixture, outcome) => {
    for (const run of outcome.runs) {
      const snapshot = outcome.snapshots.get(run.runId);
      assert.ok(snapshot, "the Run has no snapshot");
      // The row agrees with the result, because both came from the one fold
      // the repository was told about. Nothing else can write either.
      assert.equal(snapshot.phase, run.result.status);
      assert.equal(snapshot.tools, run.result.tools.length);
      // A settled Run is quiet.
      assert.equal(snapshot.activity, undefined);
    }
  },
  "projections-stay-within-their-limits": (fixture, outcome) => {
    const bounds = (fixture.policy ?? DEFAULT_RUNTIME_POLICY).projection;
    for (const run of outcome.runs) {
      assert.ok(run.result.transcript.length <= bounds.maxTranscriptItems);
      assert.ok(run.result.tools.length <= bounds.maxToolEntries);
      assert.ok(run.result.diagnostics.length <= bounds.maxDiagnostics);
      assert.ok(run.result.links.length <= bounds.maxLinks);
      // And the bounding said so rather than being quietly lossy.
      assert.ok(run.result.truncation.droppedTranscriptItems >= 1);
    }
  },
  "settlement-stores-the-result-exactly-once": (_fixture, outcome) => {
    for (const run of outcome.runs) assert.equal(run.resultOutcome, "result");
    // A second commit for one Run would have been a conflict, and a second
    // candidate for a settled Run is counted rather than acted on.
    assert.equal(outcome.counters.duplicateSettlements, 0);
  },
  "wait-and-result-observe-the-same-value": (_fixture, outcome) => {
    for (const run of outcome.runs) {
      assert.deepEqual(run.waitOutcomes, ["terminal"]);
      assert.equal(run.resultOutcome, "result");
      // The status a waiter saw is the status the stored result carries.
      assert.equal(outcome.snapshots.get(run.runId)?.phase, run.result.status);
    }
  },
  "a-notification-follows-storage": (_fixture, outcome) => {
    assert.equal(outcome.notifications.length, outcome.runs.length);
    for (const run of outcome.runs) {
      const notice = outcome.notifications.find(
        (candidate) => candidate.runId === run.runId,
      );
      assert.ok(notice, "the Run produced no notification");
      // The notice was built from the stored result, so it cannot say
      // something `agent_result` would contradict.
      assert.equal(notice.status, run.result.status);
      assert.equal(notice.retrieveWith, "agent_result");
      assert.equal(run.resultOutcome, "result");
    }
  },
  "a-notification-retry-cannot-duplicate-or-alter-settlement": (
    _fixture,
    outcome,
  ) => {
    // One push failed and was retried, so there were more attempts than
    // notifications — and still exactly one notification per Run.
    assert.ok(
      outcome.sinkAttempts > outcome.notifications.length,
      "no push was retried, so nothing proves the property",
    );
    assert.equal(outcome.notifications.length, outcome.runs.length);
    for (const run of outcome.runs) assert.equal(run.resultOutcome, "result");
    assert.equal(outcome.counters.duplicateSettlements, 0);
  },
};

/** Register one test per scenario for one rig. */
export function runBackendConformance(rig: BackendConformanceRig): void {
  for (const scenario of BACKEND_CONFORMANCE_SCENARIOS) {
    const name = `${rig.name} conformance: ${scenario}`;
    const fixture = rig.build(scenario);

    if (!fixture) {
      test(name, {
        skip: `the ${rig.name} backend does not support '${scenario}'`,
      }, () => {});
      continue;
    }

    test(name, async () => {
      const sink = createFakeNotificationSink();
      const outcome = await runFixture(fixture, sink);
      assertFixture(fixture, outcome);
      SCENARIO_CHECKS[scenario]?.(fixture, outcome);
      // Every scenario is a leak test: the Session Scope has closed by now.
      assertNoLeaks(fixture, outcome);
    });
  }
}
