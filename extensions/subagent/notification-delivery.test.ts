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
  subagentId: "subagent-1",
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
  const pending = states[0];
  const awaiting = states[1];
  const lost = states[2];
  const delivered = states[3];
  const released = { state: { phase: "delivered" } as const, release: true };
  const expected = {
    pending: {
      push: {
        state: { phase: "awaiting-landing" as const, notification },
        push: notification,
      },
      landed: { state: pending },
      "known-lost": { state: pending },
      retry: { state: pending },
      shutdown: released,
    },
    "awaiting-landing": {
      push: { state: awaiting },
      landed: released,
      "known-lost": {
        state: { phase: "known-lost" as const, notification },
      },
      retry: { state: awaiting },
      shutdown: released,
    },
    "known-lost": {
      push: { state: lost },
      landed: released,
      "known-lost": { state: lost },
      retry: {
        state: { phase: "awaiting-landing" as const, notification },
        push: notification,
      },
      shutdown: released,
    },
    delivered: {
      push: { state: delivered },
      landed: { state: delivered },
      "known-lost": { state: delivered },
      retry: { state: delivered },
      shutdown: { state: delivered },
    },
  };

  let covered = 0;
  for (const state of states) {
    for (const event of events) {
      covered++;
      assert.deepEqual(
        transitionNotification(state, event),
        expected[state.phase][event.type],
        `${state.phase} x ${event.type}`,
      );
    }
  }
  assert.equal(covered, states.length * events.length);
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
