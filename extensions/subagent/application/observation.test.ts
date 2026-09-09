import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { answeredEnding } from "../domain/index.ts";
import {
  emitActivity,
  emitText,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  quiesce,
  rigRequest,
  startedRun,
  untilTerminal,
  withSession,
} from "../testing/session-rig.ts";
import {
  captureRunHistory,
  followPublishedRuns,
  followSubagentSummaries,
  inspectRun,
  pendingRefresh,
  publishedRuns,
  runSummaries,
  runtimeProbe,
  sessionCounters,
  subagentSummaries,
} from "./observation.ts";

/**
 * The host's whole read surface, tested where it lives.
 *
 * A Session and the scripted fakes, and no Pi host anywhere: an observation
 * bug used to be reachable only through a dashboard screen or a widget row,
 * which meant a scripted Session plus a stand-in terminal to prove a query
 * returned the wrong rows. These run the same reads directly.
 *
 * **The rule itself is asserted here**, on the rule. It used to be written
 * twice and differently — a capacity-1 sliding buffer behind the dashboard, a
 * `renderPending` boolean inside the widget — so the two host tests that
 * exercised it were each asserting a ratio over a mechanism the other could
 * not see. Those host tests survive, and should: what they check is that their
 * own surface still throttles, which is behaviour rather than mechanism.
 */

/** Enough publications that a follower which did not coalesce would show it. */
const BURST = 200;

const burstOfActivity = (): FakeStep[] =>
  Array.from({ length: BURST }, (_unused, index) =>
    emitActivity(`step ${index}`),
  );

test("many publications arm at most one pending refresh", () => {
  let performed = 0;
  const refresh = pendingRefresh(() => {
    performed += 1;
  });

  assert.equal(refresh.pending(), false);
  for (let ask = 0; ask < 100; ask += 1) refresh.request();
  assert.equal(performed, 1, "asking again while pending re-armed the work");
  assert.equal(refresh.pending(), true);

  // The refresh happens; the next ask arms the next one.
  refresh.done();
  assert.equal(refresh.pending(), false);
  refresh.request();
  assert.equal(performed, 2);

  // And `done` is idempotent: a second acknowledgement of one refresh does not
  // leave the latch owing a second.
  refresh.done();
  refresh.done();
  assert.equal(performed, 2);
  refresh.request();
  assert.equal(performed, 3);
});

test("a burst reaches every follower and still arms few refreshes", async () => {
  const outcome = await withSession(
    { steps: [[...burstOfActivity(), { step: "hang" }]] },
    (rig) =>
      Effect.gen(function* () {
        let publications = 0;
        let refreshes = 0;
        let newest = "";
        yield* followPublishedRuns(() => {
          publications += 1;
        });
        yield* followSubagentSummaries((summaries) => {
          refreshes += 1;
          newest = summaries[0]?.latest.activity ?? "";
        });
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        // Let the burst drain without letting real time pass.
        for (let turn = 0; turn < 4000; turn += 1) yield* Effect.yieldNow;
        yield* quiesce();
        // Read before the Run is stopped: terminal reduction clears activity,
        // and what is being checked here is what the burst left behind.
        const drained = { publications, refreshes, newest };
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        return drained;
      }),
  );

  const { publications, refreshes, newest } = outcome.value;
  // Every publication reaches a follower: the change stream is not conflated,
  // so a follower keeping a cache is never handed a value it has to guess at.
  assert.ok(
    publications > BURST / 2,
    `only ${publications} publications reached the follower`,
  );
  // And the query behind the summaries runs a small number of times, because
  // publications arriving while one is in flight arm exactly one more.
  assert.ok(refreshes > 0, "the summaries follower never ran");
  assert.ok(
    refreshes * 4 < publications,
    `${refreshes} summary reads for ${publications} publications is not coalescing`,
  );
  // Coalescing is not lossy: the last refresh saw the newest activity.
  assert.equal(newest, `step ${BURST - 1}`);
  assert.equal(outcome.noLeaks, true);
});

test("a follower's subscription belongs to its Scope", async () => {
  const outcome = await withSession({ steps: [[{ step: "hang" }]] }, (rig) =>
    Effect.gen(function* () {
      const before = rig.supervisor.probe().repositorySubscriptions;
      const held = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* followPublishedRuns(() => {});
          yield* followSubagentSummaries(() => {});
          return rig.supervisor.probe().repositorySubscriptions;
        }),
      );
      yield* quiesce();
      return {
        before,
        held,
        after: rig.supervisor.probe().repositorySubscriptions,
      };
    }),
  );

  assert.equal(outcome.value.before, 0);
  // Two followers, and the summaries follower holds one of its own.
  assert.equal(outcome.value.held, 2);
  assert.equal(outcome.value.after, 0);
  assert.equal(outcome.noLeaks, true);
});

test("summaries, history and inspection read one Session through one seam", async () => {
  const outcome = await withSession(
    {
      steps: [
        [
          emitActivity("looking around"),
          emitText("the rig answered"),
          { step: "complete", ending: answeredEnding() },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();

        const subagents = yield* subagentSummaries();
        const runs = yield* runSummaries(started.subagentId);
        const capture = yield* captureRunHistory(started.subagentId);
        const published = yield* publishedRuns();
        const inspection = yield* inspectRun(started.runId);
        return { subagents, runs, capture, published, inspection };
      }),
  );

  const { subagents, runs, capture, published, inspection } = outcome.value;
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0]?.phase, "idle");
  assert.equal(subagents[0]?.latest.label, "look around");
  assert.equal(subagents[0]?.current, undefined);

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.phase, "completed");
  assert.equal(runs[0]?.profile, "explore");

  // The rows and the instant they are dated from arrive as one value.
  assert.deepEqual(capture.runs, runs);
  assert.ok(capture.capturedAt >= (runs[0]?.settledAt ?? 0));

  assert.deepEqual(
    published.map((run) => run.identity.runId),
    [runs[0]?.runId],
  );

  assert.equal(inspection.outcome, "result");
  // Reading a Result through inspection neither consumes it nor pins it.
  assert.equal(outcome.probeAfterClose.unresolvedWaiters, 0);
  assert.equal(outcome.noLeaks, true);
});

test("failed history detail is captured without reading or pinning Results", async () => {
  const message = "safe failure detail\ncontinued";
  const outcome = await withSession(
    { steps: [[{ step: "fail", message }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();

        let resultReads = 0;
        const read = rig.store.read;
        Object.defineProperty(rig.store, "read", {
          configurable: true,
          value: (...args: Parameters<typeof read>) => {
            resultReads += 1;
            return read(...args);
          },
        });
        const pinsBefore = yield* rig.store.pinsOf(started.runId);
        const handedOffBefore = yield* rig.delivery.handedOff();

        const runs = yield* runSummaries(started.subagentId);
        const capture = yield* captureRunHistory(started.subagentId);

        return {
          runs,
          capture,
          resultReads,
          pinsBefore,
          pinsAfter: yield* rig.store.pinsOf(started.runId),
          handedOffBefore,
          handedOffAfter: yield* rig.delivery.handedOff(),
        };
      }),
  );

  assert.equal(
    outcome.value.runs[0]?.failureDetail,
    "safe failure detail continued",
  );
  assert.deepEqual(outcome.value.capture.runs, outcome.value.runs);
  assert.equal(outcome.value.resultReads, 0);
  assert.deepEqual(outcome.value.pinsAfter, outcome.value.pinsBefore);
  assert.deepEqual(outcome.value.handedOffAfter, outcome.value.handedOffBefore);
  assert.equal(outcome.noLeaks, true);
});

test("the Session's counters and its runtime probe read through the same seam", async () => {
  const outcome = await withSession({ steps: [[{ step: "hang" }]] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(yield* rig.supervisor.start(rigRequest()));
      yield* quiesce();
      const live = yield* runtimeProbe();
      const counters = yield* sessionCounters();
      yield* rig.supervisor.cancel([started.runId]);
      yield* untilTerminal(rig, started.runId);
      return { live, counters };
    }),
  );

  // A live Session holds its Run's fibers; the probe says so rather than
  // judging it, and the number that matters is the one read after the close.
  assert.ok(outcome.value.live.liveRunFibers >= 1);
  assert.equal(outcome.value.counters.duplicateSettlements, 0);
  assert.equal(outcome.value.counters.queueOverflows, 0);
  assert.equal(outcome.noLeaks, true);
});
