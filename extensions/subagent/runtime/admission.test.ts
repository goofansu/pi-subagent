import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  runId as makeRunId,
  subagentId as makeSubagentId,
  type RunId,
} from "../domain/index.ts";
import {
  type AdmissionLease,
  type AdmissionOutcome,
  makeAdmission,
  type ResultReservations,
  type RunAdmission,
} from "./admission.ts";

/**
 * Admission, on its own.
 *
 * The supervisor used to hold this state and enforce these rules at five call
 * sites, so the properties below were only ever observable through a Run.
 * Here each one is exercised with an explicit sequence of calls against no
 * provider at all, which is what lets a failure name the rule rather than the
 * interleaving that exposed it.
 *
 * Two of them are the reason the module exists. **One lease per slot** is the
 * linearization property the supervisor's `Ref.modify` provided and this
 * module now owns. **A release that cannot happen twice** is what replaced a
 * capacity counter clamped at zero: the test for it is not that a second
 * release is quiet, but that a second release cannot raise the effective
 * capacity, because a negative count would let more Runs in than the policy
 * allows for the rest of the Session.
 */

const oneSubagent = makeSubagentId("subagent-1");
const otherSubagent = makeSubagentId("subagent-2");
const oneRun = makeRunId("run-1");

/**
 * A stand-in for the two calls admission makes on the Result store.
 *
 * Narrower than the store on purpose: admission needs to know that there is
 * room for a result and how to give that room back, and nothing else about
 * how results are stored. Recording both calls is what lets the tests below
 * assert that a lease released exactly the reservation it was holding.
 */
function reservations(grant = true): {
  readonly api: ResultReservations;
  readonly reserved: RunId[];
  readonly released: RunId[];
} {
  const reserved: RunId[] = [];
  const released: RunId[] = [];
  return {
    reserved,
    released,
    api: {
      reserve: (runId) =>
        Effect.sync(() => {
          reserved.push(runId);
          return grant;
        }),
      release: (runId) =>
        Effect.sync(() => {
          released.push(runId);
        }),
    },
  };
}

const withAdmission = <A>(
  maxActiveRuns: number,
  store: ResultReservations,
  body: (admission: RunAdmission) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(makeAdmission(maxActiveRuns, store), (admission) =>
      body(admission),
    ),
  );

/** The lease an admitted acquire produced, or a failure naming what came back. */
function leaseOf(outcome: AdmissionOutcome): AdmissionLease {
  if (outcome.outcome !== "admitted") {
    throw new Error(`expected a lease, got '${outcome.outcome}'`);
  }
  return outcome.lease;
}

test("two concurrent acquires against a capacity of one yield exactly one lease", async () => {
  const store = reservations();
  const outcomes = await withAdmission(1, store.api, (admission) =>
    Effect.all([admission.acquire(), admission.acquire()], {
      concurrency: "unbounded",
    }),
  );

  // Which of the two wins is not decided by anything and is not asserted.
  // That exactly one wins is the whole property: both fibers reach the same
  // atomic step, and the loser sees the winner's claim rather than the value
  // they both started from.
  assert.equal(
    outcomes.filter((outcome) => outcome.outcome === "admitted").length,
    1,
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.outcome === "at capacity").length,
    1,
  );
});

test("a resume acquire on a Subagent that is already running is refused, and spends no capacity", async () => {
  const store = reservations();
  const outcomes = await withAdmission(2, store.api, (admission) =>
    Effect.gen(function* () {
      const first = yield* admission.acquire(oneSubagent);
      const second = yield* admission.acquire(oneSubagent);
      // The refusal must not have taken the second slot: another Subagent can
      // still be admitted into it.
      const other = yield* admission.acquire(otherSubagent);
      return [first.outcome, second.outcome, other.outcome];
    }),
  );

  assert.deepEqual(outcomes, ["admitted", "already running", "admitted"]);
});

test("shutting down is answered before already running and before capacity", async () => {
  const store = reservations();
  const outcomes = await withAdmission(1, store.api, (admission) =>
    Effect.gen(function* () {
      yield* admission.acquire(oneSubagent);
      yield* admission.beginShutdown();
      // At capacity *and* running *and* shutting down. Only one of those is
      // worth telling a caller, and it is the one that will not change.
      return [
        (yield* admission.acquire(oneSubagent)).outcome,
        (yield* admission.acquire()).outcome,
      ];
    }),
  );

  assert.deepEqual(outcomes, ["shutting down", "shutting down"]);
});

test("a refused result reservation releases the lease, so its slot comes back", async () => {
  const store = reservations(false);
  const outcome = await withAdmission(1, store.api, (admission) =>
    Effect.gen(function* () {
      const lease = leaseOf(yield* admission.acquire());
      return {
        reserved: yield* lease.reserveResult(oneRun),
        // The refusal compensated itself. Nothing outside admission had to
        // remember that a capacity slot was taken before the reservation was
        // asked for.
        next: (yield* admission.acquire()).outcome,
      };
    }),
  );

  assert.deepEqual(outcome, { reserved: false, next: "admitted" });
  assert.deepEqual(store.reserved, [oneRun]);
  // A refused reservation is not a reservation, so releasing one would be
  // asking the store about room it never gave.
  assert.deepEqual(store.released, []);
});

test("a lease releases the result reservation it is still holding, exactly once", async () => {
  const store = reservations();
  const outcome = await withAdmission(1, store.api, (admission) =>
    Effect.gen(function* () {
      const lease = leaseOf(yield* admission.acquire());
      const reserved = yield* lease.reserveResult(oneRun);
      yield* lease.release();
      yield* lease.release();
      return reserved;
    }),
  );

  assert.equal(outcome, true);
  assert.deepEqual(store.reserved, [oneRun]);
  assert.deepEqual(store.released, [oneRun]);
});

test("a second release cannot raise the effective capacity", async () => {
  const store = reservations();
  const outcomes = await withAdmission(1, store.api, (admission) =>
    Effect.gen(function* () {
      const lease = leaseOf(yield* admission.acquire());
      yield* lease.release();
      yield* lease.release();
      yield* lease.release();
      // This is the property the counter's clamp was defending. A count that
      // went negative would permanently *raise* the capacity, and no test of
      // "is a second release quiet" would notice.
      return [
        (yield* admission.acquire()).outcome,
        (yield* admission.acquire()).outcome,
      ];
    }),
  );

  assert.deepEqual(outcomes, ["admitted", "at capacity"]);
});

test("a bound Subagent leaves the running set when its lease is released", async () => {
  const store = reservations();
  const outcomes = await withAdmission(2, store.api, (admission) =>
    Effect.gen(function* () {
      // A start's shape: the acquire knows no Subagent, because until the
      // backend opened there was none.
      const lease = leaseOf(yield* admission.acquire());
      yield* lease.bind(oneSubagent);
      const whileRunning = yield* admission.acquire(oneSubagent);
      yield* lease.release();
      const afterRelease = yield* admission.acquire(oneSubagent);
      return [whileRunning.outcome, afterRelease.outcome];
    }),
  );

  assert.deepEqual(outcomes, ["already running", "admitted"]);
});

test("beginShutdown is true for the first caller only, and every later acquire is refused", async () => {
  const store = reservations();
  const outcome = await withAdmission(4, store.api, (admission) =>
    Effect.gen(function* () {
      const before = yield* admission.isShuttingDown();
      const first = yield* admission.beginShutdown();
      const second = yield* admission.beginShutdown();
      return {
        before,
        first,
        second,
        after: yield* admission.isShuttingDown(),
        start: (yield* admission.acquire()).outcome,
        resume: (yield* admission.acquire(oneSubagent)).outcome,
      };
    }),
  );

  assert.deepEqual(outcome, {
    before: false,
    // One observable instant: the caller that gets `true` is the one that runs
    // the shutdown, and the second is idempotent rather than a second attempt.
    first: true,
    second: false,
    after: true,
    start: "shutting down",
    resume: "shutting down",
  });
});
