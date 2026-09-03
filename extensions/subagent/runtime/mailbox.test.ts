import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import type { RunControl } from "../backend/contract.ts";
import { createRuntimeCounters } from "./counters.ts";
import { type ControlMailbox, makeMailbox } from "./mailbox.ts";
import { type ControlBounds, DEFAULT_CONTROL_BOUNDS } from "./policy.ts";

/**
 * The mailbox, on its own.
 *
 * Every outcome here is one a caller can observe from `agent_steer`, so each
 * one is checked against the exact condition operation semantics section 7
 * gives for it — the bound that was hit, rather than "something was full".
 */

const steer = (text: string): RunControl => ({ type: "steer", text });

const withMailbox = <A>(
  bounds: ControlBounds,
  body: (mailbox: ControlMailbox) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* makeMailbox(bounds, createRuntimeCounters());
      return yield* body(mailbox);
    }).pipe(Effect.scoped),
  );

test("sixteen Controls are accepted and the seventeenth is full, immediately", async () => {
  const outcomes = await withMailbox(DEFAULT_CONTROL_BOUNDS, (mailbox) =>
    Effect.gen(function* () {
      const admitted: string[] = [];
      for (let index = 1; index <= 17; index += 1) {
        admitted.push(yield* mailbox.admit(steer(`control ${index}`)));
      }
      return { admitted, pending: mailbox.pending() };
    }),
  );

  assert.equal(
    outcomes.admitted.filter((outcome) => outcome === "accepted").length,
    16,
  );
  assert.equal(outcomes.admitted[16], "mailbox full");
  assert.equal(outcomes.pending, 16);
});

test("an oversized message is invalid, and so is empty or whitespace-only text", async () => {
  const outcomes = await withMailbox(DEFAULT_CONTROL_BOUNDS, (mailbox) =>
    Effect.gen(function* () {
      return {
        oversized: yield* mailbox.admit(
          steer("x".repeat(DEFAULT_CONTROL_BOUNDS.maxMessageBytes + 1)),
        ),
        exact: yield* mailbox.admit(
          steer("y".repeat(DEFAULT_CONTROL_BOUNDS.maxMessageBytes)),
        ),
        empty: yield* mailbox.admit(steer("")),
        blank: yield* mailbox.admit(steer("   \n  ")),
      };
    }),
  );

  assert.deepEqual(outcomes, {
    oversized: "invalid",
    // Exactly at the bound is inside it.
    exact: "accepted",
    empty: "invalid",
    blank: "invalid",
  });
});

test("the total pending byte bound is a third axis, not a restatement of the count", async () => {
  // Room for four by count, but only three by bytes.
  const bounds: ControlBounds = {
    maxPending: 4,
    maxMessageBytes: 100,
    maxPendingBytes: 30,
  };

  const outcomes = await withMailbox(bounds, (mailbox) =>
    Effect.gen(function* () {
      const admitted = [
        yield* mailbox.admit(steer("a".repeat(10))),
        yield* mailbox.admit(steer("b".repeat(10))),
        yield* mailbox.admit(steer("c".repeat(10))),
        yield* mailbox.admit(steer("d".repeat(10))),
      ];
      // Taking one releases its bytes, so the fourth fits afterwards.
      const taken = yield* mailbox.feed.take;
      const afterTake = yield* mailbox.admit(steer("d".repeat(10)));
      return { admitted, taken: taken?.text, afterTake };
    }),
  );

  assert.deepEqual(outcomes.admitted, [
    "accepted",
    "accepted",
    "accepted",
    "mailbox full",
  ]);
  assert.equal(outcomes.taken, "a".repeat(10));
  assert.equal(outcomes.afterTake, "accepted");
});

test("Controls are delivered serially, in admission order", async () => {
  const order = await withMailbox(DEFAULT_CONTROL_BOUNDS, (mailbox) =>
    Effect.gen(function* () {
      for (const text of ["first", "second", "third"]) {
        yield* mailbox.admit(steer(text));
      }
      const taken: (string | undefined)[] = [];
      for (let index = 0; index < 3; index += 1) {
        taken.push((yield* mailbox.feed.take)?.text);
      }
      return taken;
    }),
  );

  assert.deepEqual(order, ["first", "second", "third"]);
});

test("a take waits for the next Control rather than reporting an empty mailbox", async () => {
  const outcome = await withMailbox(DEFAULT_CONTROL_BOUNDS, (mailbox) =>
    Effect.gen(function* () {
      // `undefined` means closed and drained. An empty *open* mailbox is not
      // that, so the adapter waits rather than being told the Run is over.
      const taking = yield* Effect.forkChild(mailbox.feed.take);
      yield* Effect.yieldNow;
      yield* mailbox.admit(steer("arrived later"));
      return (yield* Fiber.join(taking))?.text;
    }),
  );

  assert.equal(outcome, "arrived later");
});

test("closing discards what was admitted and never sent", async () => {
  const outcome = await withMailbox(DEFAULT_CONTROL_BOUNDS, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.admit(steer("never delivered"));
      yield* mailbox.admit(steer("also never delivered"));
      yield* mailbox.close();
      return {
        afterClose: yield* mailbox.admit(steer("too late")),
        // Closed and drained: the adapter learns there is nothing more.
        taken: yield* mailbox.feed.take,
        closed: mailbox.isClosed(),
      };
    }),
  );

  assert.deepEqual(outcome, {
    afterClose: "mailbox closed",
    taken: undefined,
    closed: true,
  });
});

test("closing twice is a no-op, because settlement may reach it twice", async () => {
  const outcome = await withMailbox(DEFAULT_CONTROL_BOUNDS, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.close();
      yield* mailbox.close();
      return mailbox.isClosed();
    }),
  );

  assert.equal(outcome, true);
});

test("a waiting take is released when the mailbox closes", async () => {
  const outcome = await withMailbox(DEFAULT_CONTROL_BOUNDS, (mailbox) =>
    Effect.gen(function* () {
      const taking = yield* Effect.forkChild(mailbox.feed.take);
      yield* Effect.yieldNow;
      yield* mailbox.close();
      return yield* Fiber.join(taking);
    }),
  );

  // An adapter blocked on `take` when its Run is cancelled must not block
  // forever: closing is what tells it the feed is drained.
  assert.equal(outcome, undefined);
});
