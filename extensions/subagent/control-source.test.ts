import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_MAX_PENDING,
  CONTROL_MAX_PENDING_BYTES,
  type ControlAdmission,
  createControlGate,
  createControlSource,
} from "./control-source.ts";
import type { RunControl } from "./run.ts";

const steer = (text: string): RunControl => ({ type: "steer", text });

test("a successful Control offer synchronously reaches its subscriber before returning", () => {
  const source = createControlSource();
  const occurrences: string[] = [];
  source.controls.subscribe((admission) => {
    occurrences.push(`admitted: ${admission.control.text}`);
    admission.acknowledge();
  });

  occurrences.push(`offer: ${source.offer(steer("guidance"))}`);

  assert.deepEqual(occurrences, ["admitted: guidance", "offer: accepted"]);
});

test("Controls offered before subscription retain exact text and FIFO order", () => {
  const source = createControlSource();
  assert.equal(source.offer(steer("  first \n")), "accepted");
  assert.equal(source.offer(steer("second")), "accepted");

  const received: RunControl[] = [];
  source.controls.subscribe((admission) => {
    received.push(admission.control);
    admission.acknowledge();
  });

  assert.deepEqual(received, [steer("  first \n"), steer("second")]);
  assert.throws(() => source.controls.subscribe(() => {}), /one consumer/);
});

test("a reentrant offer cannot overtake Controls queued before subscription", () => {
  const source = createControlSource();
  assert.equal(source.offer(steer("first")), "accepted");
  assert.equal(source.offer(steer("second")), "accepted");
  const received: string[] = [];

  source.controls.subscribe((admission) => {
    received.push(admission.control.text);
    admission.acknowledge();
    if (admission.control.text === "first") {
      assert.equal(source.offer(steer("third")), "accepted");
    }
  });

  assert.deepEqual(received, ["first", "second", "third"]);
});

test("a Control stays pending until its consumer acknowledges it", () => {
  const source = createControlSource();
  const admissions: ControlAdmission[] = [];
  source.controls.subscribe((admission) => admissions.push(admission));
  for (let index = 0; index < CONTROL_MAX_PENDING; index++) {
    assert.equal(source.offer(steer("x")), "accepted");
  }
  assert.equal(source.offer(steer("blocked")), "queue full");

  admissions[0]?.acknowledge();

  assert.equal(source.offer(steer("now admitted")), "accepted");
});

test("the Control source enforces UTF-8 message, count, and total pending budgets", () => {
  const perMessage = createControlSource();
  assert.equal(
    perMessage.offer(steer("🙂".repeat(CONTROL_MAX_MESSAGE_BYTES / 4))),
    "accepted",
  );
  assert.equal(
    perMessage.offer(steer(`${"x".repeat(CONTROL_MAX_MESSAGE_BYTES - 3)}🙂`)),
    "invalid",
  );

  const byCount = createControlSource();
  for (let index = 0; index < CONTROL_MAX_PENDING; index++) {
    assert.equal(byCount.offer(steer("x")), "accepted");
  }
  assert.equal(byCount.offer(steer("overflow")), "queue full");

  const byBytes = createControlSource();
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

test("the Control source rejects whitespace-only steering", () => {
  const source = createControlSource();

  assert.equal(source.offer(steer(" \t\n\r")), "invalid");
});

test("acknowledgement releases pending UTF-8 byte capacity", () => {
  const source = createControlSource();
  const admissions: ControlAdmission[] = [];
  source.controls.subscribe((admission) => admissions.push(admission));
  const fullMessage = "🙂".repeat(CONTROL_MAX_MESSAGE_BYTES / 4);
  for (
    let index = 0;
    index < CONTROL_MAX_PENDING_BYTES / CONTROL_MAX_MESSAGE_BYTES;
    index++
  ) {
    assert.equal(source.offer(steer(fullMessage)), "accepted");
  }
  assert.equal(source.offer(steer("blocked")), "queue full");

  admissions[0]?.acknowledge();

  assert.equal(source.offer(steer("now admitted")), "accepted");
});

test("close before subscription discards early Controls and synchronously closes the consumer", () => {
  const source = createControlSource();
  assert.equal(source.offer(steer("discard me")), "accepted");
  source.close();

  const received: RunControl[] = [];
  let closed = false;
  source.controls.subscribe(
    (admission) => received.push(admission.control),
    () => {
      closed = true;
    },
  );

  assert.deepEqual(received, []);
  assert.equal(closed, true);
  assert.equal(source.offer(steer("too late")), "closed");
});

test("closing while early admissions are replayed discards the remainder", () => {
  const source = createControlSource();
  assert.equal(source.offer(steer("first")), "accepted");
  assert.equal(source.offer(steer("discard me")), "accepted");
  const received: string[] = [];

  source.controls.subscribe((admission) => {
    received.push(admission.control.text);
    source.close();
  });

  assert.deepEqual(received, ["first"]);
});

test("unsubscribe, close, repeated close, and late acknowledgement are idempotent", () => {
  const source = createControlSource();
  let admission: ControlAdmission | undefined;
  let closeCalls = 0;
  const unsubscribe = source.controls.subscribe(
    (next) => {
      admission = next;
    },
    () => {
      closeCalls++;
    },
  );
  assert.equal(source.offer(steer("discard me")), "accepted");

  unsubscribe();
  unsubscribe();
  source.close();
  source.close();
  admission?.acknowledge();
  admission?.acknowledge();

  assert.equal(closeCalls, 1);
  assert.equal(source.offer(steer("too late")), "closed");
});

test("the Control gate distinguishes unsupported, closed, and cancelling Runs without live admission", () => {
  const unsupported = createControlGate([]);
  assert.deepEqual(unsupported.state(), {
    supportedControls: [],
    closed: false,
    cancellationReason: undefined,
  });
  assert.equal(unsupported.offer(steer("guidance")), "unsupported");
  let unsupportedClosed = false;
  unsupported.controls.subscribe(
    () => assert.fail("unsupported source admitted a Control"),
    () => {
      unsupportedClosed = true;
    },
  );
  assert.equal(unsupportedClosed, true);

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
