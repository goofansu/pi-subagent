/**
 * The shared backend conformance suite.
 *
 * This is the most valuable seam in M1, because it is the one that outlives
 * M1. Every backend adapter from M4 onward runs exactly these scenarios: the
 * suite knows only the domain and the backend contract, and a rig supplies a
 * backend plus the fixtures each scenario needs. Provider wire messages,
 * transport types, and SDK stand-ins stay in the rig's own file, where they
 * belong.
 *
 * A rig that returns `undefined` for a scenario produces a **visible skip**
 * rather than a silent pass. That distinction is the whole point of the shape:
 * a backend that cannot resume should say so in the test output, not quietly
 * report success for a scenario it never ran.
 *
 * The scenarios are the four sections of the roadmap's conformance program
 * that are meaningful before a supervisor exists. The rest — result-store
 * exactly-once, notification landing, projection publication — arrive with M2,
 * and this list grows rather than restarting.
 *
 * Its ancestor is v1's thirteen-scenario capability-aware battery. Several of
 * those map onto scenarios here one to one: backend crash, abort mid-run,
 * terminal answer then abort, usage totals, no terminal answer, transcript
 * healing, and the four steering scenarios.
 *
 * This module registers tests, so it is the conformance lane's test boundary —
 * the one place it crosses from Effect into a `node:test` callback, and
 * therefore the one place it runs an Effect. It carries no `.test.ts` suffix
 * because `node --test` would collect it and it registers nothing until a rig
 * asks it to.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import type {
  Backend,
  BackendCapabilities,
  ResumeAdmission,
  RunControl,
} from "../backend/contract.ts";
import type {
  CancellationReason,
  ContextGauge,
  DiagnosticCategory,
  Profile,
  RunObservationKind,
  SubagentContext,
  TerminalRunPhase,
  ToolEntryStatus,
  UsageTotals,
} from "../domain/index.ts";
import { runId } from "../domain/index.ts";
import {
  DRIVER_STAGES,
  type DriveOutcome,
  type DriverIdentity,
  driveRun,
} from "./driver.ts";
import type { ResourceCountersSnapshot } from "./fakes/counters.ts";
import {
  findForbiddenKeys,
  OBSERVATION_KEYS,
} from "./observation-vocabulary.ts";

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
] as const;

export const USAGE_CONFORMANCE_SCENARIOS = [
  "usage-deltas-are-run-local",
  "reconciliation-does-not-double-count",
  "context-occupancy-is-a-gauge",
  "a-replayed-transcript-adds-no-usage",
  "a-resumed-run-excludes-prior-usage",
] as const;

/** The four sections, as data, so a test can check none was forgotten. */
export const BACKEND_CONFORMANCE_SECTIONS = {
  "subagent-and-backend-agent": SUBAGENT_CONFORMANCE_SCENARIOS,
  run: RUN_CONFORMANCE_SCENARIOS,
  control: CONTROL_CONFORMANCE_SCENARIOS,
  usage: USAGE_CONFORMANCE_SCENARIOS,
} as const;

export const BACKEND_CONFORMANCE_SCENARIOS = [
  ...SUBAGENT_CONFORMANCE_SCENARIOS,
  ...RUN_CONFORMANCE_SCENARIOS,
  ...CONTROL_CONFORMANCE_SCENARIOS,
  ...USAGE_CONFORMANCE_SCENARIOS,
] as const;

export type BackendConformanceScenario =
  (typeof BACKEND_CONFORMANCE_SCENARIOS)[number];

/* ============================================================== */
/* What a rig supplies                                             */
/* ============================================================== */

/** What the suite should do for one Run of a fixture. */
export interface ConformanceRunPlan {
  readonly controls?: readonly RunControl[];
  /** Completing this cancels the Run. The rig owns it and never completes it. */
  readonly cancelWhen?: Deferred.Deferred<void>;
  /** Make the observation sink fail on the nth observation. */
  readonly sinkFailsAt?: number;
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
  readonly observationKinds?: readonly RunObservationKind[];
  /** One admission outcome per offered Control, in admission order. */
  readonly steerOutcomes?: readonly string[];
}

export interface BackendConformanceExpectation {
  /** One entry per plan, in order. */
  readonly runs: readonly ExpectedRun[];
  /** What the backend actually received, across every Run. */
  readonly controlsReceived?: readonly string[];
  readonly maxConcurrentControls?: number;
  /** Admission before any Run has started, and after the last one. */
  readonly resumeBefore?: ResumeAdmission;
  readonly resumeAfter?: ResumeAdmission;
  /** Diagnostics `validateProfile` must report, in order. */
  readonly profileDiagnostics?: readonly string[];
}

export interface BackendConformanceFixture {
  readonly backend: Backend;
  readonly profile: Profile;
  readonly context: SubagentContext;
  /** Retained-resource counters, read after the Subagent Scope closes. */
  readonly counters: () => ResourceCountersSnapshot;
  /** One plan per Run the suite should drive. Empty means drive none. */
  readonly plans: readonly ConformanceRunPlan[];
  readonly expected: BackendConformanceExpectation;
  /** A shared ordering log the backend and the driver both append to. */
  readonly trace?: string[];
  /**
   * Close the BackendAgent explicitly, twice, before its scope closes it a
   * third time. Only the idempotent-close scenario asks for this.
   */
  readonly closeTwice?: boolean;
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

interface FixtureOutcome {
  readonly outcomes: readonly DriveOutcome[];
  readonly capabilities: BackendCapabilities;
  readonly resumeBefore: ResumeAdmission;
  readonly resumeAfter: ResumeAdmission;
  /** Admission between each pair of Runs, so resume is checked where it matters. */
  readonly resumeBetween: readonly ResumeAdmission[];
}

function identityFor(fixture: BackendConformanceFixture): DriverIdentity {
  return {
    subagentId: fixture.context.subagentId,
    backendId: fixture.backend.id,
    agent: fixture.profile.name,
    description: "conformance",
  };
}

/**
 * Open a BackendAgent, drive every planned Run through it in order, and close
 * the Subagent Scope. This is the shape every scenario shares; the scenario's
 * own point is asserted on top of it.
 */
function runFixture(
  fixture: BackendConformanceFixture,
): Promise<FixtureOutcome> {
  const identity = identityFor(fixture);
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const agent = yield* fixture.backend
        .open(fixture.profile, fixture.context)
        .pipe(Scope.provide(scope));
      const resumeBefore = agent.admitResume();
      const outcomes: DriveOutcome[] = [];
      const resumeBetween: ResumeAdmission[] = [];

      for (const [index, plan] of fixture.plans.entries()) {
        if (index > 0) resumeBetween.push(agent.admitResume());
        const options = {
          input: {
            runId: runId(`conformance-run-${index + 1}`),
            description: "conformance",
            prompt: "exercise the backend",
          },
          ...(plan.controls === undefined ? {} : { controls: plan.controls }),
          ...(plan.sinkFailsAt === undefined
            ? {}
            : { sinkFailsAt: plan.sinkFailsAt }),
          ...(fixture.trace === undefined ? {} : { trace: fixture.trace }),
        };
        if (!plan.cancelWhen) {
          outcomes.push(yield* driveRun(agent, identity, options));
          continue;
        }
        // Cancellation reaches the backend as interruption. The gate is
        // released once the driver has the execution in flight, so this is a
        // Run that was genuinely running when it was cancelled.
        const cancelWhen = plan.cancelWhen;
        const fiber = yield* Effect.forkChild(
          driveRun(agent, identity, { ...options, cancelWhen }),
        );
        yield* Deferred.succeed(cancelWhen, undefined);
        outcomes.push(yield* Fiber.join(fiber));
      }

      if (fixture.closeTwice) {
        // Idempotent close, asked for explicitly: the scope will close it a
        // third time on the way out.
        yield* agent.close();
        yield* agent.close();
      }
      const resumeAfter = agent.admitResume();
      const capabilities = agent.capabilities;
      yield* Scope.close(scope, Exit.void);
      return {
        outcomes,
        capabilities,
        resumeBefore,
        resumeAfter,
        resumeBetween,
      };
    }),
  );
}

/* ============================================================== */
/* Assertions                                                      */
/* ============================================================== */

function transcriptTextsOf(outcome: DriveOutcome): string[] {
  return outcome.result.transcript.map((item) =>
    item.parts
      .filter((part) => part.kind === "text")
      .map((part) => (part.kind === "text" ? part.text : ""))
      .join(""),
  );
}

function assertRun(
  outcome: DriveOutcome,
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
  if (expected.observationKinds !== undefined) {
    assert.deepEqual(
      outcome.observations.map((observation) => observation.kind),
      [...expected.observationKinds],
      `${where}: observation kinds`,
    );
  }
  if (expected.steerOutcomes !== undefined) {
    assert.deepEqual(
      outcome.controlOutcomes.map((control) => control.outcome),
      [...expected.steerOutcomes],
      `${where}: steer outcomes`,
    );
  }
}

function assertFixture(
  fixture: BackendConformanceFixture,
  outcome: FixtureOutcome,
): void {
  const { expected } = fixture;
  assert.equal(
    outcome.outcomes.length,
    expected.runs.length,
    "one expectation per planned Run",
  );
  for (const [index, run] of outcome.outcomes.entries()) {
    assertRun(run, expected.runs[index], `run ${index + 1}`);
  }
  if (expected.resumeBefore !== undefined) {
    assert.equal(
      outcome.resumeBefore,
      expected.resumeBefore,
      "resume admission before the first Run",
    );
  }
  if (expected.resumeAfter !== undefined) {
    assert.equal(
      outcome.resumeAfter,
      expected.resumeAfter,
      "resume admission after the last Run",
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

/** Every retained resource is released once the Subagent Scope has closed. */
function assertNoLeaks(fixture: BackendConformanceFixture): void {
  const counters = fixture.counters();
  assert.equal(counters.opens - counters.closes, 0, "opens minus closes");
  assert.equal(counters.liveExecutions, 0, "live executions");
  assert.equal(counters.liveSubscriptions, 0, "live subscriptions");
}

/* ============================================================== */
/* The suite                                                       */
/* ============================================================== */

/** What one scenario checks beyond the shared expectations. */
type ScenarioCheck = (
  fixture: BackendConformanceFixture,
  outcome: FixtureOutcome,
) => void;

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
  "open-creates-no-run": (fixture) => {
    const counters = fixture.counters();
    assert.equal(counters.opens, 1, "the BackendAgent was opened");
    assert.equal(
      counters.executionsStarted,
      0,
      "opening must start no execution",
    );
  },
  "capabilities-are-enforced": (fixture, outcome) => {
    // What the backend declared is what the caller acted on: an undeclared
    // Control is refused, and a declared one is admitted.
    const expectedOutcome = outcome.capabilities.steer
      ? "accepted"
      : "unsupported";
    const offered = outcome.outcomes.flatMap((run) => run.controlOutcomes);
    assert.ok(offered.length > 0, "no Control was offered");
    for (const control of offered) {
      assert.equal(control.outcome, expectedOutcome);
    }
    // A backend that declared no steering is never called about a Control at
    // all, which is what makes `unsupported` free of provider I/O.
    if (!outcome.capabilities.steer) {
      assert.deepEqual(fixture.counters().controlsReceived, []);
    } else {
      assert.equal(fixture.counters().controlsReceived.length, offered.length);
    }
    if (!outcome.capabilities.resume) {
      assert.equal(outcome.resumeBefore, "unsupported");
      assert.equal(outcome.resumeAfter, "unsupported");
    }
  },
  "resume-or-honest-refusal": (_fixture, outcome) => {
    // Whatever the answer is, it is one of the three and it matches what the
    // BackendAgent declared. A resumable backend may still honestly report
    // that its conversation is gone.
    assert.ok(
      ["admitted", "unsupported", "conversation lost"].includes(
        outcome.resumeAfter,
      ),
      `resume reported '${outcome.resumeAfter}'`,
    );
    if (!outcome.capabilities.resume) {
      assert.equal(outcome.resumeAfter, "unsupported");
    }
  },
  "close-is-idempotent": (fixture) => {
    // The scope closed the BackendAgent once; the rig closed it explicitly
    // beforehand. Either way it counts once.
    assert.equal(fixture.counters().closes, 1, "close counted more than once");
  },
  "close-releases-every-resource": (fixture) => {
    assertNoLeaks(fixture);
  },
  "observations-reduce-in-accepted-order": (_fixture, outcome) => {
    for (const run of outcome.outcomes) {
      assert.deepEqual(
        run.reports.filter((report) => report.report === "ignored-invalid"),
        [],
        "an observation was rejected as malformed",
      );
      // The transcript is the message observations, in the order they were
      // accepted. Anything else means the reduction reordered them.
      assert.deepEqual(
        run.result.transcript.map((item) => item.role),
        run.observations
          .filter((observation) => observation.kind === "message")
          .map((observation) =>
            observation.kind === "message" ? observation.role : "",
          ),
        "the transcript is not the messages in accepted order",
      );
    }
  },
  "exactly-one-ending-wins": (_fixture, outcome) => {
    for (const run of outcome.outcomes) {
      // Every ending the Run produced, in the order they were reduced. There
      // must be more than one — otherwise nothing competed — and exactly one
      // of them may have been applied.
      const endings = run.reports.filter(
        (report) =>
          (report.report === "ignored-late" ||
            report.report === "applied" ||
            report.report === "applied-with-truncation") &&
          ("kind" in report ? report.kind === "ending" : true),
      );
      const late = run.reports.filter(
        (report) =>
          report.report === "ignored-late" && report.kind === "ending",
      );
      assert.ok(
        late.length >= 1,
        "no competing ending was reported late, so nothing was arbitrated",
      );
      assert.ok(endings.length >= 2, "only one ending was produced");
      assert.equal(run.projection.terminal, true);
      // And the Run took the one legal route to its one terminal phase.
      assert.equal(run.phases.length, 3);
      assert.deepEqual(run.phases.slice(0, 2), ["running", "finalizing"]);
    }
  },
  "cancellation-terminates-with-partial-output": (fixture, outcome) => {
    for (const run of outcome.outcomes) {
      assert.equal(run.resolution, "interrupted");
      assert.deepEqual(run.phases, ["running", "finalizing", "cancelled"]);
    }
    assertNoLeaks(fixture);
  },
  "result-follows-scope-closure": (fixture) => {
    const trace = fixture.trace ?? [];
    const closed = trace.indexOf(DRIVER_STAGES.executionScopeClosed);
    const produced = trace.indexOf(DRIVER_STAGES.resultProduced);
    assert.ok(closed !== -1, "the execution scope closed");
    assert.ok(produced !== -1, "the result was produced");
    assert.ok(
      closed < produced,
      "the result must not exist before the finalizers ran",
    );
  },
  "late-events-cannot-mutate-a-terminal-run": (_fixture, outcome) => {
    for (const run of outcome.outcomes) {
      const late = run.reports.filter(
        (report) => report.report === "ignored-late",
      );
      assert.ok(late.length > 0, "the fixture emitted nothing late");
    }
  },
  "a-failing-sink-cannot-strand-the-execution": (fixture, outcome) => {
    for (const run of outcome.outcomes) {
      assert.equal(run.result.status, "failed");
    }
    assertNoLeaks(fixture);
  },
  "a-run-may-settle-with-no-observations": (_fixture, outcome) => {
    for (const run of outcome.outcomes) {
      assert.deepEqual(run.observations, []);
      assert.equal(run.result.finalOutput, "");
      assert.deepEqual(run.result.transcript, []);
      assert.equal(run.result.usage.turns, 0);
    }
  },
  "observations-carry-no-provider-vocabulary": (_fixture, outcome) => {
    for (const run of outcome.outcomes) {
      assert.ok(run.observations.length > 0, "the fixture emitted nothing");
      for (const observation of run.observations) {
        assert.deepEqual(
          findForbiddenKeys(observation),
          [],
          `${observation.kind} carries provider bookkeeping`,
        );
        for (const key of Object.keys(observation)) {
          assert.ok(
            OBSERVATION_KEYS[observation.kind].includes(key),
            `${observation.kind} carries an unlisted key '${key}'`,
          );
        }
      }
    }
  },
  "steering-admission-follows-the-declared-capability": (fixture, outcome) => {
    const offered = outcome.outcomes.flatMap((run) => run.controlOutcomes);
    assert.ok(offered.length > 0, "no Control was offered");
    const received = fixture.counters().controlsReceived;

    if (!outcome.capabilities.steer) {
      for (const control of offered) {
        assert.equal(control.outcome, "unsupported");
      }
      assert.deepEqual(
        received,
        [],
        "an unsupported Control must not reach the backend at all",
      );
      return;
    }
    for (const control of offered) {
      assert.equal(control.outcome, "accepted");
    }
    assert.equal(
      received.length,
      offered.length,
      "a backend that declared steering must receive what was admitted",
    );
  },
  "controls-are-delivered-serially-in-order": (fixture) => {
    const counters = fixture.counters();
    // The suite knows what was offered, so the order check does not depend on
    // the rig remembering to declare it. FIFO, and one at a time.
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
    assert.ok(outcome.outcomes.length >= 2, "this scenario needs two Runs");
    const byRun = fixture.counters().controlsByRun;
    const second = outcome.outcomes[1].result.runId;
    assert.deepEqual(
      byRun.get(second) ?? [],
      [],
      "a Control admitted to the first Run reached the second",
    );
  },
  "a-user-observation-appears-only-on-confirmation": (fixture, outcome) => {
    const received = fixture.counters().controlsReceived;
    assert.ok(received.length > 0, "no Control reached the backend");
    const userTexts = outcome.outcomes.flatMap((run) =>
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
  "usage-deltas-are-run-local": (_fixture, outcome) => {
    for (const run of outcome.outcomes) {
      // Run-local means exactly this: what the Run reports is the sum of the
      // deltas *it* emitted, and nothing else contributed.
      const streamed = run.observations.reduce(
        (total, observation) =>
          total +
          (observation.kind === "usage" ? (observation.usage.input ?? 0) : 0),
        0,
      );
      assert.ok(streamed > 0, "the Run emitted no usage, so nothing is proven");
      assert.equal(
        run.result.usage.totals.input,
        streamed,
        "the reported total is not the sum of this Run's own deltas",
      );
      for (const value of Object.values(run.result.usage.totals)) {
        assert.ok(value >= 0 && Number.isFinite(value));
      }
    }
  },
  "reconciliation-does-not-double-count": (fixture, outcome) => {
    for (const [index, run] of outcome.outcomes.entries()) {
      const streamed = run.observations.reduce(
        (total, observation) =>
          total +
          (observation.kind === "usage" ? (observation.usage.input ?? 0) : 0),
        0,
      );
      const reported = run.result.usage.totals.input;
      const declared = fixture.expected.runs[index].usageTotals?.input;
      assert.ok(
        streamed > 0,
        "the Run streamed no usage, so nothing could have been double counted",
      );
      assert.equal(
        typeof declared,
        "number",
        "this scenario needs the terminal figure declared, to compare against",
      );
      assert.notEqual(
        reported,
        streamed,
        "the reconciliation replaced nothing, so it healed nothing",
      );
      // The number a double count would produce: everything streamed, plus the
      // authoritative figure that was meant to supersede it.
      assert.notEqual(
        reported,
        streamed + (declared ?? 0),
        "reconciliation added to the streamed total instead of replacing it",
      );
    }
  },
  "context-occupancy-is-a-gauge": (_fixture, outcome) => {
    for (const run of outcome.outcomes) {
      const gauges = run.observations.filter(
        (observation) => observation.kind === "context",
      );
      assert.ok(gauges.length >= 2, "this scenario needs two gauge readings");
      const summed = gauges.reduce(
        (total, observation) =>
          total +
          (observation.kind === "context" ? observation.context.tokens : 0),
        0,
      );
      assert.notEqual(
        run.result.usage.context.tokens,
        summed,
        "the gauge was summed instead of replaced",
      );
      const last = gauges[gauges.length - 1];
      assert.deepEqual(
        run.result.usage.context,
        last.kind === "context" ? last.context : undefined,
        "the gauge is not the most recent reading",
      );
    }
  },
  "a-replayed-transcript-adds-no-usage": (_fixture, outcome) => {
    assert.ok(outcome.outcomes.length >= 2, "this scenario needs two Runs");
    const replaying = outcome.outcomes[outcome.outcomes.length - 1];
    const messages = replaying.observations.filter(
      (observation) => observation.kind === "message",
    );
    assert.ok(messages.length > 0, "the replaying Run reported no transcript");
    assert.deepEqual(
      replaying.observations.filter(
        (observation) => observation.kind === "usage",
      ),
      [],
      "a replay must carry no usage: it is not new work",
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
    assert.ok(outcome.outcomes.length >= 2, "this scenario needs two Runs");
    const [first, second] = outcome.outcomes;
    assert.equal(
      outcome.resumeBetween[0],
      "admitted",
      "the second Run did not resume the first Run's conversation",
    );
    assert.ok(
      first.result.usage.totals.input > 0,
      "the first Run spent nothing, so excluding it proves nothing",
    );
    // The property itself: the resumed Run reports the sum of the deltas *it*
    // emitted. Anything else — most obviously the provider's cumulative
    // reading, which is both Runs added together — is a different number.
    const ownDeltas = second.observations.reduce(
      (total, observation) =>
        total +
        (observation.kind === "usage" ? (observation.usage.input ?? 0) : 0),
      0,
    );
    assert.ok(ownDeltas > 0, "the resumed Run emitted no usage of its own");
    assert.equal(
      second.result.usage.totals.input,
      ownDeltas,
      "the resumed Run's total is not the sum of its own deltas",
    );
    assert.notEqual(
      second.result.usage.totals.input,
      first.result.usage.totals.input + ownDeltas,
      "the resumed Run was charged for the whole conversation",
    );
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
      const outcome = await runFixture(fixture);
      assertFixture(fixture, outcome);
      SCENARIO_CHECKS[scenario]?.(fixture, outcome);
      // Every scenario is a leak test: the Subagent Scope has closed by now.
      assertNoLeaks(fixture);
    });
  }
}
