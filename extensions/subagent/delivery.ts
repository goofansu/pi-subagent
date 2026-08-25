/**
 * Completion notification delivery and the authoritative result store.
 * Await observes terminality; it never owns delivery or mutates stored results.
 * Notifications remain landing-tracked so an interrupt can re-push a notice
 * known to be lost.
 */

import {
  type NotificationDeliveryEvent,
  type NotificationDeliveryState,
  transitionNotification,
} from "./notification-delivery.ts";
import { formatNotification, fullOutput } from "./presentation.ts";
import type { SubagentRuns } from "./runs.ts";
import { subagentRuns } from "./runs.ts";
import type { LifecycleStatus, SingleResult } from "./types.ts";

/** A completion notification on its way to the model. */
export interface PushedNotification {
  id: string;
  agent: string;
  status: Exclude<LifecycleStatus, "running">;
  /** The bounded orientation message the model reads. */
  text: string;
}

/** Push a completion notification into the session. */
export type PushNotification = (notification: PushedNotification) => void;

/**
 * A push target that outlives any one session.
 *
 * A session's `sendMessage` becomes stale when that session is replaced. This
 * process-lifetime seam lets each session start re-aim notification pushes at
 * the live API. A notice emitted with no session bound is dropped rather than
 * crossing into a conversation that did not start its run.
 */
export interface SessionPush {
  /** The stable target to build the delivery with. */
  push: PushNotification;
  /** Aim at a live session. */
  bind(push: PushNotification): void;
  /** Drop the target; notifications emitted before the next bind are dropped. */
  unbind(): void;
}

export function createSessionPush(): SessionPush {
  let live: PushNotification | null = null;

  const push: PushNotification = (notification) => {
    if (!live) return;
    try {
      live(notification);
    } catch {
      // Stop using a session that went stale before its shutdown event. The
      // notifications it can no longer accept are dropped.
      live = null;
    }
  };

  return {
    push,
    bind(target) {
      live = target;
    },
    unbind() {
      live = null;
    },
  };
}

/**
 * A terminal run's authoritative result, retained for the session.
 *
 * Storage is independent of notification delivery. Whole outputs are held up
 * to {@link RESULT_STORE_CHARACTER_BUDGET}; an evicted entry remains
 * addressable and reports that its output is gone.
 */
export interface RetainedResult {
  id: string;
  agent: string;
  status: Exclude<LifecycleStatus, "running">;
  reason?: "requested" | "shutdown";
  /** The run's full final output, untrimmed. Empty once evicted. */
  output: string;
  /** True when the output was dropped to keep result store under budget. */
  evicted?: boolean;
}

/**
 * Cap on the total characters result store holds across all runs.
 *
 * Without a total budget, a long session of large results would grow without
 * limit. Eviction removes the oldest output first while retaining its terminal
 * metadata. The newest result always survives.
 */
export const RESULT_STORE_CHARACTER_BUDGET = 2_000_000;

export interface DeliveryOptions {
  push: PushNotification;
  runs?: SubagentRuns;
  /** Injected for tests; defaults to {@link RESULT_STORE_CHARACTER_BUDGET}. */
  resultBudget?: number;
}

export interface AwaitResult {
  id: string;
  agent: string;
  phase: Exclude<LifecycleStatus, "running">;
  reason?: "requested" | "shutdown";
}

export interface WaitOutcome {
  terminal: AwaitResult[];
  /** Ids still running when the await gave up. */
  stillRunning: string[];
  /** Ids that name no run this runtime has ever seen. */
  unknown: string[];
}

export interface CancelOutcome {
  /** Ids this call stopped. Their cancellation is delivered by the caller. */
  cancelled: string[];
  /** Ids that settled before the cancel arrived; their results stand. */
  finished: string[];
  /** Ids that name no run this delivery has ever seen. */
  unknown: string[];
}

export interface SubagentDelivery {
  /** Track a started run through settlement, storage, and notification. */
  register(id: string, settled: Promise<SingleResult>): void;
  /** Whether this id names a known run. */
  has(id: string): boolean;
  /** Observe when named runs become terminal without affecting notifications. */
  wait(
    ids: readonly string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<WaitOutcome>;
  /** Request cancellation. The eventual result and notification are unchanged. */
  cancel(ids: readonly string[]): CancelOutcome;
  /** Confirm that this run's pushed notification entered the conversation. */
  notificationLanded(id: string): void;
  /** Mark queued, unlanded notifications as known lost after an interrupt. */
  turnAborted(): void;
  /** Retry notifications known lost once the parent agent settles. */
  agentSettled(): void;
  /** Stop running children and clear this session's notifications/results. */
  shutdown(): void;
  /** Observe a terminal run's retained authoritative result. */
  result(id: string): RetainedResult | undefined;
}

interface Pending {
  id: string;
  tracked: Promise<void>;
  result?: SingleResult;
}

export function createSubagentDelivery({
  push,
  runs = subagentRuns,
  resultBudget = RESULT_STORE_CHARACTER_BUDGET,
}: DeliveryOptions): SubagentDelivery {
  const pending = new Map<string, Pending>();
  const results = new Map<string, RetainedResult>();
  const notifications = new Map<string, NotificationDeliveryState>();
  let generation = 0;

  const enforceResultStoreBudget = (): void => {
    let total = 0;
    for (const result of results.values()) total += result.output.length;
    const ids = [...results.keys()];
    const newest = ids.at(-1);
    for (const id of ids) {
      if (total <= resultBudget || id === newest) break;
      const result = results.get(id);
      if (!result?.output) continue;
      total -= result.output.length;
      results.set(id, { ...result, output: "", evicted: true });
    }
  };

  const storeResult = (id: string, result: SingleResult): void => {
    if (result.lifecycle.phase === "running") return;
    results.set(id, {
      id,
      agent: result.agent,
      status: result.lifecycle.phase,
      ...(result.lifecycle.phase === "cancelled"
        ? { reason: result.lifecycle.reason }
        : {}),
      output: fullOutput(result),
    });
    enforceResultStoreBudget();
  };

  const safePush: PushNotification = (notification) => {
    try {
      push(notification);
    } catch {
      // Results are already stored; notification failure is not result loss.
    }
  };

  const applyNotificationEvent = (
    id: string,
    event: NotificationDeliveryEvent,
  ): void => {
    const current = notifications.get(id);
    if (!current) return;
    const transition = transitionNotification(current, event);
    notifications.set(id, transition.state);
    if (transition.push) safePush(transition.push);
    if (transition.release) runs.release(id);
  };

  const notify = (id: string, result: SingleResult): void => {
    if (result.lifecycle.phase === "running")
      throw new Error(`Cannot notify for running subagent ${id}`);
    const notification: PushedNotification = {
      id,
      agent: result.agent,
      status: result.lifecycle.phase,
      text: formatNotification(id, result),
    };
    notifications.set(id, { phase: "pending", notification });
    applyNotificationEvent(id, { type: "push" });
  };

  return {
    register(id, settled) {
      const registeredGeneration = generation;
      const entry: Pending = { id, tracked: Promise.resolve() };
      pending.set(id, entry);
      entry.tracked = (async () => {
        try {
          entry.result = await settled;
          if (registeredGeneration !== generation || pending.get(id) !== entry)
            return;
          storeResult(id, entry.result);
          pending.delete(id);
          notify(id, entry.result);
        } catch (error: unknown) {
          if (registeredGeneration !== generation || pending.get(id) !== entry)
            return;
          pending.delete(id);
          const message =
            error instanceof Error ? error.message : String(error);
          results.set(id, {
            id,
            agent: "unknown",
            status: "failed",
            output:
              `This run failed before completing.\n\nFailure: ${message}` +
              "\n\nThe run failed before producing output.",
          });
          enforceResultStoreBudget();
          const notification: PushedNotification = {
            id,
            agent: "unknown",
            status: "failed",
            text: `Subagent run ${id} ended unexpectedly: ${message}`,
          };
          notifications.set(id, { phase: "pending", notification });
          applyNotificationEvent(id, { type: "push" });
        }
      })();
    },

    has: (id) => pending.has(id) || results.has(id),

    async wait(ids, options = {}) {
      const requested = [...new Set(ids)];
      const waiting = requested
        .map((id) => pending.get(id))
        .filter((entry): entry is Pending => entry !== undefined);
      await withDeadline(
        Promise.all(waiting.map((entry) => entry.tracked)),
        options,
      );

      const terminal: AwaitResult[] = [];
      const stillRunning: string[] = [];
      const unknown: string[] = [];
      for (const id of requested) {
        const stored = results.get(id);
        if (stored) {
          terminal.push({
            id,
            agent: stored.agent,
            phase: stored.status,
            ...(stored.reason ? { reason: stored.reason } : {}),
          });
        } else if (pending.has(id)) stillRunning.push(id);
        else unknown.push(id);
      }
      return { terminal, stillRunning, unknown };
    },

    result: (id) => results.get(id),

    notificationLanded(id) {
      applyNotificationEvent(id, { type: "landed" });
    },

    turnAborted() {
      for (const [id, state] of notifications) {
        if (state.phase === "awaiting-landing")
          applyNotificationEvent(id, { type: "known-lost" });
      }
    },

    agentSettled() {
      for (const [id, state] of notifications) {
        if (state.phase === "known-lost")
          applyNotificationEvent(id, { type: "retry" });
      }
    },

    cancel(ids) {
      const requested = [...new Set(ids)];
      const cancelled = runs.cancel(requested, "requested");
      const finished: string[] = [];
      const unknown: string[] = [];
      for (const id of requested) {
        if (cancelled.includes(id)) continue;
        if (results.has(id)) finished.push(id);
        else if (pending.has(id)) cancelled.push(id);
        else unknown.push(id);
      }
      return { cancelled, finished, unknown };
    },

    shutdown() {
      runs.cancel(
        runs
          .list()
          .filter((run) => run.status === "running")
          .map((run) => run.id),
        "shutdown",
      );
      generation++;
      for (const id of pending.keys()) runs.release(id);
      for (const id of notifications.keys())
        applyNotificationEvent(id, { type: "shutdown" });
      pending.clear();
      notifications.clear();
      results.clear();
    },
  };
}

/**
 * The longest delay `setTimeout` honours. Past it Node fires the timer after
 * one millisecond, which would turn an over-generous timeout into an instant
 * one; clamping keeps it what the caller meant — effectively forever.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Resolve when `work` does, or give up on a timeout or an abort.
 *
 * Giving up never rejects: a wait that ran out of patience is an outcome the
 * caller observes, not an error, and the run it was waiting on is still alive.
 */
async function withDeadline(
  work: Promise<unknown>,
  { timeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  if (timeoutMs === undefined && !signal) {
    await work;
    return;
  }

  // An abort listener added to a signal that already fired never runs, so a
  // wait entered with a cancelled turn would block until the runs settle.
  if (signal?.aborted) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(finish, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    signal?.addEventListener("abort", finish, { once: true });
    void work.then(finish, finish);
  });
}
