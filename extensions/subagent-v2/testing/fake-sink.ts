/**
 * A notification sink that records what it was given, and can be told to fail.
 *
 * It lives here rather than beside the `NotificationSink` interface because it
 * is a test double, and a production module that ships one invites a
 * production caller to reach for it. The Session runtime has no default sink
 * for the same reason: a Session built without one would deliver into a fake
 * and look like it was working.
 *
 * Shared between the conformance rig and the runtime tests, because two copies
 * of it would drift and the retry assertions depend on the attempt count being
 * counted the same way in both.
 */

import { Effect } from "effect";
import type { RunNotification } from "../domain/index.ts";
import type {
  NotificationPushFailure,
  NotificationSink,
} from "../runtime/delivery.ts";

export interface FakeNotificationSink extends NotificationSink {
  /** The notifications that landed, in the order they landed. */
  readonly received: () => readonly RunNotification[];
  /** How many pushes were attempted, including the ones that failed. */
  readonly attempts: () => number;
  /** Fail the next `count` pushes. `Infinity` fails every one. */
  readonly failNext: (count: number) => void;
}

export function createFakeNotificationSink(): FakeNotificationSink {
  const received: RunNotification[] = [];
  let attempts = 0;
  let failing = 0;
  return {
    push: (notification) =>
      Effect.suspend(() => {
        attempts += 1;
        if (failing > 0) {
          failing -= 1;
          return Effect.fail<NotificationPushFailure>({
            reason: "the sink refused the push",
          });
        }
        received.push(notification);
        return Effect.void;
      }),
    received: () => [...received],
    attempts: () => attempts,
    failNext: (count) => {
      failing = count;
    },
  };
}
