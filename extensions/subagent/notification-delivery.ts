import type { PushedNotification } from "./delivery.ts";

export type NotificationDeliveryState =
  | { phase: "pending"; notification: PushedNotification }
  | { phase: "awaiting-landing"; notification: PushedNotification }
  | { phase: "known-lost"; notification: PushedNotification }
  | { phase: "delivered" };

export type NotificationDeliveryEvent =
  | { type: "push" }
  | { type: "landed" }
  | { type: "known-lost" }
  | { type: "retry" }
  | { type: "shutdown" };

export interface NotificationTransition {
  state: NotificationDeliveryState;
  push?: PushedNotification;
  release?: boolean;
}

/** Apply one notification event. Invalid or stale events are idempotent. */
export function transitionNotification(
  state: NotificationDeliveryState,
  event: NotificationDeliveryEvent,
): NotificationTransition {
  if (event.type === "shutdown") {
    return state.phase === "delivered"
      ? { state }
      : { state: { phase: "delivered" }, release: true };
  }

  switch (state.phase) {
    case "pending":
      if (event.type === "push") {
        return {
          state: {
            phase: "awaiting-landing",
            notification: state.notification,
          },
          push: state.notification,
        };
      }
      return { state };
    case "awaiting-landing":
      if (event.type === "landed")
        return { state: { phase: "delivered" }, release: true };
      if (event.type === "known-lost") {
        return {
          state: { phase: "known-lost", notification: state.notification },
        };
      }
      return { state };
    case "known-lost":
      if (event.type === "landed")
        return { state: { phase: "delivered" }, release: true };
      if (event.type === "retry") {
        return {
          state: {
            phase: "awaiting-landing",
            notification: state.notification,
          },
          push: state.notification,
        };
      }
      return { state };
    case "delivered":
      return { state };
  }
}
