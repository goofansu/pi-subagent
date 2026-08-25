import assert from "node:assert/strict";
import { test } from "node:test";
import type { PushedNotification } from "./delivery.ts";
import {
  type NotificationDeliveryEvent,
  type NotificationDeliveryState,
  transitionNotification,
} from "./notification-delivery.ts";

const notification: PushedNotification = {
  id: "run-1",
  agent: "explore",
  status: "completed",
  text: "done",
};

const states: NotificationDeliveryState[] = [
  { phase: "pending", notification },
  { phase: "awaiting-landing", notification },
  { phase: "known-lost", notification },
  { phase: "delivered" },
];
const events: NotificationDeliveryEvent[] = [
  { type: "push" },
  { type: "landed" },
  { type: "known-lost" },
  { type: "retry" },
  { type: "shutdown" },
];

test("notification transitions cover every state x event pair", () => {
  const covered = new Set<string>();
  for (const state of states) {
    for (const event of events) {
      covered.add(`${state.phase}:${event.type}`);
      assert.doesNotThrow(() => transitionNotification(state, event));
    }
  }
  assert.equal(covered.size, states.length * events.length);
});

test("pending pushes once and landing is final", () => {
  const pushed = transitionNotification(states[0], { type: "push" });
  assert.equal(pushed.state.phase, "awaiting-landing");
  assert.equal(pushed.push, notification);

  const landed = transitionNotification(pushed.state, { type: "landed" });
  assert.deepEqual(landed, {
    state: { phase: "delivered" },
    release: true,
  });
  assert.deepEqual(transitionNotification(landed.state, { type: "retry" }), {
    state: { phase: "delivered" },
  });
});

test("known-lost retries, while an interrupt-then-land race does not", () => {
  const lost = transitionNotification(states[1], { type: "known-lost" });
  assert.equal(lost.state.phase, "known-lost");
  const retried = transitionNotification(lost.state, { type: "retry" });
  assert.equal(retried.state.phase, "awaiting-landing");
  assert.equal(retried.push, notification);

  const racedLanding = transitionNotification(lost.state, { type: "landed" });
  assert.equal(racedLanding.state.phase, "delivered");
  assert.equal(racedLanding.release, true);
});

test("shutdown drops every unlanded notification without pushing", () => {
  for (const state of states.slice(0, 3)) {
    const stopped = transitionNotification(state, { type: "shutdown" });
    assert.equal(stopped.state.phase, "delivered");
    assert.equal(stopped.release, true);
    assert.equal(stopped.push, undefined);
  }
});
