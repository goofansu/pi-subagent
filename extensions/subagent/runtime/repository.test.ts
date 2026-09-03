import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Deferred,
  Effect,
  Fiber,
  Random,
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
import { parseAllocatedId } from "../testing/identifiers.ts";
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

/**
 * One repository, which is one Session's identity space.
 *
 * `seed` pins the pseudo-random sequence the Session nonce is drawn from, for
 * the tests that compare the identifiers of two Sessions. Those tests are
 * about whether two Sessions share an identity space at all; leaving the draw
 * unseeded would make them pass by luck rather than by rule, and fail once in
 * every 36⁴ runs for a reason that has nothing to do with the code. The
 * remaining tests take the real unseeded draw.
 */
const withRepository = <A>(
  body: (
    repository: RunRepository["Service"],
  ) => Effect.Effect<A, never, Scope.Scope>,
  seed?: string,
): Promise<A> => {
  const program = Effect.gen(function* () {
    const repository = yield* RunRepository;
    return yield* body(repository);
  }).pipe(
    Effect.provide(RunRepository.layerOf(createRuntimeCounters())),
    Effect.scoped,
  );
  return Effect.runPromise(
    seed === undefined ? program : program.pipe(Random.withSeed(seed)),
  );
};

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

/** What one Session runtime allocates, in the order `start` and `resume` do. */
const allocateInOneSession = (
  seed?: string,
): Promise<{
  readonly subagent: string;
  readonly first: string;
  readonly second: string;
  readonly nextSubagent: string;
  readonly third: string;
}> =>
  withRepository(
    (repository) =>
      Effect.gen(function* () {
        // The order `start` allocates in: the Subagent first, then its Run.
        const subagent = yield* repository.allocateSubagentId();
        const first = yield* repository.allocateRunId();
        // A resume allocates a Run and no Subagent.
        const second = yield* repository.allocateRunId();
        const nextSubagent = yield* repository.allocateSubagentId();
        const third = yield* repository.allocateRunId();
        return { subagent, first, second, nextSubagent, third };
      }),
    seed,
  );

test("each kind of identity is numbered from one, independently of the other", async () => {
  const ids = await allocateInOneSession();

  const numbering = (id: string): string => {
    const { kind, sequence } = parseAllocatedId(id);
    return `${kind} ${sequence}`;
  };

  // One shared counter would make the first Run the second number and leave
  // holes wherever a Subagent was created — which is what a user sees, and the
  // first thing they ask about.
  assert.deepEqual(
    {
      subagent: numbering(ids.subagent),
      first: numbering(ids.first),
      second: numbering(ids.second),
      nextSubagent: numbering(ids.nextSubagent),
      third: numbering(ids.third),
    },
    {
      subagent: "subagent 1",
      first: "run 1",
      second: "run 2",
      nextSubagent: "subagent 2",
      third: "run 3",
    },
  );
});

test("one Session mints one nonce, and both kinds of identity carry it", async () => {
  const ids = await allocateInOneSession();
  const sessions = Object.values(ids).map((id) => parseAllocatedId(id).session);

  // A Session's ids read as a set: the same nonce on the Subagent and on
  // every Run it starts, so a reader can tell at a glance which belong
  // together.
  assert.equal(new Set(sessions).size, 1);
});

test("an identifier minted in one Session is never minted in another", async () => {
  // Two Session runtimes, exactly as a reload produces: the second knows
  // nothing of the first, and its sequence starts again at one. The transcript
  // that survives the reload, however, still holds the first Session's ids —
  // so if the two Sessions minted the same strings, a stale reference would
  // silently resolve to a different Run instead of being reported as unknown.
  const before = await allocateInOneSession("a Session");
  const after = await allocateInOneSession("the Session after a reload");

  const mintedBefore = new Set<string>(Object.values(before));
  const overlap = Object.values(after).filter((id) => mintedBefore.has(id));

  assert.deepEqual(overlap, []);
  // And the numbering within each Session is untouched by that: staying
  // readable is the whole reason for a nonce rather than a random id per Run.
  assert.equal(parseAllocatedId(after.first).sequence, 1);
});

test("a forgotten Session's identifiers are never minted again", async () => {
  // `forget` ends a Session's identity sets at shutdown. The ids that Session
  // handed out are still in the conversation, so what comes after must not
  // repeat them — the same hazard as a reload, inside one process.
  const ids = await withRepository(
    (repository) =>
      Effect.gen(function* () {
        const before = yield* repository.allocateRunId();
        yield* repository.forget();
        const after = yield* repository.allocateRunId();
        return { before, after };
      }),
    "a Session and its successor",
  );

  assert.notEqual(ids.after, ids.before);
  assert.notEqual(
    parseAllocatedId(ids.after).session,
    parseAllocatedId(ids.before).session,
  );
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

test("the repository is the only writer, and a subscriber sees each change", async () => {
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

test("activity is conflated in the row: twenty updates leave one value", async () => {
  const latest = await withRepository((repository) =>
    Effect.gen(function* () {
      const subagent = yield* repository.allocateSubagentId();
      const identity = identityOf(subagent, "run-1");
      yield* repository.publish(identity, 0);

      // Twenty activity updates with nobody reading between them. The row is
      // one value, replaced each time, so a chatty backend grows the index by
      // nothing — which is the conflation the projection rule gives, and is a
      // different thing from what the change stream delivers.
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
