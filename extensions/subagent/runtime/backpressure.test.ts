import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Stream } from "effect";
import {
  DEFAULT_PROJECTION_BOUNDS,
  type RunObservation,
} from "../domain/index.ts";
import {
  emitActivity,
  emitText,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  rigRequest as request,
  startedRun,
  untilTerminal,
  untilUnderWay,
  withSession,
} from "../testing/session-rig.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";

/**
 * What happens when something produces faster than something else consumes.
 *
 * Four places in the runtime can be outrun, and each has a different right
 * answer:
 *
 * - the **observation intake** is bounded and *waits*, because a semantic
 *   observation is never silently dropped;
 * - the **control mailbox** is bounded and *refuses*, because a caller must
 *   never be blocked by one;
 * - **activity** is conflated, so a fast progress stream cannot grow anything;
 * - a **slow subscriber** to the Run index is never handed a value that is
 *   already stale. That does *not* fall out of `SubscriptionRef`, which
 *   delivers one element per change however far behind a consumer is — it is
 *   why `subscribe` reads the current index at delivery time, and it is
 *   checked here rather than assumed.
 *
 * Every test here ends with the probe clear, like every other M2 test.
 */

/** Enough messages to overrun a queue of two many times over. */
function burst(count: number): readonly FakeStep[] {
  return Array.from({ length: count }, (_unused, index) =>
    emitText(`message ${index}`),
  );
}

test("a burst far beyond the queue bound applies backpressure and loses nothing", async () => {
  const messages = 40;
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    // A queue of two, so the intake is full almost immediately and the
    // backend spends the Run waiting for the reducer.
    observationQueueBound: 2,
    projection: {
      ...DEFAULT_PROJECTION_BOUNDS,
      maxTranscriptItems: messages,
    },
  };

  const outcome = await withSession(
    { policy, steps: [[...burst(messages), { step: "complete" }]] },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        return {
          read: yield* rig.supervisor.result(run.runId),
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.equal(outcome.value.read.outcome, "result");
  if (outcome.value.read.outcome !== "result") return;
  const { result } = outcome.value.read;
  // Every one of them arrived, in order. Backpressure slowed the backend
  // down; it did not throw anything away.
  assert.equal(result.transcript.length, messages);
  assert.equal(result.finalOutput, `message ${messages - 1}`);
  assert.equal(result.truncation.droppedTranscriptItems, 0);
  assert.equal(outcome.value.counters.queueOverflows, 0);
  assert.equal(outcome.value.counters.lateEvents, 0);
  assert.equal(outcome.noLeaks, true);
});

test("a burst past the projection bound drops the oldest and says how many", async () => {
  const messages = 20;
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    observationQueueBound: 2,
    projection: { ...DEFAULT_PROJECTION_BOUNDS, maxTranscriptItems: 5 },
  };

  const outcome = await withSession(
    { policy, steps: [[...burst(messages), { step: "complete" }]] },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        return yield* rig.supervisor.result(run.runId);
      }),
  );

  assert.equal(outcome.value.outcome, "result");
  if (outcome.value.outcome !== "result") return;
  const { result } = outcome.value;
  // Bounded, newest kept, and honest about what went.
  assert.equal(result.transcript.length, 5);
  assert.equal(result.truncation.droppedTranscriptItems, messages - 5);
  assert.equal(result.finalOutput, `message ${messages - 1}`);
  assert.equal(outcome.noLeaks, true);
});

test("a full mailbox refuses immediately while the Run keeps running", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    controls: { maxPending: 3, maxMessageBytes: 1_024, maxPendingBytes: 4_096 },
  };

  const outcome = await withSession(
    {
      policy,
      gates: { hold },
      steps: [[emitText("under way"), { step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);
        const outcomes: string[] = [];
        for (let index = 0; index < 10; index += 1) {
          const admitted = yield* rig.supervisor.steer(run.runId, {
            type: "steer",
            text: `guidance ${index}`,
          });
          outcomes.push(admitted.outcome);
        }
        // The Run is still running: a full mailbox is not a failed Run.
        const phase = (yield* rig.repository.get(run.runId))?.phase;
        yield* rig.supervisor.cancel([run.runId]);
        yield* untilTerminal(rig, run.runId);
        return { outcomes, phase };
      }),
  );

  assert.deepEqual(outcome.value.outcomes.slice(0, 3), [
    "accepted",
    "accepted",
    "accepted",
  ]);
  for (const refused of outcome.value.outcomes.slice(3)) {
    assert.equal(refused, "mailbox full");
  }
  assert.equal(outcome.value.phase, "running");
  assert.equal(outcome.noLeaks, true);
});

test("high-frequency activity is conflated: the row holds one value, not a backlog", async () => {
  const updates = 200;
  const steps: FakeStep[] = [
    ...Array.from({ length: updates }, (_unused, index) =>
      emitActivity(`step ${index}`),
    ),
    emitText("the answer"),
    { step: "complete" },
  ];

  const outcome = await withSession(
    {
      policy: { ...DEFAULT_RUNTIME_POLICY, observationQueueBound: 4 },
      steps: [steps],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        return {
          snapshot: yield* rig.repository.get(run.runId),
          read: yield* rig.supervisor.result(run.runId),
        };
      }),
  );

  assert.equal(outcome.value.read.outcome, "result");
  if (outcome.value.read.outcome !== "result") return;
  const { result } = outcome.value.read;
  // Two hundred activity updates grew the projection by nothing: activity is
  // replaced, not accumulated, and the ending clears it.
  assert.equal(result.transcript.length, 1);
  assert.equal(result.truncation.droppedTranscriptItems, 0);
  // A settled Run is quiet.
  assert.equal(outcome.value.snapshot?.activity, undefined);
  assert.equal(outcome.noLeaks, true);
});

test("a slow subscriber is never handed a value that is already stale", async () => {
  const updates = 100;
  const outcome = await withSession(
    {
      policy: { ...DEFAULT_RUNTIME_POLICY, observationQueueBound: 4 },
      steps: [
        [
          ...Array.from({ length: updates }, (_unused, index) =>
            emitActivity(`step ${index}`),
          ),
          emitText("the answer"),
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const attached = yield* Deferred.make<void>();
        // A deliberately slow consumer: many scheduler points per frame, so
        // the publisher gets a long way ahead of it.
        const seen: (string | undefined)[] = [];
        const subscriber = yield* (yield* rig.repository.subscribe()).pipe(
          Stream.tap(() => Deferred.succeed(attached, undefined)),
          Stream.tap((index) =>
            Effect.gen(function* () {
              seen.push([...index.values()][0]?.activity);
              for (let step = 0; step < 20; step += 1) yield* Effect.yieldNow;
            }),
          ),
          Stream.takeUntil(
            (index) => [...index.values()][0]?.phase === "completed",
          ),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Deferred.await(attached);

        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        yield* Fiber.join(subscriber);
        return { seen, published: updates };
      }),
  );

  const activities = outcome.value.seen.filter(
    (activity): activity is string => activity !== undefined,
  );
  assert.ok(activities.length > 0, "the subscriber saw no activity at all");
  // Every value it was handed was the index as it stood at that moment, so
  // the sequence never goes backwards — a consumer that renders each one in
  // turn never draws a screen that has already been superseded.
  const indexes = activities.map((activity) =>
    Number(activity.replace("step ", "")),
  );
  assert.deepEqual(
    indexes,
    [...indexes].sort((left, right) => left - right),
  );
  // What it does *not* do is skip. `SubscriptionRef.changes` delivers one
  // element per change however far behind a consumer is, so a slow one gets
  // at least as many deliveries as there were changes — each carrying the
  // latest index, none carrying a stale one, and some carrying a value it has
  // already been given. Conflating those deliveries is the consumer's
  // business, and M3's is the first consumer there is.
  assert.equal(new Set(indexes).size, outcome.value.published);
  assert.ok(activities.length >= outcome.value.published);
  assert.equal(outcome.noLeaks, true);
});

test("a burst of every observation kind arrives whole through a queue of one", async () => {
  const kinds: readonly RunObservation[] = [
    { kind: "activity", activity: "starting" },
    { kind: "model", model: "model-a" },
    { kind: "context", context: { tokens: 100 } },
    { kind: "usage", usage: { input: 5 } },
    {
      kind: "diagnostic",
      diagnostic: { category: "other", message: "a note" },
    },
    { kind: "link", link: { kind: "log", label: "log", target: "/tmp/l" } },
  ];

  const outcome = await withSession(
    {
      policy: { ...DEFAULT_RUNTIME_POLICY, observationQueueBound: 1 },
      steps: [
        [
          ...kinds.map(
            (observation): FakeStep => ({ step: "emit", observation }),
          ),
          emitText("the answer"),
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        return yield* rig.supervisor.result(run.runId);
      }),
  );

  assert.equal(outcome.value.outcome, "result");
  if (outcome.value.outcome !== "result") return;
  const { result } = outcome.value;
  assert.equal(result.model, "model-a");
  assert.deepEqual(result.usage.context, { tokens: 100 });
  assert.equal(result.usage.totals.input, 5);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.category),
    ["other"],
  );
  assert.equal(result.links.length, 1);
  assert.equal(outcome.noLeaks, true);
});
