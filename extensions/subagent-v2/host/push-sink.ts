/**
 * The Session push sink: pushed is not landed.
 *
 * `CompletionDelivery` treats a successful push as its job done, and that is
 * correct for delivery — it stored the Result first, so a push that failed
 * cannot have lost anything. But a push that *succeeded* has not necessarily
 * reached the conversation: Pi queues a follow-up message, and an interrupted
 * turn discards what was queued. So somebody has to know the difference
 * between a message that was handed over and a message that arrived, and this
 * is it.
 *
 * The state machine is four host events wide:
 *
 * 1. **push** sends the built message as a follow-up that triggers a turn, and
 *    records the notice as *unlanded*, retaining the bounded notification
 *    value.
 * 2. **message-start** carrying a notice we parsed marks it *landed* and
 *    forgets it. That is the terminal state: a landed notice is never pushed
 *    again.
 * 3. **turn end** whose stop reason was aborted, or whose signal was aborted,
 *    marks every unlanded notice *lost*. Neutral evidence rather than a guess:
 *    the sink does not decide what an interrupt is, it is told.
 * 4. **agent settled** pushes every lost notice again, once, and clears the
 *    lost mark before pushing — because a re-push may land synchronously, and
 *    a notice marked lost after it landed would be pushed a third time.
 *
 * Exactly one landing per notification is this module's contract, and it is
 * tested through those four events rather than through delivery.
 *
 * The retained value is the notification, not a pin on the stored Result.
 * Delivery releases the result's pin when the push succeeds, so by the time
 * landing is in question the Result may already have been evicted — and a
 * notice is bounded and small, which is what makes retaining it cheap. This is
 * what v1 does, for the same reason.
 *
 * Nothing is queued when no Session is bound. A Result belongs to the Session
 * that asked for it, and the next Session's model did not start these Runs.
 */

import { Effect } from "effect";
import type { RunId, RunNotification } from "../domain/index.ts";
import type {
  NotificationPushFailure,
  NotificationSink,
} from "../runtime/delivery.ts";
import {
  buildNotificationMessage,
  type NotificationMessage,
  parseNotificationMessage,
} from "./notification-message.ts";

/** How a notice reaches Pi. One function, so a test can supply its own. */
export type SendNotification = (message: NotificationMessage) => void;

/** What a completed host turn says about itself, as neutral evidence. */
export interface HostTurnEvidence {
  readonly stopReason?: string;
  readonly signalAborted?: boolean;
}

export interface SessionPushSink extends NotificationSink {
  /** Point the sink at a live Session's `sendMessage`. */
  readonly bind: (send: SendNotification) => void;
  /**
   * Stop sending, and drop every unlanded notice.
   *
   * Dropped rather than kept: the ids belong to a Session that has ended, and
   * a notice delivered into the next one would be about work its model never
   * started.
   */
  readonly unbind: () => void;
  /** A message reached the conversation. Marks a notice landed, if it is ours. */
  readonly messageStarted: (message: unknown) => void;
  /** A host turn finished. An aborted one loses every unlanded notice. */
  readonly turnEnded: (evidence: HostTurnEvidence) => void;
  /** The parent agent went idle. Every lost notice is pushed again, once. */
  readonly agentSettled: () => void;
  /** Run ids whose notice has been pushed and not yet seen to land. */
  readonly unlanded: () => readonly RunId[];
  /** Run ids whose notice has landed, in landing order. */
  readonly landed: () => readonly RunId[];
}

/** What the sink keeps about a notice that has not landed. */
interface Unlanded {
  readonly notification: RunNotification;
  /** Whether an aborted turn has been seen since this notice was pushed. */
  lost: boolean;
}

export function createSessionPushSink(): SessionPushSink {
  let send: SendNotification | undefined;
  const unlanded = new Map<RunId, Unlanded>();
  const landed: RunId[] = [];

  /**
   * Hand one notice to the Session, recording it as unlanded *first*.
   *
   * The order matters and is not incidental: Pi may report the message
   * starting synchronously inside `sendMessage`, and a notice recorded after
   * that would be recorded as unlanded immediately after it had landed — and
   * then pushed again at the next abort.
   */
  const handOver = (notification: RunNotification, lost = false): boolean => {
    const target = send;
    if (!target) return false;
    unlanded.set(notification.runId, { notification, lost });
    try {
      target(buildNotificationMessage(notification));
      return true;
    } catch {
      // A throw stops this sink using the Session at all, and the cost of that
      // is worth stating: a *transient* throw silences every later
      // notification until the next `bind`. It is v1's behaviour and it is
      // deliberate, because the throw that actually happens is a Session that
      // went stale before its shutdown event arrived — such a Session throws
      // on every method, and re-attempting it once per settled Run would turn
      // one dead Session into one dead push per Run. The Result is stored
      // either way, so nothing is lost that `agent_result` cannot return, and
      // the next Session's `bind` restores the sink.
      unlanded.delete(notification.runId);
      send = undefined;
      return false;
    }
  };

  return {
    push: (notification) =>
      Effect.suspend(() =>
        handOver(notification)
          ? Effect.void
          : Effect.fail<NotificationPushFailure>({
              reason: "no Session is bound to receive the notification",
            }),
      ),

    bind: (target) => {
      send = target;
    },

    unbind: () => {
      send = undefined;
      unlanded.clear();
    },

    messageStarted: (message) => {
      const details = parseNotificationMessage(message);
      if (!details) return;
      if (unlanded.delete(details.runId)) landed.push(details.runId);
    },

    turnEnded: (evidence) => {
      if (
        evidence.stopReason !== "aborted" &&
        evidence.signalAborted !== true
      ) {
        return;
      }
      for (const notice of unlanded.values()) notice.lost = true;
    },

    agentSettled: () => {
      // Snapshot first: `handOver` writes to the same map, and a landing that
      // arrives synchronously during the loop would otherwise mutate what is
      // being iterated.
      const lost = [...unlanded.values()].filter((notice) => notice.lost);
      for (const notice of lost) {
        // Cleared before pushing, because the push may land synchronously.
        notice.lost = false;
        handOver(notice.notification);
      }
    },

    unlanded: () => [...unlanded.keys()],
    landed: () => [...landed],
  };
}
