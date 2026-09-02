import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Deferred,
  Effect,
  Fiber,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  backendId,
  createRunProjection,
  runId as makeRunId,
  type RunIdentity,
  reduceRun,
  type SubagentId,
  subagentId,
} from "../domain/index.ts";
import { createRuntimeCounters } from "./counters.ts";
import { RunRepository } from "./repository.ts";

/**
 * The repository, on its own.
 *
 * Nothing here drives a Run: these are the properties the supervisor will
 * depend on, checked where they can be checked without concurrency. What a
 * subscriber sees, what happens to an illegal transition, and whether a spent
 * id can come back are all decidable from method calls.
 */

const identityOf = (subagent: SubagentId, run: string): RunIdentity => ({
  runId: makeRunId(run),
  subagentId: subagent,
  backendId: backendId("fake-resumable"),
  agent: "explore",
  description: "look around",
});

const withRepository = <A>(
  body: (
    repository: RunRepository["Service"],
  ) => Effect.Effect<A, never, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* RunRepository;
      return yield* body(repository);
    }).pipe(
      Effect.provide(RunRepository.layerOf(createRuntimeCounters())),
      Effect.scoped,
    ),
  );

test("an allocated identifier is spent the moment it is handed out", async () => {
  const spent = await withRepository((repository) =>
    Effect.gen(function* () {
      const first = yield* repository.allocateRunId();
      const second = yield* repository.allocateRunId();
      const subagent = yield* repository.allocateSubagentId();

      return {
        distinct: first !== second,
        firstSpent: yield* repository.isSpent(first),
        secondSpent: yield* repository.isSpent(second),
        subagentSpent: yield* repository.isSpent(subagent),
        strangerSpent: yield* repository.isSpent("run-999"),
      };
    }),
  );

  assert.deepEqual(spent, {
    distinct: true,
    firstSpent: true,
    secondSpent: true,
    subagentSpent: true,
    strangerSpent: false,
  });
});

test("an identifier allocated for a Run that was never published stays spent", async () => {
  // This is the failed-open case: the ids exist, nothing was published, and
  // the ids must never come back.
  const outcome = await withRepository((repository) =>
    Effect.gen(function* () {
      const abandoned = yield* repository.allocateRunId();
      return {
        spent: yield* repository.isSpent(abandoned),
        lookup: (yield* repository.lookup(abandoned)).state,
        active: yield* repository.activeCount(),
      };
    }),
  );

  // Spent, and yet unknown as a Run: no Run in this Session ever had it.
  assert.deepEqual(outcome, { spent: true, lookup: "unknown", active: 0 });
});

test("a published Run is active, and a settled one is terminal", async () => {
  const states = await withRepository((repository) =>
    Effect.gen(function* () {
      const subagent = yield* repository.allocateSubagentId();
      const identity = identityOf(subagent, "run-1");
      yield* repository.publish(identity, 1_000);

      const running = (yield* repository.lookup(identity.runId)).state;
      const activeWhileRunning = yield* repository.activeCount();
      yield* repository.transition(identity.runId, "execution-ended");
      const finalizing = yield* repository.get(identity.runId);
      yield* repository.transition(identity.runId, "settled-answered");
      const settled = yield* repository.lookup(identity.runId);
      const activeAfter = yield* repository.activeCount();

      return {
        running,
        activeWhileRunning,
        finalizingPhase: finalizing?.phase,
        settled: settled.state,
        terminalStatus:
          settled.state === "terminal"
            ? settled.snapshot.terminalStatus
            : undefined,
        activeAfter,
      };
    }),
  );

  assert.deepEqual(states, {
    running: "active",
    activeWhileRunning: 1,
    finalizingPhase: "finalizing",
    settled: "terminal",
    terminalStatus: "completed",
    activeAfter: 0,
  });
});

test("an illegal transition is reported, never thrown, and changes nothing", async () => {
  const outcome = await withRepository((repository) =>
    Effect.gen(function* () {
      const subagent = yield* repository.allocateSubagentId();
      const identity = identityOf(subagent, "run-1");
      yield* repository.publish(identity, 0);

      // Settling straight from running would skip cleanup, which is exactly
      // what `finalizing` exists to make impossible.
      const skipped = yield* repository.transition(
        identity.runId,
        "settled-answered",
      );
      const unchanged = yield* repository.get(identity.runId);
      const stranger = yield* repository.transition(
        makeRunId("run-never"),
        "execution-ended",
      );
      return { skipped, phase: unchanged?.phase, stranger };
    }),
  );

  assert.deepEqual(outcome, {
    skipped: { outcome: "illegal", phase: "running" },
    phase: "running",
    stranger: { outcome: "unknown Run" },
  });
});

test("the repository is the only writer, and a subscriber sees the latest value", async () => {
  const observed = await withRepository((repository) =>
    Effect.gen(function* () {
      const subagent = yield* repository.allocateSubagentId();
      const identity = identityOf(subagent, "run-1");

      const attached = yield* Deferred.make<void>();
      const subscriber = yield* SubscriptionRef.changes(repository.index).pipe(
        Stream.tap(() => Deferred.succeed(attached, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(attached);

      yield* repository.publish(identity, 0);
      const folded = reduceRun(createRunProjection(), {
        kind: "activity",
        activity: "reading files",
      }).projection;
      yield* repository.recordProjection(identity.runId, folded);

      const frames = yield* Fiber.join(subscriber);
      return frames.map((index) => index.get(identity.runId)?.activity ?? null);
    }),
  );

  // The empty index, the published Run with no activity, then the activity.
  assert.deepEqual(observed, [null, null, "reading files"]);
});

test("activity is conflated: a slow subscriber sees the newest value, not every value", async () => {
  const latest = await withRepository((repository) =>
    Effect.gen(function* () {
      const subagent = yield* repository.allocateSubagentId();
      const identity = identityOf(subagent, "run-1");
      yield* repository.publish(identity, 0);

      // Twenty activity updates with nobody reading between them. A queue
      // would hold twenty; a SubscriptionRef holds the latest.
      for (let step = 1; step <= 20; step += 1) {
        const folded = reduceRun(createRunProjection(), {
          kind: "activity",
          activity: `step ${step}`,
        }).projection;
        yield* repository.recordProjection(identity.runId, folded);
      }

      const index = yield* SubscriptionRef.get(repository.index);
      return index.get(identity.runId)?.activity;
    }),
  );

  assert.equal(latest, "step 20");
});

test("a settled Run is quiet: settlement clears the activity on the row", async () => {
  const activity = await withRepository((repository) =>
    Effect.gen(function* () {
      const subagent = yield* repository.allocateSubagentId();
      const identity = identityOf(subagent, "run-1");
      yield* repository.publish(identity, 0);
      yield* repository.recordProjection(
        identity.runId,
        reduceRun(createRunProjection(), {
          kind: "activity",
          activity: "still going",
        }).projection,
      );
      yield* repository.transition(identity.runId, "execution-ended");
      yield* repository.transition(identity.runId, "settled-cancelled");
      const snapshot = yield* repository.get(identity.runId);
      return snapshot?.activity;
    }),
  );

  assert.equal(activity, undefined);
});

test("recording a cancellation keeps the first reason and leaves the phase alone", async () => {
  const outcome = await withRepository((repository) =>
    Effect.gen(function* () {
      const subagent = yield* repository.allocateSubagentId();
      const identity = identityOf(subagent, "run-1");
      yield* repository.publish(identity, 0);

      const first = yield* repository.recordCancellation(
        identity.runId,
        "requested",
      );
      const second = yield* repository.recordCancellation(
        identity.runId,
        "shutdown",
      );
      const stillRunning = yield* repository.get(identity.runId);

      yield* repository.transition(identity.runId, "execution-ended");
      yield* repository.transition(identity.runId, "settled-cancelled");
      const afterSettlement = yield* repository.recordCancellation(
        identity.runId,
        "requested",
      );
      const unknown = yield* repository.recordCancellation(
        makeRunId("run-never"),
        "requested",
      );

      return {
        first,
        second,
        phase: stillRunning?.phase,
        recorded: stillRunning?.cancellation,
        afterSettlement,
        unknown,
      };
    }),
  );

  assert.deepEqual(outcome, {
    first: { outcome: "recorded", request: { reason: "requested" } },
    second: { outcome: "unchanged", request: { reason: "requested" } },
    // A cancellation is a *request*, not a phase change.
    phase: "running",
    recorded: { reason: "requested" },
    afterSettlement: { outcome: "already terminal", status: "cancelled" },
    unknown: { outcome: "unknown Run" },
  });
});

test("one Subagent's active Run is findable, and it has at most one", async () => {
  const found = await withRepository((repository) =>
    Effect.gen(function* () {
      const first = subagentId("subagent-a");
      const second = subagentId("subagent-b");
      yield* repository.publish(identityOf(first, "run-1"), 0);
      yield* repository.publish(identityOf(second, "run-2"), 0);

      const beforeSettling = yield* repository.activeRunOf(first);
      yield* repository.transition(makeRunId("run-1"), "execution-ended");
      yield* repository.transition(makeRunId("run-1"), "settled-answered");
      const afterSettling = yield* repository.activeRunOf(first);
      const other = yield* repository.activeRunOf(second);

      return {
        before: beforeSettling?.identity.runId,
        after: afterSettling,
        other: other?.identity.runId,
      };
    }),
  );

  assert.deepEqual(found, {
    before: "run-1",
    after: undefined,
    other: "run-2",
  });
});

test("a live view of the index is counted while it is held, and released after", async () => {
  const counters = createRuntimeCounters();
  const readings = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* RunRepository;
      const before = counters.probe().repositorySubscriptions;
      const held = yield* Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* repository.subscribe();
          void changes;
          return counters.probe().repositorySubscriptions;
        }),
      );
      return { before, held, after: counters.probe().repositorySubscriptions };
    }).pipe(Effect.provide(RunRepository.layerOf(counters)), Effect.scoped),
  );

  // A subscription that outlived its consumer is exactly the leak the probe
  // exists to catch, so it is counted rather than invisible.
  assert.deepEqual(readings, { before: 0, held: 1, after: 0 });
});
