import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { runId as makeRunId, type RunId } from "../domain/index.ts";
import { createRuntimeCounters, type RuntimeCounters } from "./counters.ts";
import { makeWaiterLedger, type WaiterLedger } from "./waiters.ts";

/**
 * The waiter ledger, on its own.
 *
 * The property worth testing here is not the counting. It is **when the pin
 * goes**, because the pin is what stops eviction reaching a result before its
 * registered readers have had it, and every way a wait can end has to arrive
 * at the same answer. So each test below asks the same question — how many
 * times has the pin been released, and after which call — for a different
 * ending.
 */

const oneRun = makeRunId("run-1");
const otherRun = makeRunId("run-2");

function withLedger<A>(
  body: (
    ledger: WaiterLedger,
    released: RunId[],
    counters: RuntimeCounters,
  ) => Effect.Effect<A>,
): Promise<A> {
  const released: RunId[] = [];
  const counters = createRuntimeCounters();
  const ledger = makeWaiterLedger(
    {
      release: (runId) =>
        Effect.sync(() => {
          released.push(runId);
        }),
    },
    counters,
  );
  return Effect.runPromise(body(ledger, released, counters));
}

test("a Run nobody waited on releases its pin at settlement", async () => {
  const released = await withLedger((ledger, released) =>
    Effect.gen(function* () {
      yield* ledger.releaseIfIdle(oneRun);
      return [...released];
    }),
  );

  // Without this, a result would stay pinned for a reader who never arrives,
  // and eviction could never reach it.
  assert.deepEqual(released, [oneRun]);
});

test("settlement does not release the pin while a waiter holds a place", async () => {
  const outcome = await withLedger((ledger, released) =>
    Effect.gen(function* () {
      const release = ledger.register(oneRun);
      yield* ledger.releaseIfIdle(oneRun);
      const duringWait = [...released];
      yield* release;
      return { duringWait, afterWait: [...released] };
    }),
  );

  assert.deepEqual(outcome, { duringWait: [], afterWait: [oneRun] });
});

test("the pin goes when the last of several waiters lets go, not the first", async () => {
  const outcome = await withLedger((ledger, released) =>
    Effect.gen(function* () {
      const first = ledger.register(oneRun);
      const second = ledger.register(oneRun);
      const third = ledger.register(oneRun);
      yield* first;
      yield* second;
      const afterTwo = [...released];
      const stillWaiting = ledger.waiting(oneRun);
      yield* third;
      return { afterTwo, stillWaiting, afterThree: [...released] };
    }),
  );

  assert.deepEqual(outcome, {
    afterTwo: [],
    stillWaiting: 1,
    afterThree: [oneRun],
  });
});

test("a release run twice does not give up another waiter's place", async () => {
  const outcome = await withLedger((ledger, released) =>
    Effect.gen(function* () {
      const first = ledger.register(oneRun);
      const second = ledger.register(oneRun);
      yield* first;
      yield* first;
      yield* first;
      // Two places were taken and one was given up, so the pin is still held
      // — which is only true if a repeated release is a no-op rather than a
      // second decrement.
      const afterRepeats = [...released];
      const stillWaiting = ledger.waiting(oneRun);
      yield* second;
      return { afterRepeats, stillWaiting, afterSecond: [...released] };
    }),
  );

  assert.deepEqual(outcome, {
    afterRepeats: [],
    stillWaiting: 1,
    afterSecond: [oneRun],
  });
});

test("each Run's places are its own", async () => {
  const outcome = await withLedger((ledger, released) =>
    Effect.gen(function* () {
      const one = ledger.register(oneRun);
      ledger.register(otherRun);
      yield* one;
      return {
        released: [...released],
        oneRun: ledger.waiting(oneRun),
        otherRun: ledger.waiting(otherRun),
      };
    }),
  );

  assert.deepEqual(outcome, { released: [oneRun], oneRun: 0, otherRun: 1 });
});

test("the unresolved-waiter counter rises on register and falls on release", async () => {
  const outcome = await withLedger((ledger, _released, counters) =>
    Effect.gen(function* () {
      const release = ledger.register(oneRun);
      const duringWait = counters.probe().unresolvedWaiters;
      yield* release;
      yield* release;
      return { duringWait, afterWait: counters.probe().unresolvedWaiters };
    }),
  );

  // The probe is what the stress lane requires to end at zero, so a release
  // that ran twice must not take it negative any more than it may free a
  // place twice.
  assert.deepEqual(outcome, { duringWait: 1, afterWait: 0 });
});
