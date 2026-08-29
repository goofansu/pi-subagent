import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_MAX_PENDING,
  CONTROL_MAX_PENDING_BYTES,
  createControlGate,
  createControlMailbox,
} from "./control-mailbox.ts";
import type { RunControl } from "./run.ts";

const steer = (text: string): RunControl => ({ type: "steer", text });

test("the Control mailbox preserves admitted text in FIFO order for its one consumer", async () => {
  const mailbox = createControlMailbox();
  const controls = mailbox[Symbol.asyncIterator]();

  assert.equal(mailbox.offer(steer("  first \n")), "accepted");
  assert.equal(mailbox.offer(steer("second")), "accepted");
  assert.deepEqual(await controls.next(), {
    done: false,
    value: steer("  first \n"),
  });
  assert.deepEqual(await controls.next(), {
    done: false,
    value: steer("second"),
  });
  assert.throws(() => mailbox[Symbol.asyncIterator](), /one consumer/);
});

test("the Control mailbox enforces UTF-8 message, count, and total pending budgets", () => {
  const perMessage = createControlMailbox();
  assert.equal(
    perMessage.offer(steer("🙂".repeat(CONTROL_MAX_MESSAGE_BYTES / 4))),
    "accepted",
  );
  assert.equal(
    perMessage.offer(steer(`${"x".repeat(CONTROL_MAX_MESSAGE_BYTES - 3)}🙂`)),
    "invalid",
  );

  const byCount = createControlMailbox();
  for (let index = 0; index < CONTROL_MAX_PENDING; index++) {
    assert.equal(byCount.offer(steer("x")), "accepted");
  }
  assert.equal(byCount.offer(steer("overflow")), "queue full");

  const byBytes = createControlMailbox();
  for (
    let index = 0;
    index < CONTROL_MAX_PENDING_BYTES / CONTROL_MAX_MESSAGE_BYTES;
    index++
  ) {
    assert.equal(
      byBytes.offer(steer("x".repeat(CONTROL_MAX_MESSAGE_BYTES))),
      "accepted",
    );
  }
  assert.equal(byBytes.offer(steer("overflow")), "queue full");
});

test("the Control mailbox rejects whitespace-only steering", () => {
  const mailbox = createControlMailbox();

  assert.equal(mailbox.offer(steer(" \t\n\r")), "invalid");
});

test("dequeueing releases pending count and UTF-8 byte capacity", async () => {
  const byCount = createControlMailbox();
  for (let index = 0; index < CONTROL_MAX_PENDING; index++) {
    assert.equal(byCount.offer(steer("x")), "accepted");
  }
  assert.equal(byCount.offer(steer("blocked")), "queue full");
  await byCount[Symbol.asyncIterator]().next();
  assert.equal(byCount.offer(steer("now admitted")), "accepted");

  const byBytes = createControlMailbox();
  const fullMessage = "🙂".repeat(CONTROL_MAX_MESSAGE_BYTES / 4);
  for (
    let index = 0;
    index < CONTROL_MAX_PENDING_BYTES / CONTROL_MAX_MESSAGE_BYTES;
    index++
  ) {
    assert.equal(byBytes.offer(steer(fullMessage)), "accepted");
  }
  assert.equal(byBytes.offer(steer("blocked")), "queue full");
  await byBytes[Symbol.asyncIterator]().next();
  assert.equal(byBytes.offer(steer("now admitted")), "accepted");
});

test("closing drops queued Controls, wakes the consumer as done, and refuses later admission", async () => {
  const queued = createControlMailbox();
  assert.equal(queued.offer(steer("discard me")), "accepted");
  const queuedControls = queued[Symbol.asyncIterator]();
  queued.close();
  assert.deepEqual(await queuedControls.next(), {
    done: true,
    value: undefined,
  });
  assert.equal(queued.offer(steer("too late")), "closed");

  const waiting = createControlMailbox();
  const waitingControls = waiting[Symbol.asyncIterator]();
  const next = waitingControls.next();
  waiting.close();
  assert.deepEqual(await next, { done: true, value: undefined });
});

test("the Control gate distinguishes unsupported, closed, and cancelling Runs without a queue for unsupported Runs", async () => {
  const unsupported = createControlGate([]);
  assert.deepEqual(unsupported.state(), {
    supportedControls: [],
    closed: false,
    cancellationReason: undefined,
  });
  assert.equal(unsupported.offer(steer("guidance")), "unsupported");
  assert.deepEqual(await unsupported.controls[Symbol.asyncIterator]().next(), {
    done: true,
    value: undefined,
  });

  unsupported.cancel("requested");
  assert.equal(unsupported.offer(steer("after cancellation")), "not steerable");
  assert.deepEqual(unsupported.state(), {
    supportedControls: [],
    closed: true,
    cancellationReason: "requested",
  });

  const closedUnsupported = createControlGate([]);
  closedUnsupported.close();
  assert.equal(closedUnsupported.offer(steer("after close")), "not steerable");

  const supported = createControlGate(["steer"]);
  supported.close();
  assert.equal(supported.offer(steer("after close")), "not steerable");
});
