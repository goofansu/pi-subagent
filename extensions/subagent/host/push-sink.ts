/**
 * The Session push sink: pushed is not landed, and landed is not the only way
 * a hand-off is finished with.
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
 * ## Consumption, and why the hand-off has a second exit
 *
 * A notice exists to make the parent fetch the Result. A parent that fetched
 * it already needs no notice, so the `agent_result` tool handler tells this
 * sink — once, on a returned Result — that the Run was **consumed**, and the
 * hand-off is then *resolved* whether or not anything ever lands. Consumption
 * does three things and nothing else:
 *
 * - a push for a consumed Run is **accepted and not sent**, which delivery
 *   sees as a hand-off: the host accepted the message, and the host's
 *   acceptance includes deciding not to send it;
 * - a consumed notice **lost after hand-off is not re-pushed** at settle;
 * - a consumed notice Pi already holds **lands as usual**, and is counted as
 *   {@link HandoffCounts.consumedBeforeLanding}.
 *
 * **When to add a state here, and when not to.** A new sink state earns its
 * place only if it changes whether a hand-off is *unresolved*, *resolved*, or
 * *failed* — those three are what the sink exists to distinguish, and what
 * every reader of it asks. Anything else is bookkeeping that belongs to
 * whoever needs it. Batching metadata is the example that does not qualify:
 * knowing which notices would travel in one envelope, or how many are waiting
 * for a parent to settle, changes nothing about whether any one hand-off has
 * resolved, and a sink that carried it would be a sink two things could
 * disagree about. The hold-while-active envelope in the simplification
 * roadmap's Phase D is a host mechanism *above* this sink for exactly that
 * reason, and it reads `consumedBeforeLanding` rather than adding a state to
 * produce it.
 *
 * The third is not a gap that was overlooked. While the parent is streaming,
 * the follow-up is in Pi's own queue and the extension API exposes nothing
 * that removes one queued message, so a handed-off notice lands whatever the
 * parent does. The count is the evidence Phase D's hold-while-active envelope
 * waits for.
 * [ADR-0035](../../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)
 * is the decision.
 *
 * ## What the widget is told, and what it is not
 *
 * Five states live here — unlanded, lost, landed, exhausted, consumed — and
 * the widget sees three: `pending`, `resolved`, `exhausted`. It never learns
 * whether *resolved* was a landing or a retrieval, because a row that stays
 * and a row that goes is the whole of what it is deciding, and a component
 * that knew more would eventually act on more.
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
import type { HandoffStatus } from "./widget.ts";

/** How a notice reaches Pi. One function, so a test can supply its own. */
export type SendNotification = (message: NotificationMessage) => void;

/** What a completed host turn says about itself, as neutral evidence. */
export interface HostTurnEvidence {
  readonly stopReason?: string;
  readonly signalAborted?: boolean;
}

/**
 * The hand-off, counted by outcome rather than by total.
 *
 * A counter that cannot tell a refused hand-off from a lost one cannot say
 * which half of the pipeline is failing, which is the only question these
 * exist to answer. The first three are about delivery reaching the host; the
 * next four are about the host reaching the conversation; the last is the
 * evidence Phase D is scheduled on.
 *
 * `pushesAttempted` is `handOffsAccepted` plus `handOffsRefused`: a re-push is
 * the sink's own doing and is counted as a `rePushes` rather than as a second
 * attempt by delivery.
 */
export interface HandoffCounts {
  /** Calls delivery made to {@link SessionPushSink.push}. */
  readonly pushesAttempted: number;
  /** Pushes this sink took, a consumed Run's accepted-and-not-sent included. */
  readonly handOffsAccepted: number;
  /** Pushes it could not take: no Session bound, or the Session threw. */
  readonly handOffsRefused: number;
  /** Notices an aborted turn discarded before they reached the conversation. */
  readonly lostAfterHandOff: number;
  /** Notices handed over a second time when the parent settled. */
  readonly rePushes: number;
  /** Notices `message_start` carried into the conversation. */
  readonly landings: number;
  /** Runs delivery gave up announcing, after its retry budget ran out. */
  readonly exhaustions: number;
  /**
   * Landings whose Result the parent had already retrieved.
   *
   * The number Phase D's envelope is scheduled on. Near zero means batching is
   * the only thing left to want; a steady count means suppressing a queued
   * notice has a number behind it.
   */
  readonly consumedBeforeLanding: number;
}

const ZERO_COUNTS: HandoffCounts = {
  pushesAttempted: 0,
  handOffsAccepted: 0,
  handOffsRefused: 0,
  lostAfterHandOff: 0,
  rePushes: 0,
  landings: 0,
  exhaustions: 0,
  consumedBeforeLanding: 0,
};

export interface SessionPushSink extends NotificationSink {
  /** Point the sink at a live Session's `sendMessage`, and start its counts. */
  readonly bind: (send: SendNotification) => void;
  /**
   * Stop sending, and forget every Run this Session knew about.
   *
   * Dropped rather than kept: the ids belong to a Session that has ended, and
   * a notice delivered into the next one would be about work its model never
   * started. The counts are *not* cleared, so `/subagent diagnostics` can
   * still say what the Session that just ended did.
   */
  readonly unbind: () => void;
  /** A message reached the conversation. Marks a notice landed, if it is ours. */
  readonly messageStarted: (message: unknown) => void;
  /** A host turn finished. An aborted one loses every unlanded notice. */
  readonly turnEnded: (evidence: HostTurnEvidence) => void;
  /** The parent agent went idle. Every lost notice is pushed again, once. */
  readonly agentSettled: () => void;
  /**
   * The parent retrieved this Run's Result with `agent_result`.
   *
   * Told by the tool handler, through one narrow function, and by nothing
   * else. Not `agent_wait`, which reports terminality and withholds the
   * answer; not an internal store read, which delivery and diagnostics also
   * make.
   */
  readonly consumed: (runId: RunId) => void;
  /** Run ids whose notice has been pushed and not yet seen to land. */
  readonly unlanded: () => readonly RunId[];
  /** Run ids whose notice has landed, in landing order. */
  readonly landed: () => readonly RunId[];
  /**
   * Whether this Run's completion notice has reached the conversation.
   *
   * A question about landing *alone*, and nothing in production asks it: the
   * widget asks {@link status}, and the diagnostics report reads
   * {@link counts}. It is kept because the tests here are about landing
   * specifically, and a test that had to phrase that as `status(id) ===
   * "resolved"` would pass for a consumed Run that never landed — which is the
   * one distinction those tests exist to make.
   */
  readonly hasLanded: (runId: RunId) => boolean;
  /** How far this Run's hand-off has got. See {@link HandoffStatus}. */
  readonly status: (runId: RunId) => HandoffStatus;
  /**
   * Watch for anything that changes a {@link status}. Returns an unsubscribe.
   *
   * A landing, a consumption and an exhaustion are host events rather than Run
   * state changes, so nothing the repository publishes marks them. A consumer
   * whose display depends on `status` therefore has to be told, and this is
   * the telling. Listeners are display-only and a throwing one is ignored,
   * because a throw out of a Pi host event handler takes the process with it.
   */
  readonly subscribe: (listener: () => void) => () => void;
  /** What this Session's hand-offs did, by outcome. */
  readonly counts: () => HandoffCounts;
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
  /**
   * The Run ids whose notice landed, in landing order.
   *
   * A `Set` rather than an array so that asking about one Run is a lookup
   * rather than a scan, and insertion order still gives {@link landed} the
   * sequence it reports. Bounded by the number of Runs one Session settles,
   * which is what the repository's own index is bounded by.
   */
  const landed = new Set<RunId>();
  /** Runs whose Result the parent has retrieved. Bounded the same way. */
  const consumed = new Set<RunId>();
  /** Runs delivery gave up announcing. Bounded the same way. */
  const exhausted = new Set<RunId>();
  const listeners = new Set<() => void>();
  let counts: HandoffCounts = ZERO_COUNTS;

  const count = (field: keyof HandoffCounts): void => {
    counts = { ...counts, [field]: counts[field] + 1 };
  };

  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Display-only subscribers, and a throw out of a Pi host event handler
        // ends the process. There is nowhere useful to report this.
      }
    }
  };

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
      Effect.suspend(() => {
        count("pushesAttempted");
        // Accepted and not sent. Delivery sees a hand-off, which is what
        // happened: the host took responsibility for the message, and taking
        // responsibility included deciding the parent does not need it.
        if (consumed.has(notification.runId)) {
          count("handOffsAccepted");
          return Effect.void;
        }
        if (handOver(notification)) {
          count("handOffsAccepted");
          return Effect.void;
        }
        count("handOffsRefused");
        return Effect.fail<NotificationPushFailure>({
          reason: "no Session is bound to receive the notification",
        });
      }),

    exhausted: (runId) =>
      Effect.sync(() => {
        // A consumed Run's hand-off is already resolved, so there is nothing
        // an exhaustion could add: the parent has the answer either way.
        if (consumed.has(runId) || exhausted.has(runId)) return;
        exhausted.add(runId);
        count("exhaustions");
        announce();
      }),

    bind: (target) => {
      send = target;
      // The counts are one Session's, so a report read during the next Session
      // is about the next Session.
      counts = ZERO_COUNTS;
    },

    unbind: () => {
      send = undefined;
      unlanded.clear();
      landed.clear();
      consumed.clear();
      exhausted.clear();
    },

    messageStarted: (message) => {
      const details = parseNotificationMessage(message);
      if (!details) return;
      if (!unlanded.delete(details.runId)) return;
      landed.add(details.runId);
      count("landings");
      // Pi held this one already, and the extension API has no call that takes
      // a queued message back. Counted rather than prevented; the count is
      // what Phase D's envelope is scheduled on.
      if (consumed.has(details.runId)) count("consumedBeforeLanding");
      announce();
    },

    turnEnded: (evidence) => {
      if (
        evidence.stopReason !== "aborted" &&
        evidence.signalAborted !== true
      ) {
        return;
      }
      for (const notice of unlanded.values()) {
        if (notice.lost) continue;
        notice.lost = true;
        count("lostAfterHandOff");
      }
    },

    agentSettled: () => {
      // Snapshot first: `handOver` writes to the same map, and a landing that
      // arrives synchronously during the loop would otherwise mutate what is
      // being iterated.
      const lost = [...unlanded.values()].filter((notice) => notice.lost);
      for (const notice of lost) {
        // A consumed Run's notice is not pushed again, and the sink forgets
        // it: Pi discarded the message and nothing will land, so keeping it
        // unlanded would keep a row alive for a Result the parent has read.
        if (consumed.has(notice.notification.runId)) {
          unlanded.delete(notice.notification.runId);
          continue;
        }
        // Cleared before pushing, because the push may land synchronously.
        notice.lost = false;
        count("rePushes");
        handOver(notice.notification);
      }
    },

    consumed: (runId) => {
      // A landed notice has already done its work, so consumption adds
      // nothing; recording it would only make `consumedBeforeLanding` count
      // the ordinary case.
      if (landed.has(runId) || consumed.has(runId)) return;
      consumed.add(runId);
      announce();
    },

    unlanded: () => [...unlanded.keys()],
    landed: () => [...landed],
    hasLanded: (runId) => landed.has(runId),
    status: (runId) => {
      if (landed.has(runId) || consumed.has(runId)) return "resolved";
      return exhausted.has(runId) ? "exhausted" : "pending";
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    counts: () => counts,
  };
}
