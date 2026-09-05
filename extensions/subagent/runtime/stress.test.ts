import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { DEFAULT_PROJECTION_BOUNDS } from "../domain/index.ts";
import {
  emitActivity,
  emitText,
  emitToolCall,
  emitToolProgress,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  quiesce,
  rigRequest as request,
  type SessionRig,
  startedRun,
  untilTerminal,
  withSession,
} from "../testing/session-rig.ts";
import {
  assertNothingWentWrong,
  STEER,
  STRESS_POLICY,
  untilExecutions,
} from "../testing/stress-policy.ts";
import { probeIsClear } from "./counters.ts";
import { DEFAULT_RUNTIME_POLICY } from "./policy.ts";

/**
 * Hundreds of lifecycle cycles, with every bound as low as it goes.
 *
 * The tests elsewhere in this directory each drive one situation and prove one
 * rule. What none of them can show is *accumulation*: a fiber left alive one
 * cycle in fifty, a queue not closed when its Subagent is, a store byte
 * reserved and never released. Those show up as a slope, and a slope needs
 * repetition to have a gradient.
 *
 * So this lane repeats the whole public lifecycle — start, steer, resume,
 * cancel, close, and finally shutdown — several hundred times against each
 * fake, and asserts the runtime probe reads **zero after every cycle**. Not
 * only at the end: a leak found at the end says nothing about which cycle
 * introduced it, and returning to zero *between* cycles is the property that
 * actually matters, because a Session is many cycles long.
 *
 * Closing each cycle's Subagent is what makes that the right assertion. A
 * retained BackendAgent is *supposed* to hold the probe above zero — that is
 * what retention is — so a cycle that left one open could only be asserted
 * about at shutdown.
 *
 * ## The two fakes run different cycles, because their capabilities differ
 *
 * The resumable fake gets three Runs on one Subagent: one steered and
 * completed, one resumed and completed, one resumed and cancelled. The
 * one-shot fake declares neither resume nor steering, so it gets one Run per
 * Subagent, its steer is asserted to report `unsupported`, and cancellation is
 * what settles it. That is not a weaker cycle: it drives the cancellation path
 * three hundred times, and a cancelled Run still overruns every projection
 * bound, still stores a bounded partial result, and still evicts an older one.
 *
 * ## Every bound is lowered, and nothing waits
 *
 * A bound that is never reached is a bound this lane did not exercise, so
 * `STRESS_POLICY` is the smallest legal policy: a queue of one means the
 * intake is full on every observation, and a store budget of exactly a full
 * house of reservations means eviction runs on nearly every cycle. Everything
 * is on the test clock with a one-attempt delivery budget, so no sleep is
 * reachable and a cycle costs no wall-clock time at all — which is what makes
 * several hundred of them a `check` test rather than a nightly one.
 */

/** Enough cycles for a per-cycle leak of one resource to be unmissable. */
const CYCLES = 300;

/** How many Sessions the churn test builds and disposes. */
const SESSIONS = 60;

/** How many times shutdown arrives with a Run still in flight. */
const MID_FLIGHT_ROUNDS = 40;

/**
 * Everything a Run can say, all of it past a bound.
 *
 * The two messages plus the steer echo overrun a transcript bound of two; the
 * tool call and its progress overrun a tool bound of one; each text is longer
 * than the 32-byte part bound. The finalizer emit is registered *first*, so it
 * fires however the Run ends — which is what makes a cancelled Run produce a
 * late event too.
 */
const chatter: readonly FakeStep[] = [
  {
    step: "emit-in-finalizer",
    observation: { kind: "activity", activity: undefined },
  },
  emitActivity("looking around"),
  emitText("the first thing I found, at some length"),
  emitToolCall("read", "call-1"),
  emitToolProgress("call-1", "completed", "read it, at some length"),
  emitText("the second thing I found, at some length"),
  { step: "cumulative-usage", total: { input: 12, output: 8 } },
];

/** Chatter, a steer taken and confirmed, then a normal ending. */
const steeredRun: readonly FakeStep[] = [
  ...chatter,
  { step: "await-control", confirm: true },
  { step: "complete" },
];

/** Chatter and a normal ending, with no control expected. */
const quietRun: readonly FakeStep[] = [...chatter, { step: "complete" }];

/** Chatter, then nothing: only cancellation can end this Run. */
const hangingRun: readonly FakeStep[] = [...chatter, { step: "hang" }];

for (const resumable of [true, false]) {
  const fake = resumable ? "resumable" : "one-shot";
  /** Runs per cycle, which is also how many settle and how many are notified. */
  const runsPerCycle = resumable ? 3 : 1;

  test(`${CYCLES} lifecycle cycles against the ${fake} fake leave nothing behind`, async () => {
    const { value, noLeaks } = await withSession(
      {
        resumable,
        testClock: true,
        policy: STRESS_POLICY,
        // Consumed per BackendAgent, and each cycle closes its Subagent and
        // opens a new one — so this is one cycle's scripts, replayed by all of
        // them.
        steps: resumable ? [steeredRun, quietRun, hangingRun] : [hangingRun],
      },
      (rig: SessionRig) =>
        Effect.gen(function* () {
          /** The first cycle whose probe was not clear, if there was one. */
          let dirtyCycle: number | undefined;
          let dirtyProbe: string | undefined;
          let executions = 0;
          let settled = 0;
          let cancelled = 0;
          let steerOutcomes: string[] = [];
          let resumesStarted = 0;

          for (let cycle = 0; cycle < CYCLES; cycle += 1) {
            /* ---- start, and steer it while it is under way ---- */
            const first = startedRun(yield* rig.supervisor.start(request()));
            executions += 1;
            yield* untilExecutions(rig, executions);
            const steered = yield* rig.supervisor.steer(first.runId, {
              type: "steer",
              text: STEER,
            });
            // Recorded once rather than per cycle: three hundred identical
            // strings in a failure message would bury the one that differed.
            if (!steerOutcomes.includes(steered.outcome)) {
              steerOutcomes = [...steerOutcomes, steered.outcome];
            }

            if (resumable) {
              /* ---- the steered Run completes, then two resumes ---- */
              yield* untilTerminal(rig, first.runId);
              settled += 1;

              const again = startedRun(
                yield* rig.supervisor.resume({
                  subagentId: first.subagentId,
                  description: "again",
                  prompt: "have another look",
                }),
              );
              resumesStarted += 1;
              executions += 1;
              yield* untilTerminal(rig, again.runId);
              settled += 1;

              const long = startedRun(
                yield* rig.supervisor.resume({
                  subagentId: first.subagentId,
                  description: "something long",
                  prompt: "take your time",
                }),
              );
              resumesStarted += 1;
              executions += 1;
              yield* untilExecutions(rig, executions);
              const outcomes = yield* rig.supervisor.cancel([long.runId]);
              if (outcomes[0]?.outcome === "admitted") cancelled += 1;
              yield* untilTerminal(rig, long.runId);
              settled += 1;
            } else {
              /* ---- one Run, which cancellation is what ends ---- */
              const outcomes = yield* rig.supervisor.cancel([first.runId]);
              if (outcomes[0]?.outcome === "admitted") cancelled += 1;
              yield* untilTerminal(rig, first.runId);
              settled += 1;
            }

            yield* rig.supervisor.closeSubagentById(first.subagentId);
            // Delivery is forked from settlement, so let the forks finish
            // before reading: a notice still in flight holds a store pin, and
            // a pin in flight is not a leak.
            yield* quiesce();

            const probe = rig.supervisor.probe();
            if (!probeIsClear(probe) && dirtyCycle === undefined) {
              dirtyCycle = cycle;
              dirtyProbe = JSON.stringify(probe);
            }
          }

          /* ---- and finally shutdown, twice ---- */
          yield* rig.supervisor.shutdown();
          const afterShutdown = yield* rig.supervisor.start(request());
          // Idempotence is what a stress lane is most likely to catch a
          // mistake in: the second call must find nothing left to do.
          yield* rig.supervisor.shutdown();

          return {
            dirtyCycle,
            dirtyProbe,
            settled,
            cancelled,
            steerOutcomes,
            resumesStarted,
            afterShutdown: afterShutdown.outcome,
            counters: rig.supervisor.counters(),
            backend: rig.backend.counters(),
            notified: rig.sink.received().length,
          };
        }),
    );

    assert.equal(
      value.dirtyCycle,
      undefined,
      `the probe was not clear after cycle ${value.dirtyCycle}: ${value.dirtyProbe}`,
    );

    // Every cycle did what it said. A stress test whose operations were all
    // quietly rejected would otherwise pass with flying colours.
    assert.deepEqual(value.steerOutcomes, [
      resumable ? "accepted" : "unsupported",
    ]);
    assert.equal(value.cancelled, CYCLES);
    assert.equal(value.resumesStarted, resumable ? CYCLES * 2 : 0);
    assert.equal(value.settled, CYCLES * runsPerCycle);
    assert.equal(value.afterShutdown, "shutting down");
    assert.equal(value.backend.opens, CYCLES);
    assert.equal(value.backend.closes, CYCLES);

    assertNothingWentWrong(value.counters);

    // The counters that *should* rise, asserted to have risen. A bound nobody
    // reached would make the assertion above be about nothing.
    assert.ok(
      value.counters.evictions > 0,
      "the store budget was never reached, so eviction was not exercised",
    );
    assert.ok(
      value.counters.lateEvents >= CYCLES,
      `${value.counters.lateEvents} late events across ${CYCLES} cycles that each emitted at least one in a finalizer`,
    );

    // The backend released everything it acquired, which is the adapter half
    // of the claim the probe makes about the core.
    assert.equal(value.backend.liveExecutions, 0);
    assert.equal(value.backend.liveSubscriptions, 0);

    // Every settled Run was announced exactly once. A Session that told the
    // model twice, or forgot one, shows up as a count that is not the
    // settlement count.
    assert.equal(value.notified, value.settled);

    assert.equal(noLeaks, true);
  });
}

test(`${SESSIONS} Sessions built and disposed in turn each leave a clear probe`, async () => {
  // The other half of accumulation: a Pi process outlives its Sessions, so a
  // resource held by the *composition* rather than by a Subagent would only
  // show up as Sessions came and went. Each Session is left with a Run still
  // in flight, because closing the Session Scope cancelling it, awaiting its
  // cleanup, and releasing everything beneath it is the thing under test.
  const dirty: string[] = [];

  for (let session = 0; session < SESSIONS; session += 1) {
    const { value, probeAfterClose } = await withSession(
      {
        testClock: true,
        policy: STRESS_POLICY,
        steps: [steeredRun, hangingRun],
      },
      (rig: SessionRig) =>
        Effect.gen(function* () {
          const run = startedRun(yield* rig.supervisor.start(request()));
          yield* untilExecutions(rig, 1);
          yield* rig.supervisor.steer(run.runId, {
            type: "steer",
            text: STEER,
          });
          yield* untilTerminal(rig, run.runId);
          const read = yield* rig.supervisor.result(run.runId);
          const long = startedRun(
            yield* rig.supervisor.resume({
              subagentId: run.subagentId,
              description: "something long",
              prompt: "take your time",
            }),
          );
          yield* untilExecutions(rig, 2);
          // Let the execution reach its deliberate hang so Session disposal
          // does not interrupt it halfway through filling the bounded intake.
          yield* quiesce();
          return {
            outcome: read.outcome,
            leftRunning: long.runId,
            counters: rig.supervisor.counters(),
            backend: rig.backend,
          };
        }),
    );

    if (!probeIsClear(probeAfterClose)) {
      dirty.push(`session ${session}: ${JSON.stringify(probeAfterClose)}`);
    }
    assert.equal(value.outcome, "result");
    assertNothingWentWrong(value.counters);
    assert.equal(value.backend.counters().liveExecutions, 0);
    assert.equal(value.backend.counters().liveSubscriptions, 0);
  }

  assert.deepEqual(dirty, []);
});

test("shutdown arriving mid-flight strands no Run and rejects everything after", async () => {
  // Shutdown is the one operation the cycles above always reach with nothing
  // in flight. Here it arrives while a Run is mid-execution, repeatedly,
  // because "shutdown is idempotent and rejects new work" is easy to get right
  // once and wrong under repetition.
  const dirty: string[] = [];

  for (let round = 0; round < MID_FLIGHT_ROUNDS; round += 1) {
    const { value, probeAfterClose } = await withSession(
      {
        testClock: true,
        policy: STRESS_POLICY,
        steps: [hangingRun, hangingRun],
      },
      (rig: SessionRig) =>
        Effect.gen(function* () {
          const first = startedRun(yield* rig.supervisor.start(request()));
          yield* untilExecutions(rig, 1);
          const second = yield* rig.supervisor.start(request());

          yield* rig.supervisor.shutdown();
          yield* rig.supervisor.shutdown();

          const steerAfter = yield* rig.supervisor.steer(first.runId, {
            type: "steer",
            text: STEER,
          });
          return {
            second: second.outcome,
            afterShutdown: (yield* rig.supervisor.start(request())).outcome,
            steerAfterShutdown: steerAfter.outcome,
            counters: rig.supervisor.counters(),
            backend: rig.backend.counters(),
          };
        }),
    );

    if (!probeIsClear(probeAfterClose)) {
      dirty.push(`round ${round}: ${JSON.stringify(probeAfterClose)}`);
    }
    assert.equal(value.second, "started");
    assert.equal(value.afterShutdown, "shutting down");
    assert.notEqual(value.steerAfterShutdown, "accepted");
    assert.equal(value.backend.liveExecutions, 0);
    assert.equal(value.backend.opens, value.backend.closes);
    assertNothingWentWrong(value.counters);
  }

  assert.deepEqual(dirty, []);
});

test("the stress policy is a legal policy with every bound below the default", () => {
  // Not decoration: if a default moves below one of these, the lane above
  // stops exercising the bound it thinks it is exercising, and it would go on
  // passing. This is where that fails instead.
  assert.ok(STRESS_POLICY.maxActiveRuns < DEFAULT_RUNTIME_POLICY.maxActiveRuns);
  assert.ok(
    STRESS_POLICY.observationQueueBound <
      DEFAULT_RUNTIME_POLICY.observationQueueBound,
  );
  assert.ok(
    STRESS_POLICY.maxResultBytes <= DEFAULT_RUNTIME_POLICY.maxResultBytes,
  );
  assert.ok(
    STRESS_POLICY.resultStoreBytes < DEFAULT_RUNTIME_POLICY.resultStoreBytes,
  );
  assert.ok(
    STRESS_POLICY.controls.maxPending <
      DEFAULT_RUNTIME_POLICY.controls.maxPending,
  );
  for (const bound of [
    "maxTranscriptItems",
    "maxToolEntries",
    "maxDiagnostics",
    "maxLinks",
    "maxTextPartBytes",
    "maxFinalOutputBytes",
  ] as const) {
    assert.ok(
      STRESS_POLICY.projection[bound] < DEFAULT_PROJECTION_BOUNDS[bound],
      bound,
    );
  }
  // A store budget below a full house of reservations could never admit
  // `maxActiveRuns`, and the cycles assert that every operation was admitted.
  assert.equal(
    STRESS_POLICY.resultStoreBytes,
    STRESS_POLICY.maxActiveRuns * STRESS_POLICY.maxResultBytes,
  );
  // The steer has to fit the mailbox, or every cycle's steer would be refused
  // for its size and the outcome assertion would be measuring the wrong rule.
  assert.ok(
    new TextEncoder().encode(STEER).length <=
      STRESS_POLICY.controls.maxMessageBytes,
  );
});
