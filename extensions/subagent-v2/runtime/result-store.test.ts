import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  backendId,
  EMPTY_TRUNCATION_RECORD,
  EMPTY_USAGE_SNAPSHOT,
  encodedResultBytes,
  runId as makeRunId,
  type RunId,
  type RunResult,
  runDiagnostic,
  subagentId,
} from "../domain/index.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";
import { PIN_HOLDERS, ResultStore } from "./result-store.ts";

/**
 * The store, on its own.
 *
 * Every property here is one the settlement path will lean on without being
 * able to check: idempotence, the byte budget, eviction order, and the pins.
 * Each is exercised with an explicit sequence of calls rather than through a
 * Run, so a failure names the rule rather than the interleaving.
 */

function resultOf(
  run: string,
  output: string,
  status = "completed",
): RunResult {
  return {
    runId: makeRunId(run),
    subagentId: subagentId("subagent-1"),
    backendId: backendId("fake-resumable"),
    agent: "explore",
    description: "look around",
    status: status as RunResult["status"],
    finalOutput: output,
    transcript: [
      { role: "assistant", parts: [{ kind: "text", text: output }] },
    ],
    tools: [],
    usage: EMPTY_USAGE_SNAPSHOT,
    diagnostics: [],
    links: [],
    startedAt: 0,
    settledAt: 1,
    truncation: EMPTY_TRUNCATION_RECORD,
  };
}

const withStore = <A>(
  policy: RuntimePolicy,
  body: (store: ResultStore["Service"]) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ResultStore;
      return yield* body(store);
    }).pipe(Effect.provide(ResultStore.layerOf(policy)), Effect.scoped),
  );

/** Free every pin, which is what a fully delivered Run does. */
const unpin = (store: ResultStore["Service"], run: RunId) =>
  Effect.forEach(PIN_HOLDERS, (holder) => store.releasePin(run, holder), {
    discard: true,
  });

test("a reservation is granted while the budget has room and refused after", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 1_000,
    resultStoreBytes: 2_500,
  };

  const outcome = await withStore(policy, (store) =>
    Effect.gen(function* () {
      const first = yield* store.reserve(makeRunId("run-1"));
      const second = yield* store.reserve(makeRunId("run-2"));
      const third = yield* store.reserve(makeRunId("run-3"));
      const accounted = yield* store.accountedBytes();
      // Releasing one makes room for the next, which is what a failed open
      // does with the reservation it took.
      yield* store.release(makeRunId("run-1"));
      const afterRelease = yield* store.reserve(makeRunId("run-3"));
      return { first, second, third, accounted, afterRelease };
    }),
  );

  assert.deepEqual(outcome, {
    first: true,
    second: true,
    third: false,
    accounted: 2_000,
    afterRelease: true,
  });
});

test("reserving the same Run twice takes the room once", async () => {
  const accounted = await withStore(DEFAULT_RUNTIME_POLICY, (store) =>
    Effect.gen(function* () {
      yield* store.reserve(makeRunId("run-1"));
      yield* store.reserve(makeRunId("run-1"));
      return yield* store.accountedBytes();
    }),
  );

  assert.equal(accounted, DEFAULT_RUNTIME_POLICY.maxResultBytes);
});

test("committing the same result twice stores one and counts a duplicate", async () => {
  const outcome = await withStore(DEFAULT_RUNTIME_POLICY, (store) =>
    Effect.gen(function* () {
      const result = resultOf("run-1", "the answer");
      yield* store.reserve(result.runId);
      const first = yield* store.commit(result);
      const second = yield* store.commit(result);
      const read = yield* store.read(result.runId);
      return {
        first: first.outcome,
        second: second.outcome,
        sameValue:
          second.outcome === "duplicate" &&
          second.result.finalOutput === "the answer",
        read:
          read.outcome === "result" ? read.result.finalOutput : read.outcome,
        counters: yield* store.counters(),
      };
    }),
  );

  assert.equal(outcome.first, "stored");
  assert.equal(outcome.second, "duplicate");
  assert.equal(outcome.sameValue, true);
  assert.equal(outcome.read, "the answer");
  assert.equal(outcome.counters.duplicateCommits, 1);
  assert.equal(outcome.counters.conflictingCommits, 0);
});

test("a different result under the same id leaves the first and records a defect", async () => {
  const outcome = await withStore(DEFAULT_RUNTIME_POLICY, (store) =>
    Effect.gen(function* () {
      yield* store.commit(resultOf("run-1", "the first answer"));
      const second = yield* store.commit(resultOf("run-1", "a second answer"));
      const read = yield* store.read(makeRunId("run-1"));
      return {
        second,
        stored: read.outcome === "result" ? read.result.finalOutput : undefined,
        counters: yield* store.counters(),
      };
    }),
  );

  assert.equal(outcome.second.outcome, "conflict");
  assert.equal(
    outcome.second.outcome === "conflict"
      ? outcome.second.result.finalOutput
      : undefined,
    "the first answer",
  );
  assert.match(
    outcome.second.outcome === "conflict"
      ? outcome.second.diagnostic.message
      : "",
    /a second, different result/,
  );
  // A settled Run's result is immutable, so the first one stands.
  assert.equal(outcome.stored, "the first answer");
  assert.equal(outcome.counters.conflictingCommits, 1);
});

test("a read decodes from the encoded form, so the round trip runs every time", async () => {
  const read = await withStore(DEFAULT_RUNTIME_POLICY, (store) =>
    Effect.gen(function* () {
      const result: RunResult = {
        ...resultOf("run-1", "the answer", "cancelled"),
        cancellationReason: "timeout",
        diagnostics: [runDiagnostic("backend-failure", "[redacted]")],
        model: "model-a",
      };
      yield* store.commit(result);
      const stored = yield* store.read(result.runId);
      return { stored, original: result };
    }),
  );

  assert.equal(read.stored.outcome, "result");
  if (read.stored.outcome === "result") {
    assert.deepEqual(read.stored.result, read.original);
  }
});

test("an unknown id and an evicted id get different answers", async () => {
  const one = resultOf("run-1", "x".repeat(400));
  const two = resultOf("run-2", "y".repeat(400));
  // Room for exactly one stored result and no reservations.
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 4_000,
    resultStoreBytes: encodedResultBytes(one) + 10,
  };

  const outcome = await withStore(policy, (store) =>
    Effect.gen(function* () {
      yield* store.commit(one);
      // Unpinning makes it eligible; committing the second forces the choice.
      yield* unpin(store, one.runId);
      yield* store.commit(two);

      return {
        evicted: yield* store.read(one.runId),
        newest: yield* store.read(two.runId),
        unknown: yield* store.read(makeRunId("run-never")),
        counters: yield* store.counters(),
      };
    }),
  );

  assert.deepEqual(outcome.evicted, {
    outcome: "ResultExpired",
    runId: "run-1",
    subagentId: "subagent-1",
    status: "completed",
  });
  assert.equal(outcome.newest.outcome, "result");
  assert.deepEqual(outcome.unknown, {
    outcome: "unknown Run",
    runId: "run-never",
  });
  assert.equal(outcome.counters.evictions, 1);
});

test("eviction takes the oldest unpinned output and never the newest", async () => {
  const results = [
    resultOf("run-1", "a".repeat(300)),
    resultOf("run-2", "b".repeat(300)),
    resultOf("run-3", "c".repeat(300)),
  ];
  const each = encodedResultBytes(results[0]);
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 4_000,
    // Room for two at a time.
    resultStoreBytes: each * 2 + 20,
  };

  const surviving = await withStore(policy, (store) =>
    Effect.gen(function* () {
      for (const result of results) {
        yield* store.commit(result);
        yield* unpin(store, result.runId);
      }
      const reads = yield* Effect.forEach(results, (result) =>
        store.read(result.runId),
      );
      return reads.map((read) => read.outcome);
    }),
  );

  // The oldest went; the two newest stayed.
  assert.deepEqual(surviving, ["ResultExpired", "result", "result"]);
});

test("a pinned result is not evicted, and a younger unpinned one goes instead", () => {
  // Deliberately the opposite of oldest-first, and the reason pins exist: the
  // oldest result is the one a waiter registered at settlement is about to
  // read, so eviction has to skip it and take the next eligible one.
  const results = [
    resultOf("run-1", "a".repeat(300)),
    resultOf("run-2", "b".repeat(300)),
    resultOf("run-3", "c".repeat(300)),
    resultOf("run-4", "d".repeat(300)),
  ];
  const each = encodedResultBytes(results[0]);
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 4_000,
    resultStoreBytes: each * 2 + 20,
  };

  return withStore(policy, (store) =>
    Effect.gen(function* () {
      yield* store.commit(results[0]);
      // Publication and delivery are done; the waiter registered at
      // settlement has not read yet, so one pin stays.
      yield* store.releasePin(results[0].runId, "publication");
      yield* store.releasePin(results[0].runId, "delivery");

      for (const result of results.slice(1, 3)) {
        yield* store.commit(result);
        yield* unpin(store, result.runId);
      }

      const held = yield* Effect.forEach(results.slice(0, 3), (result) =>
        store.read(result.runId),
      );
      const pins = yield* store.pinsOf(results[0].runId);

      // The waiter reads and lets go. The next commit now finds it eligible,
      // and being the oldest it is the one that goes.
      yield* store.releasePin(results[0].runId, "waiters");
      yield* store.commit(results[3]);
      yield* unpin(store, results[3].runId);
      const after = yield* Effect.forEach(results, (result) =>
        store.read(result.runId),
      );

      return {
        held: held.map((read) => read.outcome),
        pins,
        after: after.map((read) => read.outcome),
      };
    }),
  ).then((outcome) => {
    // The pinned oldest survived; the youngest unpinned one went instead.
    assert.deepEqual(outcome.held, ["result", "ResultExpired", "result"]);
    assert.deepEqual(outcome.pins, ["waiters"]);
    assert.deepEqual(outcome.after, [
      "ResultExpired",
      "ResultExpired",
      "result",
      "result",
    ]);
  });
});

test("a commit sets every pin, and each is released by name", async () => {
  const held = await withStore(DEFAULT_RUNTIME_POLICY, (store) =>
    Effect.gen(function* () {
      const result = resultOf("run-1", "the answer");
      yield* store.commit(result);
      const atCommit = yield* store.pinsOf(result.runId);
      yield* store.releasePin(result.runId, "publication");
      // Releasing the same holder twice frees one pin, not two.
      yield* store.releasePin(result.runId, "publication");
      const afterPublication = yield* store.pinsOf(result.runId);
      yield* store.releasePin(result.runId, "waiters");
      yield* store.releasePin(result.runId, "delivery");
      return {
        atCommit: [...atCommit].sort(),
        afterPublication: [...afterPublication].sort(),
        atEnd: yield* store.pinsOf(result.runId),
      };
    }),
  );

  assert.deepEqual(held, {
    atCommit: ["delivery", "publication", "waiters"],
    afterPublication: ["delivery", "waiters"],
    atEnd: [],
  });
});

test("reserved plus stored never exceeds the budget", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 2_000,
    resultStoreBytes: 6_000,
  };

  const readings = await withStore(policy, (store) =>
    Effect.gen(function* () {
      const seen: number[] = [];
      for (let index = 1; index <= 8; index += 1) {
        const run = makeRunId(`run-${index}`);
        const granted = yield* store.reserve(run);
        seen.push(yield* store.accountedBytes());
        if (!granted) continue;
        yield* store.commit(resultOf(`run-${index}`, "z".repeat(200)));
        yield* unpin(store, run);
        seen.push(yield* store.accountedBytes());
      }
      return seen;
    }),
  );

  for (const reading of readings) {
    assert.ok(reading <= 6_000, `accounted ${reading} exceeds the budget`);
  }
});

test("an oversized result is cut to fit its reservation and says so", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    maxResultBytes: 1_200,
    resultStoreBytes: 100_000,
  };

  const stored = await withStore(policy, (store) =>
    Effect.gen(function* () {
      const huge = resultOf("run-1", "w".repeat(50_000));
      yield* store.reserve(huge.runId);
      yield* store.commit(huge);
      const read = yield* store.read(huge.runId);
      return read;
    }),
  );

  assert.equal(stored.outcome, "result");
  if (stored.outcome !== "result") return;
  assert.ok(
    encodedResultBytes(stored.result) <= 1_200,
    `stored ${encodedResultBytes(stored.result)} bytes`,
  );
  // Bounded, and honest about it.
  assert.ok(stored.result.truncation.truncatedOutputBytes > 0);
  assert.ok(stored.result.truncation.droppedTranscriptItems > 0);
  // Identity survives whatever else went.
  assert.equal(stored.result.runId, "run-1");
  assert.equal(stored.result.status, "completed");
});

test("clearing forgets everything, which is what shutdown does", async () => {
  const after = await withStore(DEFAULT_RUNTIME_POLICY, (store) =>
    Effect.gen(function* () {
      yield* store.commit(resultOf("run-1", "the answer"));
      yield* store.reserve(makeRunId("run-2"));
      yield* store.clear();
      return {
        read: (yield* store.read(makeRunId("run-1"))).outcome,
        stored: yield* store.stored(),
        accounted: yield* store.accountedBytes(),
      };
    }),
  );

  assert.deepEqual(after, { read: "unknown Run", stored: [], accounted: 0 });
});
