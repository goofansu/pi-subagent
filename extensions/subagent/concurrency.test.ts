/**
 * The concurrency cap: how many subagents may run at once, and what happens to
 * the ones waiting for a slot.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSubagentLimiter,
  MAX_CONCURRENT_SUBAGENTS,
  QueueAbortedError,
} from "./concurrency.ts";

/** Resolve after the microtask queue drains, so pending acquires can settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the default cap admits four subagents at once", () => {
  assert.equal(MAX_CONCURRENT_SUBAGENTS, 4);
});

test("a limiter admits up to its limit without waiting", async () => {
  const limiter = createSubagentLimiter(2);

  await limiter.acquire();
  await limiter.acquire();

  assert.equal(limiter.active(), 2);
  assert.equal(limiter.queued(), 0);
});

test("a limiter queues an acquire beyond its limit", async () => {
  const limiter = createSubagentLimiter(1);
  await limiter.acquire();

  let admitted = false;
  void limiter.acquire().then(() => {
    admitted = true;
  });
  await settle();

  assert.equal(admitted, false, "the second acquire must wait for a slot");
  assert.equal(limiter.queued(), 1);
  assert.equal(limiter.active(), 1);
});

test("releasing a slot admits the next waiter", async () => {
  const limiter = createSubagentLimiter(1);
  const release = await limiter.acquire();

  let admitted = false;
  void limiter.acquire().then(() => {
    admitted = true;
  });
  await settle();

  release();
  await settle();

  assert.equal(admitted, true);
  // The slot was handed over rather than freed and re-taken, so the count never
  // dips below the work actually in flight.
  assert.equal(limiter.active(), 1);
  assert.equal(limiter.queued(), 0);
});

test("waiters are admitted in the order they arrived", async () => {
  const limiter = createSubagentLimiter(1);
  const release = await limiter.acquire();

  const order: string[] = [];
  for (const name of ["first", "second", "third"]) {
    void limiter.acquire().then((next) => {
      order.push(name);
      next();
    });
  }
  await settle();

  release();
  await settle();

  assert.deepEqual(order, ["first", "second", "third"]);
});

test("releasing twice does not admit two waiters into one slot", async () => {
  const limiter = createSubagentLimiter(1);
  const release = await limiter.acquire();

  let admitted = 0;
  for (let i = 0; i < 2; i++) {
    void limiter.acquire().then(() => {
      admitted++;
    });
  }
  await settle();

  release();
  release();
  await settle();

  assert.equal(admitted, 1, "a repeated release must not over-admit");
  assert.equal(limiter.active(), 1);
});

test("an already-aborted acquire never takes a slot", async () => {
  const limiter = createSubagentLimiter(1);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => limiter.acquire(controller.signal),
    QueueAbortedError,
  );
  assert.equal(limiter.active(), 0);
});

test("a queued acquire gives up its place when cancelled", async () => {
  const limiter = createSubagentLimiter(1);
  const release = await limiter.acquire();
  const controller = new AbortController();

  const queued = limiter.acquire(controller.signal);
  await settle();
  assert.equal(limiter.queued(), 1);

  controller.abort();

  await assert.rejects(() => queued, QueueAbortedError);
  assert.equal(limiter.queued(), 0);

  // The cancelled waiter must not still be holding a claim on the slot.
  release();
  await settle();
  assert.equal(limiter.active(), 0);
});

test("cancelling one waiter still admits the next", async () => {
  const limiter = createSubagentLimiter(1);
  const release = await limiter.acquire();
  const controller = new AbortController();

  const cancelled = limiter.acquire(controller.signal);
  let admitted = false;
  void limiter.acquire().then(() => {
    admitted = true;
  });
  await settle();

  controller.abort();
  await assert.rejects(() => cancelled, QueueAbortedError);
  release();
  await settle();

  assert.equal(admitted, true);
});
