import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  DEFAULT_BACKEND_ID,
  type Profile,
  type RunId,
  type StartOutcome,
  type SubagentId,
} from "../domain/index.ts";
import {
  createFakeResumableBackend,
  type FakeBackendHandle,
} from "../testing/fakes/backend.ts";
import { emitText, type FakeStep, scripts } from "../testing/fakes/script.ts";
import { sessionRuntimeLayer } from "./composition.ts";
import { createRuntimeCounters, type RuntimeCounters } from "./counters.ts";
import {
  CompletionDelivery,
  createFakeNotificationSink,
  type FakeNotificationSink,
} from "./delivery.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";
import { RunRepository } from "./repository.ts";
import { ResultStore } from "./result-store.ts";
import { type StartRequest, SubagentSupervisor } from "./supervisor.ts";

/**
 * Delivery, against a fake sink.
 *
 * The property every test here is a form of: **the stored result is the
 * source, and delivery never writes to anything but its own bookkeeping and
 * the pin it was given.** That is what makes a failing sink survivable — a
 * retry re-reads the same immutable value, so it cannot announce something
 * different from what `agent_result` returns, and it has nothing with which
 * to alter settlement.
 */

const profile: Profile = {
  name: "explore",
  description: "The explore specialist",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Explore.",
};

const request = (overrides: Partial<StartRequest> = {}): StartRequest => ({
  agent: "explore",
  description: "look around",
  prompt: "have a look",
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
  ...overrides,
});

interface Rig {
  readonly supervisor: SubagentSupervisor["Service"];
  readonly repository: RunRepository["Service"];
  readonly store: ResultStore["Service"];
  readonly delivery: CompletionDelivery["Service"];
  readonly sink: FakeNotificationSink;
  readonly backend: FakeBackendHandle;
  readonly counters: RuntimeCounters;
}

interface RigOptions {
  readonly steps?: readonly (readonly FakeStep[])[];
  readonly policy?: RuntimePolicy;
  readonly gates?: Record<string, Deferred.Deferred<void>>;
  readonly testClock?: boolean;
}

function withSession<A>(
  options: RigOptions,
  body: (rig: Rig) => Effect.Effect<A>,
): Promise<A> {
  const backend = createFakeResumableBackend({
    scripts: scripts(...(options.steps ?? [[]])),
    ...(options.gates === undefined ? {} : { gates: options.gates }),
  });
  const sink = createFakeNotificationSink();
  const counters = createRuntimeCounters();

  const program = Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const repository = yield* RunRepository;
    const store = yield* ResultStore;
    const delivery = yield* CompletionDelivery;
    return yield* body({
      supervisor,
      repository,
      store,
      delivery,
      sink,
      backend,
      counters,
    });
  }).pipe(
    Effect.provide(
      sessionRuntimeLayer({
        backends: [backend.backend],
        profiles: {
          from: "list",
          profiles: [{ ...profile, backend: backend.backend.id }],
        },
        sink,
        counters,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
      }),
    ),
    Effect.scoped,
  );

  return Effect.runPromise(
    options.testClock
      ? program.pipe(Effect.provide(TestClock.layer()))
      : program,
  );
}

function startedRun(outcome: StartOutcome): {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
} {
  if (outcome.outcome !== "started") {
    throw new Error(`expected a started Run, got '${outcome.outcome}'`);
  }
  return outcome;
}

const untilDelivered = (rig: Rig, count: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      if (rig.sink.received().length >= count) return;
      yield* Effect.yieldNow;
    }
  });

const untilTerminal = (rig: Rig, runId: RunId): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      const known = yield* rig.repository.lookup(runId);
      if (known.state === "terminal") return;
      yield* Effect.yieldNow;
    }
  });

test("a settled Run produces exactly one notification, built from the stored result", async () => {
  const outcome = await withSession(
    { steps: [[emitText("the answer, at some length")]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilDelivered(rig, 1);
        // Let anything that would deliver a second time do so.
        for (let step = 0; step < 10; step += 1) yield* Effect.yieldNow;
        return {
          received: rig.sink.received(),
          attempts: rig.sink.attempts(),
          stored: yield* rig.supervisor.result(started.runId),
          subagentId: started.subagentId,
        };
      }),
  );

  assert.equal(outcome.received.length, 1);
  assert.equal(outcome.attempts, 1);
  const [notification] = outcome.received;
  assert.equal(notification.runId, "run-2");
  assert.equal(notification.subagentId, outcome.subagentId);
  assert.equal(notification.status, "completed");
  assert.equal(notification.agent, "explore");
  assert.equal(notification.description, "look around");
  // A preview, and a pointer to the rest.
  assert.equal(notification.preview, "the answer, at some length");
  assert.equal(notification.retrieveWith, "agent_result");
  // And the notification came from what was stored.
  assert.equal(outcome.stored.outcome, "result");
  if (outcome.stored.outcome === "result") {
    assert.equal(notification.preview, outcome.stored.result.finalOutput);
  }
});

test("a result is readable before its notification is pushed", async () => {
  // Storage precedes notification, so a model that reacts to a notification
  // the instant it lands never finds the result missing.
  const outcome = await withSession({ steps: [[emitText("done")]] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(yield* rig.supervisor.start(request()));
      yield* untilDelivered(rig, 1);
      return yield* rig.supervisor.result(started.runId);
    }),
  );

  assert.equal(outcome.outcome, "result");
});

test("a sink that fails once is retried on the clock and delivers one notification", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    deliveryRetryBudget: { attempts: 3, delayMillis: 1_000 },
  };

  const outcome = await withSession(
    { policy, testClock: true, steps: [[emitText("the answer")]] },
    (rig) =>
      Effect.gen(function* () {
        rig.sink.failNext(1);
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        // The retry is waiting on the runtime clock, not on real time.
        yield* TestClock.adjust(1_001);
        yield* untilDelivered(rig, 1);
        return {
          received: rig.sink.received().length,
          attempts: rig.sink.attempts(),
          stored: yield* rig.supervisor.result(started.runId),
          counters: rig.counters.counters(),
        };
      }),
  );

  assert.equal(outcome.received, 1);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.counters.deliveryFailures, 0);
  // The stored result was not touched by the failure or the retry.
  assert.equal(outcome.stored.outcome, "result");
  if (outcome.stored.outcome === "result") {
    assert.equal(outcome.stored.result.finalOutput, "the answer");
  }
});

test("a sink that always fails exhausts its budget, releases the pin, and leaves the result", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    deliveryRetryBudget: { attempts: 3, delayMillis: 1_000 },
  };

  const outcome = await withSession(
    { policy, testClock: true, steps: [[emitText("the answer")]] },
    (rig) =>
      Effect.gen(function* () {
        rig.sink.failNext(Number.POSITIVE_INFINITY);
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        // Two waits between three attempts.
        yield* TestClock.adjust(1_001);
        yield* TestClock.adjust(1_001);
        for (let step = 0; step < 10; step += 1) yield* Effect.yieldNow;
        return {
          received: rig.sink.received().length,
          attempts: rig.sink.attempts(),
          exhausted: yield* rig.delivery.exhausted(),
          pins: yield* rig.store.pinsOf(started.runId),
          stored: yield* rig.supervisor.result(started.runId),
          counters: rig.counters.counters(),
        };
      }),
  );

  assert.equal(outcome.received, 0);
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(outcome.exhausted, ["run-2"]);
  // The pin goes even when the notification never lands, or the result would
  // be one nothing could ever evict.
  assert.ok(!outcome.pins.includes("delivery"));
  assert.equal(outcome.counters.deliveryFailures, 1);
  // And the result is still there to be asked for.
  assert.equal(outcome.stored.outcome, "result");
});

test("a missed wake-up is recovered by the sweep, and nothing is delivered twice", async () => {
  const outcome = await withSession({ steps: [[emitText("done")]] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(yield* rig.supervisor.start(request()));
      yield* untilDelivered(rig, 1);
      // The sweep runs again over a store that has already been announced.
      yield* rig.delivery.sweep();
      yield* rig.delivery.sweep();
      return {
        received: rig.sink.received().length,
        attempts: rig.sink.attempts(),
        delivered: yield* rig.delivery.delivered(),
        runId: started.runId,
      };
    }),
  );

  assert.equal(outcome.received, 1);
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(outcome.delivered, [outcome.runId]);
});

test("a sweep delivers a stored result whose wake-up never arrived", async () => {
  // Simulating a missed wake-up directly: a result is committed without any
  // settlement having initiated delivery for it.
  const outcome = await withSession({}, (rig) =>
    Effect.gen(function* () {
      yield* rig.store.commit({
        runId: "run-orphan" as RunId,
        subagentId: "subagent-orphan" as SubagentId,
        backendId: rig.backend.backend.id,
        agent: "explore",
        description: "a Run whose notification was lost",
        status: "completed",
        finalOutput: "nobody was told",
        transcript: [],
        tools: [],
        usage: {
          totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          context: { tokens: 0 },
          turns: 0,
        },
        diagnostics: [],
        links: [],
        startedAt: 0,
        settledAt: 1,
        truncation: {
          droppedTranscriptItems: 0,
          droppedToolEntries: 0,
          droppedDiagnostics: 0,
          droppedLinks: 0,
          truncatedTranscriptBytes: 0,
          truncatedToolOutputBytes: 0,
          truncatedOutputBytes: 0,
        },
      });
      assert.equal(rig.sink.received().length, 0);

      yield* rig.delivery.sweep();
      yield* rig.delivery.sweep();
      return rig.sink.received();
    }),
  );

  assert.equal(outcome.length, 1);
  assert.equal(outcome[0].runId, "run-orphan");
  assert.equal(outcome[0].preview, "nobody was told");
});

test("a retry during another Run's settlement changes nothing about either Run", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    deliveryRetryBudget: { attempts: 3, delayMillis: 1_000 },
  };
  const hold = await Effect.runPromise(Deferred.make<void>());

  const outcome = await withSession(
    {
      policy,
      testClock: true,
      steps: [
        [emitText("the first")],
        [{ step: "await-gate", gate: "hold" }, emitText("the second")],
      ],
      gates: { hold },
    },
    (rig) =>
      Effect.gen(function* () {
        rig.sink.failNext(1);
        const first = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, first.runId);

        // The first Run's retry is pending on the clock. The second Run
        // settles while it waits.
        const resumed = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        const second = startedRun(resumed as StartOutcome);
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, second.runId);
        yield* TestClock.adjust(1_001);
        yield* untilDelivered(rig, 2);

        return {
          received: rig.sink
            .received()
            .map((notice) => notice.preview)
            .sort(),
          firstResult: yield* rig.supervisor.result(first.runId),
          secondResult: yield* rig.supervisor.result(second.runId),
        };
      }),
  );

  assert.deepEqual(outcome.received, ["the first", "the second"]);
  assert.equal(outcome.firstResult.outcome, "result");
  assert.equal(outcome.secondResult.outcome, "result");
});

test("after shutdown, an undelivered notification is dropped rather than queued", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    deliveryRetryBudget: { attempts: 3, delayMillis: 1_000 },
  };

  const outcome = await withSession(
    { policy, testClock: true, steps: [[emitText("never announced")]] },
    (rig) =>
      Effect.gen(function* () {
        rig.sink.failNext(Number.POSITIVE_INFINITY);
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        yield* rig.supervisor.shutdown();
        // Whatever the clock does now, nothing more is pushed.
        yield* TestClock.adjust(60_000);
        yield* rig.delivery.sweep();
        return {
          received: rig.sink.received().length,
          delivered: yield* rig.delivery.delivered(),
          stored: yield* rig.store.stored(),
        };
      }),
  );

  assert.equal(outcome.received, 0);
  assert.deepEqual(outcome.delivered, []);
  // The store was cleared, so there is nothing for a sweep to find either.
  assert.deepEqual(outcome.stored, []);
});
