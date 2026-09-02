import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";

/**
 * The M0 Effect compatibility smoke test.
 *
 * It proves the toolchain, not Effect semantics: that the pinned Effect
 * release compiles under this repository's `NodeNext`/`ES2022`/strict
 * TypeScript settings and runs under `node --test` with the `tsx` loader. M1
 * and M2 build the real supervisor on exactly these primitives, so a
 * toolchain problem has to surface here rather than inside the first real
 * lifecycle module.
 */

/** A session-long service, the only thing v2 will ever express as a Layer. */
class Ledger extends Context.Service<
  Ledger,
  {
    readonly record: (entry: string) => Effect.Effect<void>;
    readonly entries: Effect.Effect<ReadonlyArray<string>>;
  }
>()("pi-subagent-v2/smoke/Ledger") {
  static readonly layer = Layer.effect(
    Ledger,
    Effect.sync(() => {
      const entries: string[] = [];
      return Ledger.of({
        record: (entry: string) => Effect.sync(() => void entries.push(entry)),
        entries: Effect.sync(() => [...entries]),
      });
    }),
  );
}

test("a scoped resource is acquired and released by its scope", async () => {
  const events: string[] = [];

  const released = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const value = yield* Effect.acquireRelease(
        Effect.sync(() => {
          events.push("acquired");
          return "native-handle";
        }),
        () => Effect.sync(() => void events.push("released")),
      ).pipe(Scope.provide(scope));

      events.push(`used:${value}`);
      yield* Scope.close(scope, Exit.void);
      return events;
    }),
  );

  assert.deepEqual(released, ["acquired", "used:native-handle", "released"]);
});

test("a deferred is completed by a forked fiber and awaited by its parent", async () => {
  const settled = await Effect.runPromise(
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<string>();
      const fiber = yield* Effect.forkChild(
        Deferred.succeed(deferred, "answered"),
      );
      const value = yield* Deferred.await(deferred);
      yield* Fiber.join(fiber);
      return value;
    }).pipe(Effect.scoped),
  );

  assert.equal(settled, "answered");
});

test("a bounded queue carries messages between fibers", async () => {
  const taken = await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<string>(2);
      const producer = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Queue.offer(queue, "first");
          yield* Queue.offer(queue, "second");
        }),
      );
      const first = yield* Queue.take(queue);
      const second = yield* Queue.take(queue);
      yield* Fiber.join(producer);
      return [first, second];
    }).pipe(Effect.scoped),
  );

  assert.deepEqual(taken, ["first", "second"]);
});

test("a subscription ref publishes its changes to a subscriber", async () => {
  const observed = await Effect.runPromise(
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make("idle");
      const subscribed = yield* Deferred.make<void>();
      // The subscriber must be attached before the first change, or it
      // observes only the value the stream replays.
      const subscriber = yield* SubscriptionRef.changes(ref).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(subscribed);
      yield* SubscriptionRef.set(ref, "running");
      yield* SubscriptionRef.set(ref, "answered");
      return yield* Fiber.join(subscriber);
    }).pipe(Effect.scoped),
  );

  assert.deepEqual(observed, ["idle", "running", "answered"]);
});

test("a test clock advances a sleeping fiber without real time passing", async () => {
  const startedAt = Date.now();

  const woke = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.sleep("1 hour").pipe(Effect.as("woke" as const)),
      );
      yield* TestClock.adjust("1 hour");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  assert.equal(woke, "woke");
  assert.ok(Date.now() - startedAt < 60_000);
});

test("a session-long service is provided through a layer", async () => {
  const entries = await Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      yield* ledger.record("session-start");
      yield* ledger.record("session-shutdown");
      return yield* ledger.entries;
    }).pipe(Effect.provide(Ledger.layer)),
  );

  assert.deepEqual(entries, ["session-start", "session-shutdown"]);
});
