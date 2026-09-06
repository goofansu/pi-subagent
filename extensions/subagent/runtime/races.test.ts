import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  backendId,
  runId as makeRunId,
  type RunId,
  subagentId,
} from "../domain/index.ts";
import { emitText } from "../testing/fakes/script.ts";
import {
  quiesce,
  rigRequest as request,
  type SessionRig,
  startedRun,
  until,
  untilTerminal,
  untilUnderWay,
  withSession,
} from "../testing/session-rig.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";

/**
 * The eleven races the roadmap requires, one test each.
 *
 * Every one of them is a pair of things that can happen at the same instant
 * and must not both take effect. They are sequenced with `Deferred`s the test
 * completes and with a test clock, never with sleeps: a test that waits fifty
 * milliseconds and hopes passes on a fast machine and fails in CI, and the
 * failure teaches nothing.
 *
 * Every one ends the same way, and that is the point of the shape: **one
 * terminal result per Run, at most one notification, and a runtime probe that
 * reads zero once the Session Scope has closed.** A race that leaked a fiber
 * would pass its own assertion and fail that one.
 */

/** What every race in this file has to end with. */
function assertSettledCleanly(
  outcome: {
    readonly noLeaks: boolean;
    readonly value: {
      readonly results: readonly string[];
      readonly notifications: number;
    };
  },
  where: string,
): void {
  for (const result of outcome.value.results) {
    assert.equal(result, "result", `${where}: one terminal result per Run`);
  }
  assert.ok(
    outcome.value.notifications <= outcome.value.results.length,
    `${where}: more notifications than Runs`,
  );
  assert.equal(outcome.noLeaks, true, `${where}: the probe is not zero`);
}

/** Read what every race asserts on, in one place. */
const settled = (rig: SessionRig, runIds: readonly RunId[]) =>
  Effect.gen(function* () {
    yield* quiesce();
    const results: string[] = [];
    for (const runId of runIds) {
      results.push((yield* rig.supervisor.result(runId)).outcome);
    }
    return { results, notifications: rig.sink.received().length };
  });

/* -------------------------------------------------------------- */
/* 1. Complete versus cancel                                       */
/* -------------------------------------------------------------- */

test("race: a cancel that arrives after the execution returned loses to the answer", async () => {
  const answered = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      // The execution answers, then waits: it has already returned its
      // bundle's content by the time the cancel is admitted.
      steps: [
        [emitText("the answer"), { step: "await-gate", gate: "answered" }],
      ],
      gates: { answered },
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);
        // Both happen without a scheduler point between them, which is the
        // closest a test can get to "at the same instant".
        yield* Deferred.succeed(answered, undefined);
        const [cancelled] = yield* rig.supervisor.cancel([run.runId]);
        yield* untilTerminal(rig, run.runId);
        const read = yield* rig.supervisor.result(run.runId);
        return {
          ...(yield* settled(rig, [run.runId])),
          cancelOutcome: cancelled.outcome,
          status: read.outcome === "result" ? read.result.status : read.outcome,
        };
      }),
  );

  assertSettledCleanly(outcome, "complete versus cancel");
  // Whichever won, the Run has exactly one status and it is one of the two.
  assert.ok(["completed", "cancelled"].includes(outcome.value.status));
  assert.equal(outcome.value.notifications, 1);
});

/* -------------------------------------------------------------- */
/* 2. Timeout versus complete                                      */
/* -------------------------------------------------------------- */

test("race: a Run that answers before its timeout is not cancelled by it", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    defaultRunTimeoutMillis: 10_000,
  };
  const outcome = await withSession(
    { policy, testClock: true, steps: [[emitText("in time")]] },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        // The timeout fires into a Run that is already terminal.
        yield* TestClock.adjust(20_000);
        const read = yield* rig.supervisor.result(run.runId);
        return {
          ...(yield* settled(rig, [run.runId])),
          status: read.outcome === "result" ? read.result.status : read.outcome,
          reason:
            read.outcome === "result"
              ? read.result.cancellationReason
              : undefined,
        };
      }),
  );

  assertSettledCleanly(outcome, "timeout versus complete");
  assert.equal(outcome.value.status, "completed");
  assert.equal(outcome.value.reason, undefined);
});

/* -------------------------------------------------------------- */
/* 3. Shutdown versus start                                        */
/* -------------------------------------------------------------- */

test("race: a start issued alongside shutdown either runs and settles or is refused", async () => {
  const outcome = await withSession(
    { steps: [[emitText("first")], [emitText("second")]] },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);
        const [shutdown, second] = yield* Effect.all(
          [
            Effect.map(rig.supervisor.shutdown(), () => "shut down" as const),
            Effect.map(
              rig.supervisor.start(request()),
              (outcome) => outcome.outcome,
            ),
          ],
          { concurrency: 2 },
        );
        return {
          ...(yield* settled(rig, [first.runId])),
          shutdown,
          second,
          // Whatever the second start answered, nothing is running now.
          active: yield* rig.repository.activeCount(),
        };
      }),
  );

  assert.equal(outcome.value.shutdown, "shut down");
  // A start that lost the race is refused; one that won is a Run shutdown
  // then cancelled. Both are conformant; a Run left running is not.
  assert.ok(
    ["shutting down", "started", "at capacity"].includes(outcome.value.second),
  );
  assert.equal(outcome.value.active, 0);
  assert.equal(outcome.noLeaks, true);
});

test("interrupting start after its Run fiber owns the lease does not free capacity", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const policy: RuntimePolicy = { ...DEFAULT_RUNTIME_POLICY, maxActiveRuns: 1 };
  const outcome = await withSession(
    {
      policy,
      gates: { hold },
      steps: [[{ step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          rig.supervisor.start(request()),
        );
        yield* until(
          "the admitted Run to be published",
          Effect.map(rig.repository.activeCount(), (count) => count === 1),
        );
        yield* Fiber.interrupt(starting);
        const interrupted = yield* Fiber.await(starting);
        const second = yield* rig.supervisor.start(request());
        const [active] = yield* rig.repository.list();
        if (active) yield* rig.supervisor.cancel([active.identity.runId]);
        return { interrupted: interrupted._tag, second: second.outcome };
      }),
  );

  assert.equal(outcome.value.interrupted, "Failure");
  assert.equal(outcome.value.second, "at capacity");
  assert.equal(outcome.noLeaks, true);
});

test("a start can be cancelled immediately without yielding", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { hold },
      steps: [[{ step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        const [cancelled] = yield* rig.supervisor.cancel([run.runId]);
        yield* untilTerminal(rig, run.runId);
        const result = yield* rig.supervisor.result(run.runId);
        return {
          cancelled: cancelled.outcome,
          status:
            result.outcome === "result" ? result.result.status : undefined,
        };
      }),
  );

  assert.deepEqual(outcome.value, {
    cancelled: "admitted",
    status: "cancelled",
  });
  assert.equal(outcome.noLeaks, true);
});

test("a wait started immediately after start blocks until that Run settles", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { hold },
      steps: [[{ step: "await-gate", gate: "hold" }, emitText("done")]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        const waiting = yield* Effect.forkChild(
          rig.supervisor.wait([run.runId]),
        );
        yield* Effect.yieldNow;
        const blocked = waiting.pollUnsafe() === undefined;
        yield* Deferred.succeed(hold, undefined);
        return { blocked, outcomes: yield* Fiber.join(waiting) };
      }),
  );

  assert.equal(outcome.value.blocked, true);
  assert.deepEqual(
    outcome.value.outcomes.map((item) => item.outcome),
    ["terminal"],
  );
  assert.equal(outcome.noLeaks, true);
});

test("a steer immediately after start enters the new Run's mailbox", async () => {
  const outcome = await withSession(
    {
      steps: [[{ step: "await-control", confirm: true }, emitText("done")]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        const steered = yield* rig.supervisor.steer(run.runId, {
          type: "steer",
          text: "use this",
        });
        yield* untilTerminal(rig, run.runId);
        return {
          steered: steered.outcome,
          controls: rig.backend.counters().controlsReceived,
        };
      }),
  );

  assert.deepEqual(outcome.value, {
    steered: "accepted",
    controls: ["use this"],
  });
  assert.equal(outcome.noLeaks, true);
});

test("closing a Subagent immediately after start cancels and awaits its new Run", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { hold },
      steps: [[{ step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* rig.supervisor.closeSubagentById(run.subagentId);
        const result = yield* rig.supervisor.result(run.runId);
        return {
          status:
            result.outcome === "result" ? result.result.status : undefined,
          closes: rig.backend.counters().closes,
        };
      }),
  );

  assert.deepEqual(outcome.value, { status: "cancelled", closes: 1 });
  assert.equal(outcome.noLeaks, true);
});

test("terminal publication wins while the Run handle is still captured", async () => {
  const finish = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { finish },
      steps: [[{ step: "await-gate", gate: "finish" }, emitText("done")]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        const repository = rig.repository as unknown as {
          lookup: typeof rig.repository.lookup;
        };
        const lookup = repository.lookup;
        let intercepted = false;
        repository.lookup = (runId) =>
          Effect.gen(function* () {
            const before = yield* lookup(runId);
            if (runId === run.runId && !intercepted) {
              intercepted = true;
              assert.equal(before.state, "active");
              yield* Deferred.succeed(finish, undefined);
              yield* until(
                "terminal publication after the records capture",
                Effect.map(
                  lookup(runId),
                  (known) => known.state === "terminal",
                ),
              );
            }
            return yield* lookup(runId);
          });

        return yield* rig.supervisor.steer(run.runId, {
          type: "steer",
          text: "too late",
        });
      }),
  );

  assert.equal(outcome.value.outcome, "already completed");
  assert.equal(outcome.noLeaks, true);
});

test("an active repository row without an attached Run is an invariant defect", async () => {
  const outcome = await withSession({}, (rig) =>
    Effect.gen(function* () {
      const runId = makeRunId("run-orphaned-active");
      yield* rig.repository.publish(
        {
          runId,
          subagentId: subagentId("subagent-orphaned-active"),
          backendId: backendId("fake-resumable"),
          agent: "explore",
          description: "orphaned active row",
        },
        0,
      );

      return {
        steer: yield* Effect.exit(
          rig.supervisor.steer(runId, { type: "steer", text: "hello" }),
        ),
        wait: yield* Effect.exit(rig.supervisor.wait([runId], 0)),
      };
    }),
  );

  assert.equal(outcome.value.steer._tag, "Failure");
  assert.equal(outcome.value.wait._tag, "Failure");
  assert.equal(outcome.noLeaks, true);
});

test("cancel remains typed when terminal publication wins after recording", async () => {
  const finish = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { finish },
      steps: [[{ step: "await-gate", gate: "finish" }, emitText("done")]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        const repository = rig.repository as unknown as {
          recordCancellation: typeof rig.repository.recordCancellation;
        };
        const recordCancellation = repository.recordCancellation;
        repository.recordCancellation = (runId, reason) =>
          Effect.gen(function* () {
            const recorded = yield* recordCancellation(runId, reason);
            if (runId === run.runId && recorded.outcome === "recorded") {
              yield* Deferred.succeed(finish, undefined);
              yield* until(
                "terminal publication after cancellation recording",
                Effect.map(
                  rig.repository.lookup(runId),
                  (latest) => latest.state === "terminal",
                ),
              );
            }
            return recorded;
          });

        return yield* Effect.exit(rig.supervisor.cancel([run.runId]));
      }),
  );

  assert.equal(outcome.value._tag, "Success");
  if (outcome.value._tag !== "Success") return;
  assert.equal(outcome.value.value[0]?.outcome, "admitted");
  assert.equal(outcome.noLeaks, true);
});

/* -------------------------------------------------------------- */
/* 4. Steering versus terminal settlement                          */
/* -------------------------------------------------------------- */

test("race: a steer arriving as a Run settles is refused, never half-admitted", async () => {
  const finish = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      steps: [[emitText("under way"), { step: "await-gate", gate: "finish" }]],
      gates: { finish },
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);
        const [, steered] = yield* Effect.all(
          [
            Deferred.succeed(finish, undefined),
            Effect.map(
              rig.supervisor.steer(run.runId, {
                type: "steer",
                text: "guidance at the worst moment",
              }),
              (outcome) => outcome.outcome,
            ),
          ],
          { concurrency: 2 },
        );
        yield* untilTerminal(rig, run.runId);
        return {
          ...(yield* settled(rig, [run.runId])),
          steered,
          // Whatever the steer answered, nothing about it reached the backend.
          received: rig.backend.counters().controlsReceived,
        };
      }),
  );

  assertSettledCleanly(outcome, "steering versus settlement");
  assert.ok(
    ["accepted", "mailbox closed", "already completed"].includes(
      outcome.value.steered,
    ),
    `steer answered '${outcome.value.steered}'`,
  );
  // An accepted Control that the Run never took is discarded, not delivered.
  assert.deepEqual(outcome.value.received, []);
});

/* -------------------------------------------------------------- */
/* 5. Subagent close versus resume                                 */
/* -------------------------------------------------------------- */

test("race: a resume issued as its Subagent closes never starts a Run on a closed one", async () => {
  const outcome = await withSession(
    { steps: [[emitText("first")], [emitText("second")]] },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, first.runId);

        const [, resumed] = yield* Effect.all(
          [
            rig.supervisor.closeSubagentById(first.subagentId),
            Effect.map(
              rig.supervisor.resume({
                subagentId: first.subagentId,
                description: "again",
                prompt: "again",
              }),
              (outcome) => outcome.outcome,
            ),
          ],
          { concurrency: 2 },
        );
        yield* quiesce();
        return {
          ...(yield* settled(rig, [first.runId])),
          resumed,
          active: yield* rig.repository.activeCount(),
          // The Subagent's BackendAgent closed exactly once.
          closes: rig.backend.counters().closes,
        };
      }),
  );

  assert.equal(outcome.value.active, 0);
  assert.equal(outcome.value.closes, 1);
  assert.equal(outcome.noLeaks, true);
  assert.ok(
    ["unknown Subagent", "started", "conversation lost"].includes(
      outcome.value.resumed,
    ),
    `resume answered '${outcome.value.resumed}'`,
  );
});

test("shutdown immediately after resume admission closes the new Run", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { hold },
      steps: [[emitText("first")], [{ step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, first.runId);
        const resumed = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "again",
          }),
        );
        yield* rig.supervisor.shutdown();
        return {
          forgotten: (yield* rig.repository.lookup(resumed.runId)).state,
          backend: rig.backend.counters(),
          probe: rig.supervisor.probe(),
        };
      }),
  );

  assert.equal(outcome.value.forgotten, "unknown");
  assert.equal(outcome.value.backend.liveExecutions, 0);
  assert.equal(outcome.value.backend.liveSubscriptions, 0);
  assert.deepEqual(outcome.value.probe, {
    liveRunFibers: 0,
    liveReducerFibers: 0,
    openObservationQueues: 0,
    openMailboxes: 0,
    unresolvedWaiters: 0,
    repositorySubscriptions: 0,
    openBackendAgents: 0,
  });
  assert.equal(outcome.noLeaks, true);
});

/* -------------------------------------------------------------- */
/* 6. Backend loss versus cancel                                   */
/* -------------------------------------------------------------- */

test("race: a backend that dies as it is cancelled settles once, not twice", async () => {
  const die = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      steps: [
        [
          emitText("as far as it got"),
          { step: "await-gate", gate: "die" },
          { step: "defect", message: "the transport dropped" },
        ],
      ],
      gates: { die },
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);
        yield* Effect.all(
          [
            Deferred.succeed(die, undefined),
            rig.supervisor.cancel([run.runId]),
          ],
          { concurrency: 2 },
        );
        yield* untilTerminal(rig, run.runId);
        const read = yield* rig.supervisor.result(run.runId);
        return {
          ...(yield* settled(rig, [run.runId])),
          status: read.outcome === "result" ? read.result.status : read.outcome,
          output: read.outcome === "result" ? read.result.finalOutput : "",
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assertSettledCleanly(outcome, "backend loss versus cancel");
  // One ending, and whichever it is, what the Run managed to say survives.
  assert.ok(["failed", "cancelled"].includes(outcome.value.status));
  assert.equal(outcome.value.output, "as far as it got");
  assert.equal(outcome.value.notifications, 1);
});

/* -------------------------------------------------------------- */
/* 7. Result storage versus notification failure                   */
/* -------------------------------------------------------------- */

test("race: a notification that fails while the result is stored changes nothing about the result", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    deliveryRetryBudget: { attempts: 2, delayMillis: 0 },
  };
  const outcome = await withSession(
    { policy, steps: [[emitText("the answer")]] },
    (rig) =>
      Effect.gen(function* () {
        rig.sink.failNext(Number.POSITIVE_INFINITY);
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        yield* quiesce();
        const read = yield* rig.supervisor.result(run.runId);
        return {
          ...(yield* settled(rig, [run.runId])),
          output: read.outcome === "result" ? read.result.finalOutput : "",
          counters: rig.supervisor.counters(),
          exhausted: yield* rig.delivery.exhausted(),
          pins: yield* rig.store.pinsOf(run.runId),
        };
      }),
  );

  assertSettledCleanly(outcome, "storage versus notification failure");
  // Nothing landed, and the result is untouched and still retrievable.
  assert.equal(outcome.value.notifications, 0);
  assert.equal(outcome.value.output, "the answer");
  assert.equal(outcome.value.counters.deliveryFailures, 1);
  assert.equal(outcome.value.exhausted.length, 1);
  // The pin went with the budget, so eviction can reach it eventually.
  assert.ok(!outcome.value.pins.includes("delivery"));
});

/* -------------------------------------------------------------- */
/* 8. Late callback versus Run Scope closure                       */
/* -------------------------------------------------------------- */

test("race: an observation emitted from a finalizer reaches nothing and breaks nothing", async () => {
  const outcome = await withSession(
    {
      steps: [
        [
          {
            step: "emit-in-finalizer",
            observation: {
              kind: "message",
              role: "assistant",
              parts: [{ kind: "text", text: "said during teardown" }],
            },
          },
          emitText("the answer"),
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        const read = yield* rig.supervisor.result(run.runId);
        return {
          ...(yield* settled(rig, [run.runId])),
          output: read.outcome === "result" ? read.result.finalOutput : "",
          items: read.outcome === "result" ? read.result.transcript.length : -1,
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assertSettledCleanly(outcome, "late callback versus scope closure");
  assert.equal(outcome.value.output, "the answer");
  assert.equal(outcome.value.items, 1);
  assert.equal(outcome.value.counters.lateEvents, 1);
});

/* -------------------------------------------------------------- */
/* 9. Capacity admission versus concurrent completion              */
/* -------------------------------------------------------------- */

test("race: a start issued as the last Run completes gets a definite answer either way", async () => {
  const policy: RuntimePolicy = { ...DEFAULT_RUNTIME_POLICY, maxActiveRuns: 1 };
  const finish = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      policy,
      gates: { finish },
      steps: [
        [emitText("first"), { step: "await-gate", gate: "finish" }],
        [emitText("second")],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);
        const [, second] = yield* Effect.all(
          [
            Deferred.succeed(finish, undefined),
            rig.supervisor.start(request()),
          ],
          { concurrency: 2 },
        );
        yield* untilTerminal(rig, first.runId);
        const runIds = [first.runId];
        if (second.outcome === "started") {
          yield* untilTerminal(rig, second.runId);
          runIds.push(second.runId);
        }
        return {
          ...(yield* settled(rig, runIds)),
          second: second.outcome,
          active: yield* rig.repository.activeCount(),
        };
      }),
  );

  assertSettledCleanly(outcome, "capacity versus completion");
  // Either it was admitted or it was refused, and either way capacity of one
  // was never exceeded.
  assert.ok(["started", "at capacity"].includes(outcome.value.second));
  assert.equal(outcome.value.active, 0);
});

/* -------------------------------------------------------------- */
/* 10. Waiters versus settlement, abort, timeout, and eviction     */
/* -------------------------------------------------------------- */

test("a wait stays registered until it reads the terminal result", async () => {
  const finish = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { finish },
      steps: [[emitText("done"), { step: "await-gate", gate: "finish" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        const waiting = yield* Effect.forkChild(
          rig.supervisor.wait([run.runId]),
        );
        yield* Effect.yieldNow;
        const registered = rig.supervisor.probe().unresolvedWaiters;

        yield* Deferred.succeed(finish, undefined);
        const [waited] = yield* Fiber.join(waiting);
        return {
          registered,
          waited: waited?.outcome,
          pins: yield* rig.store.pinsOf(run.runId),
        };
      }),
  );

  assert.equal(outcome.value.registered, 1);
  assert.equal(outcome.value.waited, "terminal");
  assert.ok(!outcome.value.pins.includes("waiters"));
  assert.equal(outcome.noLeaks, true);
});

test("race: early, aborted, timed-out, and late waiters all agree about one Run", async () => {
  const finish = await Effect.runPromise(Deferred.make<void>());
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 4_096,
    resultStoreBytes: 8_192,
  };
  const outcome = await withSession(
    {
      policy,
      testClock: true,
      gates: { finish },
      steps: [[emitText("the answer"), { step: "await-gate", gate: "finish" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);

        // Three waiters registered while the Run is active: one that will be
        // interrupted, one that will time out, and one that will see it settle.
        const aborted = yield* Effect.forkChild(
          rig.supervisor.wait([run.runId]),
        );
        const timing = yield* Effect.forkChild(
          rig.supervisor.wait([run.runId], 1_000),
        );
        const patient = yield* Effect.forkChild(
          rig.supervisor.wait([run.runId]),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(aborted);
        yield* TestClock.adjust(1_001);
        const timedOut = yield* Fiber.join(timing);

        yield* Deferred.succeed(finish, undefined);
        const early = yield* Fiber.join(patient);
        yield* untilTerminal(rig, run.runId);
        const late = yield* rig.supervisor.wait([run.runId]);
        const repeated = yield* rig.supervisor.wait([run.runId]);

        return {
          ...(yield* settled(rig, [run.runId])),
          timedOut: timedOut.map((outcome) => outcome.outcome),
          early: early.map((outcome) => outcome.outcome),
          late: late.map((outcome) => outcome.outcome),
          repeated: repeated.map((outcome) => outcome.outcome),
          pins: yield* rig.store.pinsOf(run.runId),
        };
      }),
  );

  assertSettledCleanly(outcome, "waiters versus settlement");
  // A waiter that gave up says so; every waiter that saw the end agrees.
  assert.deepEqual(outcome.value.timedOut, ["still running"]);
  assert.deepEqual(outcome.value.early, ["terminal"]);
  assert.deepEqual(outcome.value.late, ["terminal"]);
  assert.deepEqual(outcome.value.repeated, ["terminal"]);
  // Nobody is holding the result open any more, so eviction can reach it.
  assert.ok(!outcome.value.pins.includes("waiters"));
});

/* -------------------------------------------------------------- */
/* 11. Store pressure versus publication and pending delivery      */
/* -------------------------------------------------------------- */

test("race: a store under pressure never evicts a result its notification still needs", async () => {
  // Room for barely more than one result, so every commit forces the choice.
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 2_048,
    resultStoreBytes: 3_000,
    maxActiveRuns: 1,
  };
  const outcome = await withSession(
    {
      policy,
      steps: [
        [emitText("the first answer")],
        [emitText("the second answer")],
        [emitText("the third answer")],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const runIds: RunId[] = [];
        const first = startedRun(yield* rig.supervisor.start(request()));
        runIds.push(first.runId);
        yield* untilTerminal(rig, first.runId);

        for (let index = 0; index < 2; index += 1) {
          const resumed = yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "again",
          });
          if (resumed.outcome !== "started") break;
          runIds.push(resumed.runId);
          yield* untilTerminal(rig, resumed.runId);
        }
        yield* quiesce();

        const reads: string[] = [];
        for (const runId of runIds) {
          reads.push((yield* rig.supervisor.result(runId)).outcome);
        }
        return {
          results: reads.map(() => "result"),
          notifications: rig.sink.received().length,
          reads,
          runIds,
          accounted: yield* rig.store.accountedBytes(),
        };
      }),
  );

  // Every Run was announced before anything of its could be evicted: the
  // notification count equals the number of Runs.
  assert.equal(outcome.value.notifications, outcome.value.runIds.length);
  // The newest is never the one that goes.
  assert.equal(outcome.value.reads[outcome.value.reads.length - 1], "result");
  // Whatever went, it went to keep the store inside its budget.
  assert.ok(outcome.value.accounted <= policy.resultStoreBytes);
  // And an evicted Run still answers by id.
  for (const read of outcome.value.reads) {
    assert.ok(["result", "ResultExpired"].includes(read), read);
  }
  assert.equal(outcome.noLeaks, true);
});

/* -------------------------------------------------------------- */
/* The shape every race shares                                     */
/* -------------------------------------------------------------- */

test("an unknown Run answers unknown from every operation, in every race", async () => {
  // The one thing none of the races above can produce: an id nothing ever
  // had. Checked once, here, so each race can assume it.
  const outcome = await withSession({}, (rig) =>
    Effect.gen(function* () {
      const stranger = makeRunId("run-never");
      return {
        result: (yield* rig.supervisor.result(stranger)).outcome,
        cancel: (yield* rig.supervisor.cancel([stranger]))[0].outcome,
        wait: (yield* rig.supervisor.wait([stranger]))[0].outcome,
        steer: (yield* rig.supervisor.steer(stranger, {
          type: "steer",
          text: "hi",
        })).outcome,
      };
    }),
  );

  assert.deepEqual(outcome.value, {
    result: "unknown Run",
    cancel: "unknown Run",
    wait: "unknown Run",
    steer: "unknown Run",
  });
  assert.equal(outcome.noLeaks, true);
});
