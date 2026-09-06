import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { emitText } from "../testing/fakes/script.ts";
import {
  quiesce,
  rigRequest as request,
  startedRun,
  until,
  untilTerminal,
  untilUnderWay,
  withSession,
} from "../testing/session-rig.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";

/**
 * Six ways for something to go wrong, and the one thing they have in common.
 *
 * Every fault below settles its Run. That is the property being checked, and
 * it is why they are one file rather than six: a runtime where five failure
 * paths settle and one hangs is a runtime that hangs, because the one that
 * hangs is the one that will happen at three in the morning.
 *
 * Each also has to leave the *other* Runs alone, so where it is meaningful the
 * test runs a second Run alongside the failing one and checks it finished
 * normally.
 */

test("a failing sink leaves the Run settled and the result readable", async () => {
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
        return {
          read: yield* rig.supervisor.result(run.runId),
          notifications: rig.sink.received().length,
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.equal(outcome.value.read.outcome, "result");
  assert.equal(outcome.value.notifications, 0);
  assert.equal(outcome.value.counters.deliveryFailures, 1);
  assert.equal(outcome.noLeaks, true);
});

test("a push that fails once and then lands does not disturb a second Run", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    deliveryRetryBudget: { attempts: 3, delayMillis: 1_000 },
  };
  const outcome = await withSession(
    {
      policy,
      testClock: true,
      steps: [[emitText("the first")], [emitText("the second")]],
    },
    (rig) =>
      Effect.gen(function* () {
        rig.sink.failNext(1);
        const first = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, first.runId);

        const resumed = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        if (resumed.outcome !== "started") throw new Error("resume refused");
        yield* untilTerminal(rig, resumed.runId);
        // The first Run's retry is waiting on the clock while the second one
        // settles and is announced.
        yield* TestClock.adjust(1_001);
        yield* quiesce();

        return {
          previews: rig.sink
            .received()
            .map((notice) => notice.preview)
            .sort(),
          first: (yield* rig.supervisor.result(first.runId)).outcome,
          second: (yield* rig.supervisor.result(resumed.runId)).outcome,
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.deepEqual(outcome.value.previews, ["the first", "the second"]);
  assert.equal(outcome.value.first, "result");
  assert.equal(outcome.value.second, "result");
  assert.equal(outcome.value.counters.deliveryFailures, 0);
  assert.equal(outcome.noLeaks, true);
});

test("a defect in one execution settles that Run and leaves the next one alone", async () => {
  const outcome = await withSession(
    {
      steps: [
        [emitText("got this far"), { step: "defect", message: "boom" }],
        [emitText("perfectly fine")],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, first.runId);
        const resumed = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        if (resumed.outcome !== "started") throw new Error("resume refused");
        yield* untilTerminal(rig, resumed.runId);
        yield* quiesce();
        return {
          first: yield* rig.supervisor.result(first.runId),
          second: yield* rig.supervisor.result(resumed.runId),
          notifications: rig.sink.received().length,
        };
      }),
  );

  assert.equal(outcome.value.first.outcome, "result");
  assert.equal(outcome.value.second.outcome, "result");
  if (
    outcome.value.first.outcome !== "result" ||
    outcome.value.second.outcome !== "result"
  ) {
    return;
  }
  assert.equal(outcome.value.first.result.status, "failed");
  assert.deepEqual(
    outcome.value.first.result.diagnostics.map(
      (diagnostic) => diagnostic.category,
    ),
    ["backend-failure"],
  );
  // The defect did not take the Subagent with it.
  assert.equal(outcome.value.second.result.status, "completed");
  assert.equal(outcome.value.notifications, 2);
  assert.equal(outcome.noLeaks, true);
});

test("a malformed observation is a diagnostic on its Run and nothing more", async () => {
  const outcome = await withSession(
    {
      steps: [
        [
          emitText("before"),
          {
            step: "emit",
            observation: {
              kind: "usage",
              usage: { input: 1, requestId: "r-1" },
            } as never,
          },
          emitText("after"),
        ],
      ],
    },
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
  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.category),
    ["backend-failure"],
  );
  // The reason names the offending key and never a value.
  assert.match(result.diagnostics[0].message, /requestId/);
  // The valid observations either side of it are intact, and the malformed
  // one contributed nothing.
  assert.equal(result.usage.totals.input, 0);
  assert.equal(result.finalOutput, "after");
  assert.equal(outcome.value.counters.seamDecodeFailures, 1);
  assert.equal(outcome.noLeaks, true);
});

test("a hung finalizer is escalated past, and the Session still closes cleanly", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    cleanupBudgetMillis: 2_000,
  };
  const outcome = await withSession(
    {
      policy,
      testClock: true,
      steps: [[{ step: "hang-in-finalizer" }, emitText("the answer")]],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        for (let step = 0; step < 20; step += 1) yield* Effect.yieldNow;
        yield* TestClock.adjust(policy.cleanupBudgetMillis + 1);
        yield* untilTerminal(rig, run.runId);
        yield* quiesce();
        return {
          read: yield* rig.supervisor.result(run.runId),
          snapshot: yield* rig.repository.get(run.runId),
          counters: rig.supervisor.counters(),
          notifications: rig.sink.received().length,
        };
      }),
  );

  assert.equal(outcome.value.read.outcome, "result");
  if (outcome.value.read.outcome !== "result") return;
  // Terminal, never stuck in `finalizing`, and honest about why.
  assert.notEqual(outcome.value.snapshot?.phase, "finalizing");
  assert.deepEqual(
    outcome.value.read.result.diagnostics.map(
      (diagnostic) => diagnostic.category,
    ),
    ["cleanup-escalation"],
  );
  assert.equal(outcome.value.counters.cleanupEscalations, 1);
  assert.equal(outcome.value.notifications, 1);
  assert.equal(outcome.noLeaks, true);
});

test("disposal escalates past an uninterruptible BackendAgent close", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    cleanupBudgetMillis: 2_000,
  };
  const closeGate = await Effect.runPromise(Deferred.make<void>());
  const hold = await Effect.runPromise(Deferred.make<void>());
  const trace: string[] = [];
  const outcome = await withSession(
    {
      policy,
      testClock: true,
      trace,
      gates: { close: closeGate, hold },
      close: { gate: "close", uninterruptible: true },
      steps: [[{ step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        startedRun(yield* rig.supervisor.start(request()));
        yield* untilUnderWay(rig);
        // This detached test-clock driver survives the body long enough to
        // advance disposal's cleanup budget. Releasing the gate afterwards
        // lets the deliberately detached loser finish instead of leaking into
        // another test.
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* until(
              "BackendAgent close to start",
              Effect.sync(() => trace.includes("agent-close-waiting")),
            );
            yield* TestClock.adjust(policy.cleanupBudgetMillis + 1);
            yield* quiesce();
            yield* Deferred.succeed(closeGate, undefined);
          }),
        );
        return {
          counters: rig.supervisor.counters,
          backend: rig.backend,
        };
      }),
  );

  assert.equal(outcome.value.counters().cleanupEscalations, 1);
  await Effect.runPromise(Deferred.succeed(closeGate, undefined));
  await Effect.runPromise(quiesce());
  assert.equal(outcome.value.backend.counters().closes, 1);
  assert.equal(outcome.noLeaks, true);
});

test("eight Subagents with hung cleanup close in one cleanup budget", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    cleanupBudgetMillis: 2_000,
  };
  const cleanup = await Effect.runPromise(Deferred.make<void>());
  const hold = await Effect.runPromise(Deferred.make<void>());
  const trace: string[] = [];
  const steps = Array.from({ length: 8 }, () => [
    { step: "gate-the-finalizer" as const, gate: "cleanup" },
    { step: "await-gate" as const, gate: "hold" },
  ]);
  const outcome = await withSession(
    {
      policy,
      testClock: true,
      trace,
      gates: { cleanup, hold },
      steps,
    },
    (rig) =>
      Effect.gen(function* () {
        for (let index = 0; index < 8; index += 1) {
          startedRun(yield* rig.supervisor.start(request()));
        }
        yield* until(
          "all executions to begin",
          Effect.sync(() => rig.backend.counters().executionsStarted === 8),
        );
        const shutting = yield* Effect.forkChild(rig.supervisor.shutdown());
        yield* until(
          "all execution finalizers to start",
          Effect.sync(
            () =>
              trace.filter((entry) => entry.startsWith("finalizer-waiting:"))
                .length === 8,
          ),
        );
        yield* TestClock.adjust(policy.cleanupBudgetMillis + 1);
        yield* quiesce();
        const completedWithinOneBudget = shutting.pollUnsafe() !== undefined;
        yield* Deferred.succeed(cleanup, undefined);
        yield* Fiber.join(shutting);
        return {
          completedWithinOneBudget,
          escalations: rig.supervisor.counters().cleanupEscalations,
        };
      }),
  );

  assert.equal(outcome.value.completedWithinOneBudget, true);
  assert.equal(outcome.value.escalations, 8);
  assert.equal(outcome.noLeaks, true);
});

test("a backend whose execute throws synchronously fails start instead of hanging", async () => {
  const outcome = await withSession(
    { executeThrowsSynchronously: true },
    (rig) =>
      Effect.gen(function* () {
        const started = yield* rig.supervisor.start(request());
        return {
          started,
          again: (yield* rig.supervisor.start(request())).outcome,
          published: (yield* rig.repository.list()).length,
          active: yield* rig.repository.activeCount(),
          accounted: yield* rig.store.accountedBytes(),
          backend: rig.backend.counters(),
        };
      }),
  );

  assert.deepEqual(outcome.value.started, {
    outcome: "backend unavailable",
    diagnostic: {
      category: "backend-failure",
      message: "the backend could not start execution",
    },
  });
  assert.equal(outcome.value.again, "backend unavailable");
  assert.equal(outcome.value.published, 0);
  assert.equal(outcome.value.active, 0);
  assert.equal(outcome.value.accounted, 0);
  assert.equal(outcome.value.backend.liveExecutions, 0);
  assert.equal(outcome.value.backend.liveSubscriptions, 0);
  assert.equal(outcome.value.backend.opens, 2);
  assert.equal(outcome.value.backend.closes, 2);
  assert.equal(outcome.noLeaks, true);
});

test("a synchronous execute throw after resume belongs to the admitted Run", async () => {
  const outcome = await withSession(
    {
      executeThrowsSynchronouslyAt: [1],
      steps: [[emitText("first")]],
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
        yield* untilTerminal(rig, resumed.runId);
        return yield* rig.supervisor.result(resumed.runId);
      }),
  );

  assert.equal(outcome.value.outcome, "result");
  if (outcome.value.outcome !== "result") return;
  assert.equal(outcome.value.result.status, "failed");
  assert.deepEqual(
    outcome.value.result.diagnostics.map((item) => item.category),
    ["backend-failure"],
  );
  assert.equal(outcome.noLeaks, true);
});

test("a failing open leaves the Session able to start the next Run", async () => {
  const outcome = await withSession(
    { open: { open: "fails", reason: "the provider said no" } },
    (rig) =>
      Effect.gen(function* () {
        const refused = yield* rig.supervisor.start(request());
        const again = yield* rig.supervisor.start(request());
        return {
          refused: refused.outcome,
          again: again.outcome,
          published: (yield* rig.repository.list()).length,
          accounted: yield* rig.store.accountedBytes(),
          notifications: rig.sink.received().length,
        };
      }),
  );

  assert.deepEqual(outcome.value, {
    refused: "backend unavailable",
    again: "backend unavailable",
    // Nothing was published, nothing stayed reserved, and nothing was
    // announced for work that never began.
    published: 0,
    accounted: 0,
    notifications: 0,
  });
  assert.equal(outcome.noLeaks, true);
});

test("an open that hangs past its budget is rejected, and the Session survives it", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    openBudgetMillis: 3_000,
  };
  const release = await Effect.runPromise(Deferred.make<void>());
  const outcome = await withSession(
    {
      policy,
      testClock: true,
      open: { open: "hangs", gate: "release" },
      gates: { release },
    },
    (rig) =>
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          rig.supervisor.start(request()),
        );
        yield* TestClock.adjust(policy.openBudgetMillis + 1);
        const refused = (yield* Fiber.join(starting)).outcome;
        return {
          refused,
          published: (yield* rig.repository.list()).length,
          opens: rig.backend.counters().opens,
        };
      }),
  );

  assert.equal(outcome.value.refused, "backend unavailable");
  assert.equal(outcome.value.published, 0);
  assert.equal(outcome.value.opens, 0);
  assert.equal(outcome.noLeaks, true);
});
