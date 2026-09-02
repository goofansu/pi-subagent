import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { bridgeOverflowObservations } from "../backend/native-bridge.ts";
import { runId as makeRunId } from "../domain/index.ts";
import { emitText } from "../testing/fakes/script.ts";
import {
  rigRequest as request,
  startedRun,
  untilTerminal,
  withSession,
} from "../testing/session-rig.ts";
import { createRuntimeCounters } from "./counters.ts";
import { makeIntake, offerWithoutWaiting } from "./observation-intake.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";

/**
 * Controls, cancellation, timeout, cleanup escalation, shutdown, and wait.
 *
 * Everything here is about a Run *stopping* rather than a Run running, which
 * is where the interesting failures are: a Control that reaches the wrong Run,
 * a cancel that is mistaken for a terminal state, a finalizer that never
 * returns, a waiter that takes a Run down with it when its turn is aborted.
 *
 * Nothing sleeps. Where time has to pass it passes on a test clock.
 */

const steer = (text: string) => ({ type: "steer" as const, text });

/* ============================================================== */
/* Controls                                                        */
/* ============================================================== */

test("seventeen steers yield sixteen accepted and one mailbox full, immediately", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    { steps: [[{ step: "await-gate", gate: "hold" }]], gates: { hold } },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        const outcomes: string[] = [];
        for (let index = 1; index <= 17; index += 1) {
          const admitted = yield* rig.supervisor.steer(
            started.runId,
            steer(`guidance ${index}`),
          );
          outcomes.push(admitted.outcome);
        }
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);
        return outcomes;
      }),
  );

  assert.equal(value?.filter((outcome) => outcome === "accepted").length, 16);
  assert.equal(value?.[16], "mailbox full");
});

test("an oversized Control is invalid and a Control on a non-steering backend is unsupported", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      resumable: false,
      steps: [[{ step: "await-gate", gate: "hold" }]],
      gates: { hold },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        const unsupported = yield* rig.supervisor.steer(
          started.runId,
          steer("guidance"),
        );
        const oversized = yield* rig.supervisor.steer(
          started.runId,
          steer(
            "x".repeat(DEFAULT_RUNTIME_POLICY.controls.maxMessageBytes + 1),
          ),
        );
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);
        return {
          unsupported: unsupported.outcome,
          oversized: oversized.outcome,
          received: rig.backend.counters().controlsReceived,
        };
      }),
  );

  assert.equal(value?.unsupported, "unsupported");
  // Capability is checked before the bounds are: the backend was never asked.
  assert.equal(value?.oversized, "unsupported");
  assert.deepEqual(value?.received, []);
});

test("after cancel admission every steer is mailbox closed", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const finalizing = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      // The finalizer is held open, so the Run is genuinely in `finalizing`
      // when the second steer arrives: cancelled, not yet settled, which is
      // the window `mailbox closed` is about.
      steps: [
        [
          { step: "gate-the-finalizer", gate: "finalizing" },
          emitText("under way"),
          { step: "await-gate", gate: "hold" },
        ],
      ],
      gates: { hold, finalizing },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;

        const before = yield* rig.supervisor.steer(
          started.runId,
          steer("never delivered"),
        );
        const [cancelled] = yield* rig.supervisor.cancel([started.runId]);
        for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
        const phase = (yield* rig.repository.get(started.runId))?.phase;
        const after = yield* rig.supervisor.steer(
          started.runId,
          steer("too late"),
        );

        yield* Deferred.succeed(finalizing, undefined);
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);
        return {
          before: before.outcome,
          cancelled: cancelled.outcome,
          phase,
          after: after.outcome,
        };
      }),
  );

  assert.equal(value?.before, "accepted");
  assert.equal(value?.cancelled, "admitted");
  assert.equal(value?.phase, "finalizing");
  assert.equal(value?.after, "mailbox closed");
});

test("a Control admitted to one Run reaches neither it nor the Subagent's next Run", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("under way"),
          { step: "await-gate", gate: "hold" },
          { step: "await-control", confirm: true },
        ],
        [{ step: "await-control", confirm: true }, emitText("the next Run")],
      ],
      gates: { hold },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        // Let the execution actually begin: a Subagent whose BackendAgent
        // never ran has nothing to resume, and this scenario is about a Run
        // that was under way.
        for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
        yield* rig.supervisor.steer(started.runId, steer("never delivered"));
        yield* rig.supervisor.cancel([started.runId]);
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);

        const resumed = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "next",
          prompt: "next",
        });
        if (resumed.outcome === "started") {
          // The next Run takes from its own mailbox, which is empty and then
          // closed: nothing from the cancelled Run can be in it.
          for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
          yield* rig.supervisor.cancel([resumed.runId]);
          yield* untilTerminal(rig, resumed.runId);
        }

        return {
          resumed: resumed.outcome,
          delivered: rig.backend.counters().controlsReceived,
        };
      }),
  );

  assert.equal(value?.resumed, "started");
  assert.deepEqual(value?.delivered, []);
});

test("a steer on a settled Run names its terminal status, and on an unknown id says so", async () => {
  const { value } = await withSession({ steps: [[emitText("done")]] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(yield* rig.supervisor.start(request()));
      yield* untilTerminal(rig, started.runId);
      return {
        settled: (yield* rig.supervisor.steer(started.runId, steer("hello")))
          .outcome,
        unknown: (yield* rig.supervisor.steer(
          makeRunId("run-never"),
          steer("hello"),
        )).outcome,
      };
    }),
  );

  assert.deepEqual(value, {
    settled: "already completed",
    unknown: "unknown Run",
  });
});

/* ============================================================== */
/* Cancellation                                                    */
/* ============================================================== */

test("cancel twice is admitted then idempotent, and after settlement it names the status", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value, noLeaks } = await withSession(
    { steps: [[{ step: "await-gate", gate: "hold" }]], gates: { hold } },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        const [first] = yield* rig.supervisor.cancel([started.runId]);
        const [second] = yield* rig.supervisor.cancel([started.runId]);
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);
        const [afterSettlement] = yield* rig.supervisor.cancel([started.runId]);
        const result = yield* rig.supervisor.result(started.runId);
        const again = yield* rig.supervisor.result(started.runId);

        return {
          first: first.outcome,
          second: second.outcome,
          afterSettlement: afterSettlement.outcome,
          result,
          unchanged:
            result.outcome === "result" &&
            again.outcome === "result" &&
            again.result.settledAt === result.result.settledAt,
          // Cancelling a Run does not close its Subagent.
          closes: rig.backend.counters().closes,
        };
      }),
  );

  assert.equal(value?.first, "admitted");
  assert.equal(value?.second, "idempotent");
  assert.equal(value?.afterSettlement, "already cancelled");
  assert.equal(value?.result.outcome, "result");
  if (value?.result.outcome === "result") {
    assert.equal(value.result.result.status, "cancelled");
    assert.equal(value.result.result.cancellationReason, "requested");
  }
  assert.equal(value?.unchanged, true);
  assert.equal(value?.closes, 0);
  assert.equal(noLeaks, true);
});

test("cancelling an unknown Run reports it rather than pretending", async () => {
  const { value } = await withSession({}, (rig) =>
    rig.supervisor.cancel([makeRunId("run-never")]),
  );

  assert.deepEqual(value, [{ outcome: "unknown Run", runId: "run-never" }]);
});

test("a cancelled Run keeps the partial output it had", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      steps: [
        [emitText("as far as I got"), { step: "await-gate", gate: "hold" }],
      ],
      gates: { hold },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        // Let the first observation land before cancelling.
        for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
        yield* rig.supervisor.cancel([started.runId]);
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);
        return yield* rig.supervisor.result(started.runId);
      }),
  );

  assert.equal(value?.outcome, "result");
  if (value?.outcome !== "result") return;
  assert.equal(value.result.status, "cancelled");
  assert.equal(value.result.finalOutput, "as far as I got");
});

/* ============================================================== */
/* Timeout                                                         */
/* ============================================================== */

test("a Run that outlives the default timeout is cancelled with reason timeout", async () => {
  const never = await Effect.runPromise(Deferred.make<void>());
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    defaultRunTimeoutMillis: 60_000,
  };

  const { value, noLeaks } = await withSession(
    {
      policy,
      testClock: true,
      steps: [[{ step: "await-gate", gate: "never" }]],
      gates: { never },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        // Nothing waits on wall-clock time: the timeout fires because the
        // test clock says an hour went by.
        yield* TestClock.adjust(60_001);
        yield* untilTerminal(rig, started.runId);
        return yield* rig.supervisor.result(started.runId);
      }),
  );

  assert.equal(value?.outcome, "result");
  if (value?.outcome !== "result") return;
  assert.equal(value.result.status, "cancelled");
  // One reason, and it is the timeout's — not a `requested` from the
  // interruption that carried it out.
  assert.equal(value.result.cancellationReason, "timeout");
  assert.equal(noLeaks, true);
});

test("a Run that finishes before its timeout is not cancelled by it", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    defaultRunTimeoutMillis: 60_000,
  };

  const { value } = await withSession(
    { policy, testClock: true, steps: [[emitText("quick")]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        yield* TestClock.adjust(120_000);
        return yield* rig.supervisor.result(started.runId);
      }),
  );

  assert.equal(value?.outcome, "result");
  if (value?.outcome !== "result") return;
  assert.equal(value.result.status, "completed");
});

/* ============================================================== */
/* Cleanup escalation                                              */
/* ============================================================== */

test("a finalizer past the cleanup budget is escalated past, and the Run still settles", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    cleanupBudgetMillis: 5_000,
  };
  const trace: string[] = [];

  const { value } = await withSession(
    {
      policy,
      testClock: true,
      trace,
      steps: [[{ step: "hang-in-finalizer" }, emitText("the answer")]],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        // Let the Run reach its cleanup, then let the budget expire.
        for (let step = 0; step < 10; step += 1) yield* Effect.yieldNow;
        yield* TestClock.adjust(policy.cleanupBudgetMillis + 1);
        yield* untilTerminal(rig, started.runId);

        const laterResume = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        });
        return {
          result: yield* rig.supervisor.result(started.runId),
          snapshot: yield* rig.repository.get(started.runId),
          laterResume: laterResume.outcome,
          counters: rig.supervisor.counters(),
          closes: rig.backend.counters().closes,
        };
      }),
  );

  assert.equal(value?.result.outcome, "result");
  if (value?.result.outcome !== "result") return;
  // Terminal, never stuck in `finalizing`.
  assert.notEqual(value.snapshot?.phase, "finalizing");
  assert.deepEqual(
    value.result.result.diagnostics.map((diagnostic) => diagnostic.category),
    ["cleanup-escalation"],
  );
  assert.equal(value.counters.cleanupEscalations, 1);
  // The BackendAgent was closed out from under the hung finalizer, and a
  // later resume says so honestly.
  assert.equal(value.closes, 1);
  assert.equal(value.laterResume, "conversation lost");
});

/* ============================================================== */
/* Shutdown                                                        */
/* ============================================================== */

test("after shutdown begins, start, resume, and steer all answer shutting down", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value, noLeaks } = await withSession(
    { steps: [[{ step: "await-gate", gate: "hold" }]], gates: { hold } },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        // Shutdown cancels the Run it finds, so nothing has to release the
        // gate for this to finish.
        const shutting = yield* Effect.forkChild(rig.supervisor.shutdown());
        yield* Fiber.join(shutting);

        return {
          start: (yield* rig.supervisor.start(request())).outcome,
          resume: (yield* rig.supervisor.resume({
            subagentId: started.subagentId,
            description: "d",
            prompt: "p",
          })).outcome,
          steer: (yield* rig.supervisor.steer(started.runId, steer("hello")))
            .outcome,
          // A second shutdown is a no-op, not an error.
          second: yield* Effect.exit(rig.supervisor.shutdown()),
          stored: yield* rig.store.stored(),
          result: (yield* rig.supervisor.result(started.runId)).outcome,
          closes: rig.backend.counters().closes,
        };
      }),
  );

  assert.equal(value?.start, "shutting down");
  assert.equal(value?.resume, "shutting down");
  assert.equal(value?.steer, "shutting down");
  assert.equal(value?.second._tag, "Success");
  // The store is cleared and the identities are forgotten.
  assert.deepEqual(value?.stored, []);
  assert.equal(value?.closes, 1);
  assert.equal(noLeaks, true);
});

test("shutdown closes a Subagent by cancel-and-await-cleanup, so its Run settles first", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const trace: string[] = [];
  const { value } = await withSession(
    {
      trace,
      steps: [[emitText("partial"), { step: "await-gate", gate: "hold" }]],
      gates: { hold },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
        yield* rig.supervisor.shutdown();
        return {
          // Every local identity is forgotten, per operation semantics
          // section 5: the next Session did not start these Runs.
          forgotten: (yield* rig.repository.lookup(started.runId)).state,
          published: (yield* rig.repository.list()).length,
        };
      }),
  );

  assert.equal(value?.forgotten, "unknown");
  assert.equal(value?.published, 0);
  // The Run settled before its Subagent closed: the execution was released
  // first, which is what cancel-and-await-cleanup means.
  const released = trace.findIndex((entry) =>
    entry.startsWith("execution-released"),
  );
  const closed = trace.indexOf("agent-closed");
  assert.ok(released !== -1 && closed !== -1, trace.join(" "));
  assert.ok(released < closed, trace.join(" "));
});

/* ============================================================== */
/* Wait                                                            */
/* ============================================================== */

test("a wait returns the terminal status, and a repeated wait returns the same one", async () => {
  const { value } = await withSession({ steps: [[emitText("done")]] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(yield* rig.supervisor.start(request()));
      const first = yield* rig.supervisor.wait([started.runId]);
      const second = yield* rig.supervisor.wait([started.runId]);
      return { first, second };
    }),
  );

  assert.deepEqual(value?.first, [
    { outcome: "terminal", runId: "run-2", status: "completed" },
  ]);
  assert.deepEqual(value?.second, value?.first);
});

test("a wait that times out reports still running, and the Run carries on", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      testClock: true,
      steps: [[{ step: "await-gate", gate: "hold" }, emitText("eventually")]],
      gates: { hold },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        const waiting = yield* Effect.forkChild(
          rig.supervisor.wait([started.runId], 1_000),
        );
        yield* TestClock.adjust(1_001);
        const gaveUp = yield* Fiber.join(waiting);

        // The Run was untouched by the waiter giving up.
        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);
        return {
          gaveUp,
          settled: yield* rig.supervisor.wait([started.runId]),
          result: (yield* rig.supervisor.result(started.runId)).outcome,
        };
      }),
  );

  assert.deepEqual(value?.gaveUp, [
    { outcome: "still running", runId: "run-2" },
  ]);
  assert.deepEqual(value?.settled, [
    { outcome: "terminal", runId: "run-2", status: "completed" },
  ]);
  assert.equal(value?.result, "result");
});

test("interrupting a wait stops only that waiter", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value, noLeaks } = await withSession(
    {
      steps: [
        [{ step: "await-gate", gate: "hold" }, emitText("finished anyway")],
      ],
      gates: { hold },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        const waiting = yield* Effect.forkChild(
          rig.supervisor.wait([started.runId]),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);

        yield* Deferred.succeed(hold, undefined);
        yield* untilTerminal(rig, started.runId);
        return {
          result: yield* rig.supervisor.result(started.runId),
          // The interrupted waiter released the pin it was holding.
          pins: yield* rig.store.pinsOf(started.runId),
        };
      }),
  );

  assert.equal(value?.result.outcome, "result");
  if (value?.result.outcome === "result") {
    assert.equal(value.result.result.finalOutput, "finished anyway");
  }
  assert.ok(!value?.pins.includes("waiters"));
  assert.equal(noLeaks, true);
});

test("waiting on an unknown id reports it rather than blocking forever", async () => {
  const { value } = await withSession({}, (rig) =>
    rig.supervisor.wait([makeRunId("run-never")]),
  );

  assert.deepEqual(value, [{ outcome: "unknown Run", runId: "run-never" }]);
});

/* ============================================================== */
/* The native-callback bridge                                      */
/* ============================================================== */

test("a bridge that cannot wait fails the Run visibly rather than dropping", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const counters = createRuntimeCounters();
      // A queue of one, which is what a bridge under load effectively has.
      const intake = yield* makeIntake(1, counters);

      const first = offerWithoutWaiting(
        intake,
        {
          kind: "message",
          role: "assistant",
          parts: [{ kind: "text", text: "one" }],
        },
        counters,
      );
      const refused = offerWithoutWaiting(
        intake,
        {
          kind: "message",
          role: "assistant",
          parts: [{ kind: "text", text: "two" }],
        },
        counters,
      );

      // What a bridge that was refused must emit instead. Dropping is not on
      // the list, and neither is truncating.
      const escalation = bridgeOverflowObservations();
      const taken = yield* Queue.take(intake.queue);
      return {
        first,
        refused,
        escalation,
        taken: taken.kind,
        counters: counters.counters(),
      };
    }).pipe(Effect.scoped),
  );

  assert.equal(outcome.first, true);
  assert.equal(outcome.refused, false);
  assert.equal(outcome.counters.queueOverflows, 1);
  assert.deepEqual(
    outcome.escalation.map((observation) => observation.kind),
    ["diagnostic", "ending"],
  );
  assert.equal(
    outcome.escalation[0].kind === "diagnostic"
      ? outcome.escalation[0].diagnostic.category
      : undefined,
    "queue-overflow",
  );
  assert.equal(
    outcome.escalation[1].kind === "ending"
      ? outcome.escalation[1].ending.ending
      : undefined,
    "failed",
  );
  // Nothing was lost: the one that fitted is still there to be taken.
  assert.equal(outcome.taken, "message");
});
