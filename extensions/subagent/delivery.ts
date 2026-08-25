/**
 * Completion notification delivery and the authoritative result store.
 * Await observes terminality; it never owns delivery or mutates stored results.
 * Notifications remain landing-tracked so an interrupt can re-push a notice
 * known to be lost.
 */

import { formatNotification, fullOutput } from "./presentation.ts";
import type { SubagentRuns } from "./runs.ts";
import { subagentRuns } from "./runs.ts";
import type { LifecycleStatus, SingleResult } from "./types.ts";

/** A report on its way to the model, with what a renderer needs to show it. */
export interface PushedNotification {
  id: string;
  agent: string;
  status: LifecycleStatus;
  /** The bounded orientation message the model reads. */
  text: string;
}

/** Push a report into the session. Narrowed from `ExtensionAPI`. */
export type PushNotification = (report: PushedNotification) => void;

/**
 * A push target that outlives any one session.
 *
 * Detached runs belong to the pi process, but the `sendMessage` a report is
 * pushed through belongs to one session's ExtensionAPI, and every method on it
 * throws once that session is replaced. This seam is what lets the delivery be
 * built once over `push` while each session start re-aims it at the live
 * session.
 *
 * A report that arrives with no session bound is dropped, not queued: it
 * belongs to the conversation that started its run, and that conversation is
 * gone. Delivering it into the next session would hand a model an answer to a
 * question it never asked. The drop is a crash guard for the teardown race —
 * settling through a stale API must not throw through an otherwise-unobserved
 * promise chain — never a cross-session delivery channel.
 */
export interface SessionPush {
  /** The stable target to build the delivery with. */
  push: PushNotification;
  /** Aim at a live session. */
  bind(push: PushNotification): void;
  /** Drop the target; reports that settle before the next bind are dropped. */
  unbind(): void;
}

export function createSessionPush(): SessionPush {
  let live: PushNotification | null = null;

  const push: PushNotification = (report) => {
    if (!live) return;
    try {
      live(report);
    } catch {
      // A session that went stale before its shutdown event reached us. Stop
      // pushing through it; the reports it can no longer take are dropped.
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
 * What a delivered run said, kept for the rest of the session.
 *
 * A pushed report is capped so a runaway agent cannot swamp the parent's
 * context, and before this existed the trimmed remainder was simply lost —
 * work that had already been paid for. Result storage keeps the whole thing
 * addressable by id, so `agent_result` can hand back what the cap left out.
 *
 * The invariant is delivered ⇒ resultable, for the session that asked:
 * `shutdown` clears result store, because a report belongs to the conversation
 * that asked for it and the next session's model never started these runs.
 * Within a session, whole outputs are held only up to a budget — see
 * {@link RESULT_STORE_CHARACTER_BUDGET} — and an entry whose output was evicted
 * still answers, saying so.
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
 * Result storage keeps every delivered run's whole output in memory for the rest
 * of the session, and nothing else bounds it — a long session of large
 * reports would grow without limit. This is a backstop against that, not a
 * working budget: it is roughly eighty reports at the pushed-report cap, and
 * eviction takes the oldest outputs first. The newest entry always survives,
 * so a report that says it was trimmed can always be read back whole.
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
  /** Ids that settled before the cancel arrived; their reports stand. */
  finished: string[];
  /** Ids that name no run this delivery has ever seen. */
  unknown: string[];
}

export interface SubagentDelivery {
  /** Take responsibility for a started run's report. */
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
  /**
   * The pushed report for this run has entered the conversation. Pushed is
   * not landed: pi holds a follow-up while the model is mid-turn, and the
   * run stays listed — "done, waiting to report" — until this confirms the
   * model can actually see the report. Unknown ids are ignored.
   */
  reportLanded(id: string): void;
  /**
   * The turn ended aborted. Pi's interactive host clears its queued messages
   * on the operator's interrupt, and a pushed report riding that queue is
   * discarded with it — it will never land. This snapshots what was pushed
   * and unlanded at the abort, so `agentSettled` can push it again.
   */
  turnAborted(): void;
  /**
   * The agent settled after its run. Pi drains any queued messages that
   * survived — it continues the run for them — before it settles, so a
   * report that was unlanded at the abort and is *still* unlanded now is
   * provably gone, not merely queued: push it again. Without a preceding
   * abort this is a no-op, and a report that landed between the abort and
   * the settle drops out, so the retry cannot double-deliver.
   */
  agentSettled(): void;
  /**
   * The session is over: stop everything still running, mark every
   * undelivered run delivered so no notice follows the operator into the
   * next session, and clear result store — a report belongs to the conversation
   * that asked for it.
   */
  shutdown(): void;
  /** What a run said, whole, after it has been delivered. */
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
  const awaitingLanding = new Map<string, PushedNotification>();
  let unlandedAtAbort: string[] = [];
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

  const notify = (id: string, result: SingleResult): void => {
    const notification: PushedNotification = {
      id,
      agent: result.agent,
      status: result.lifecycle.phase,
      text: formatNotification(id, result),
    };
    awaitingLanding.set(id, notification);
    safePush(notification);
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
          const notification: PushedNotification = {
            id,
            agent: "unknown",
            status: "failed",
            text: `Subagent run ${id} ended unexpectedly: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
          awaitingLanding.set(id, notification);
          safePush(notification);
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

    reportLanded(id) {
      if (!awaitingLanding.delete(id)) return;
      runs.release(id);
    },

    turnAborted() {
      unlandedAtAbort = [...awaitingLanding.keys()];
    },

    agentSettled() {
      const dropped = unlandedAtAbort;
      unlandedAtAbort = [];
      for (const id of dropped) {
        const notification = awaitingLanding.get(id);
        if (notification) safePush(notification);
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
      for (const id of awaitingLanding.keys()) runs.release(id);
      pending.clear();
      awaitingLanding.clear();
      unlandedAtAbort = [];
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
 * caller reports, not an error, and the run it was waiting on is still alive.
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
