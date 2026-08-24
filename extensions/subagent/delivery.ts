/**
 * Delivery: getting a finished run's report to the model, exactly once.
 *
 * A detached run finishes after the turn that started it has ended, so its
 * report cannot come back as that tool call's return value. It is pushed into
 * the session instead. But `agent_wait` exists for the case where the model
 * cannot continue without an answer, and a report that both pushed and
 * returned would cost the context twice and read as two different findings.
 *
 * So a wait *claims* the runs it names: a claimed run returns through the tool
 * result and does not push. Abandoning the wait — a timeout, a cancelled turn —
 * releases the claim and the run pushes as it normally would. The invariant is
 * one delivery per run, never zero and never two.
 *
 * Cancellation is the third delivery form: `cancel`'s outcome is the delivery
 * for the runs it stops, and `shutdown` delivers everything left by cancelling
 * it, so no notice follows the operator into the next session.
 *
 * See docs/adr/0002-push-only-result-delivery.md.
 */

import { formatReport, fullOutput } from "./presentation.ts";
import type { SubagentRuns } from "./runs.ts";
import { subagentRuns } from "./runs.ts";
import type { LifecycleStatus, SingleResult } from "./types.ts";

/** A report on its way to the model, with what a renderer needs to show it. */
export interface PushedReport {
  id: string;
  agent: string;
  status: LifecycleStatus;
  /** The message text the model reads. Capped; see `presentation.ts`. */
  text: string;
  /** Whether the text is shorter than what the run actually said. */
  truncated: boolean;
}

/** Push a report into the session. Narrowed from `ExtensionAPI`. */
export type PushMessage = (report: PushedReport) => void;

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
  push: PushMessage;
  /** Aim at a live session. */
  bind(push: PushMessage): void;
  /** Drop the target; reports that settle before the next bind are dropped. */
  unbind(): void;
}

export function createSessionPush(): SessionPush {
  let live: PushMessage | null = null;

  const push: PushMessage = (report) => {
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
 * work that had already been paid for. Retention keeps the whole thing
 * addressable by id, so `agent_result` can hand back what the cap left out.
 *
 * The invariant is delivered ⇒ recallable, for the session that asked:
 * `shutdown` clears retention, because a report belongs to the conversation
 * that asked for it and the next session's model never started these runs.
 * Within a session, whole outputs are held only up to a budget — see
 * {@link RETENTION_CHARACTER_BUDGET} — and an entry whose output was evicted
 * still answers, saying so.
 */
export interface RetainedReport {
  id: string;
  agent: string;
  status: LifecycleStatus;
  /** The run's full final output, untrimmed. Empty once evicted. */
  output: string;
  /** True when the output was dropped to keep retention under budget. */
  evicted?: boolean;
}

/**
 * Cap on the total characters retention holds across all runs.
 *
 * Retention keeps every delivered run's whole output in memory for the rest
 * of the session, and nothing else bounds it — a long session of large
 * reports would grow without limit. This is a backstop against that, not a
 * working budget: it is roughly eighty reports at the pushed-report cap, and
 * eviction takes the oldest outputs first. The newest entry always survives,
 * so a report that says it was trimmed can always be read back whole.
 */
export const RETENTION_CHARACTER_BUDGET = 2_000_000;

export interface DeliveryOptions {
  push: PushMessage;
  runs?: SubagentRuns;
  /** Injected for tests; defaults to {@link RETENTION_CHARACTER_BUDGET}. */
  retentionBudget?: number;
}

export interface WaitOutcome {
  /** Reports for runs that settled, in the order they were asked for. */
  reports: string[];
  /** Which runs those reports came from, for the collapsed result line. */
  collected: Array<{ id: string; agent: string; status: LifecycleStatus }>;
  /** Ids still running when the wait gave up. Empty unless it timed out. */
  stillRunning: string[];
  /** Ids whose reports were delivered before this wait; `recall` has them. */
  alreadyDelivered: string[];
  /** Ids that name no run this delivery has ever seen. */
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
  /** Whether this id names a run still awaiting delivery. */
  has(id: string): boolean;
  /**
   * Claim and await the named runs. Unknown ids are reported as delivered
   * already, since a run leaves the registry the moment its report lands.
   */
  wait(
    ids: readonly string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<WaitOutcome>;
  /**
   * Stop the named runs and mark the stopped ones delivered, suppressing
   * their push: the model asked, so the answer belongs in the answer to its
   * request rather than in a message of its own. The stopped runs' outcomes
   * are still retained once they settle, so `recall` can answer for them.
   */
  cancel(ids: readonly string[]): CancelOutcome;
  /**
   * The pushed report for this run has entered the conversation. Pushed is
   * not landed: pi holds a follow-up while the model is mid-turn, and the
   * run stays listed — "done, waiting to report" — until this confirms the
   * model can actually see the report. Unknown ids are ignored.
   */
  reportLanded(id: string): void;
  /**
   * The session is over: stop everything still running, mark every
   * undelivered run delivered so no notice follows the operator into the
   * next session, and clear retention — a report belongs to the conversation
   * that asked for it.
   */
  shutdown(): void;
  /** What a run said, whole, after it has been delivered. */
  recall(id: string): RetainedReport | undefined;
}

interface Pending {
  id: string;
  /**
   * Resolves once `result` has been recorded and the unclaimed-push decision
   * has been made. Waiters await this rather than the raw settle promise: both
   * would otherwise be woken by the same resolution, and a waiter that ran
   * first would find `result` not yet assigned and call a finished run
   * unfinished.
   */
  tracked: Promise<void>;
  result?: SingleResult;
  claims: number;
  delivered: boolean;
}

export function createSubagentDelivery({
  push,
  runs = subagentRuns,
  retentionBudget = RETENTION_CHARACTER_BUDGET,
}: DeliveryOptions): SubagentDelivery {
  const pending = new Map<string, Pending>();
  const retained = new Map<string, RetainedReport>();
  /**
   * Runs cancelled by the model, delivered by that tool result but not yet
   * settled — the child is still dying. Membership means "write retention
   * when the settle arrives, push nothing". A shutdown empties the set so a
   * child that dies after the session cannot write into the next one's
   * retention.
   */
  const inlineDelivered = new Set<Pending>();
  /**
   * Runs whose reports were pushed but have not yet entered the conversation.
   * Their runs stay in the registry so the widget keeps showing them; the
   * landing signal — `reportLanded`, wired to the message actually joining
   * the session — lets the registry drop them.
   */
  const awaitingLanding = new Set<string>();

  /**
   * Evict the oldest whole outputs until retention fits its budget. The
   * entries stay — id, agent, status — so an evicted run still answers
   * rather than reading like an id that never existed; only the heavy string
   * goes. The newest entry is never evicted: the report that just landed is
   * the one whose trim note points here.
   */
  const enforceRetentionBudget = (): void => {
    let total = 0;
    for (const report of retained.values()) total += report.output.length;
    const ids = [...retained.keys()];
    const newest = ids.at(-1);
    for (const id of ids) {
      if (total <= retentionBudget || id === newest) break;
      const report = retained.get(id);
      if (!report?.output) continue;
      total -= report.output.length;
      retained.set(id, { ...report, output: "", evicted: true });
    }
  };

  /** Keep the run's whole answer addressable by id for `recall`. */
  const retain = (entry: Pending, result: SingleResult): void => {
    retained.set(entry.id, {
      id: entry.id,
      agent: result.agent,
      status: result.status,
      output: fullOutput(result),
    });
    enforceRetentionBudget();
  };

  /**
   * Push without letting a throw escape. Delivery runs inside promise chains
   * nothing else awaits, so a push that throws — a session torn down between
   * settle and delivery — would surface as an unhandled rejection and take pi
   * down with it. The bookkeeping has already run by the time push is called,
   * and the report stays recallable through `recall`, so swallowing here loses
   * nothing that retention does not keep.
   */
  const safePush: PushMessage = (report) => {
    try {
      push(report);
    } catch {
      // Retention still holds the run's whole output.
    }
  };

  /**
   * Hand the report over, once. Whoever gets here first wins; every later
   * caller is a no-op, which is what makes the one-delivery rule hold under
   * a wait that times out at the same moment its run settles.
   */
  const deliver = (entry: Pending, byPush: boolean): void => {
    if (entry.delivered) return;
    entry.delivered = true;
    pending.delete(entry.id);
    if (!entry.result) {
      runs.release(entry.id);
      return;
    }

    const result = entry.result;
    // Retained before the cap is applied, so what `agent_result` returns is
    // the run's whole answer rather than the copy that fitted in a message.
    retain(entry, result);

    if (!byPush) {
      // A wait returns the report through its tool result, which enters the
      // conversation with the call itself — landed by construction.
      runs.release(entry.id);
      return;
    }

    // Pushed is not landed: pi holds a follow-up while the model is mid-turn.
    // The run stays in the registry until `reportLanded` confirms the message
    // joined the conversation, so the widget never drops a run whose report
    // the model has not seen.
    awaitingLanding.add(entry.id);
    const output = fullOutput(result);
    const text = formatReport(entry.id, result);
    safePush({
      id: entry.id,
      agent: result.agent,
      status: result.status,
      text,
      truncated: !text.includes(output) && output.length > 0,
    });
  };

  return {
    register(id, settled) {
      const entry: Pending = {
        id,
        tracked: Promise.resolve(),
        claims: 0,
        delivered: false,
      };
      pending.set(id, entry);

      entry.tracked = (async () => {
        try {
          entry.result = await settled;
        } catch (error: unknown) {
          // The executor contract says a failed run resolves; a rejection is a
          // bug, and swallowing it would leave a row on screen forever.
          const alreadyDelivered = entry.delivered;
          entry.delivered = true;
          inlineDelivered.delete(entry);
          pending.delete(id);
          runs.release(id);
          if (alreadyDelivered) return;
          safePush({
            id,
            agent: "unknown",
            status: "failed",
            text: `Subagent run ${id} ended unexpectedly: ${
              error instanceof Error ? error.message : String(error)
            }`,
            truncated: false,
          });
          return;
        }
        // Delivered before it settled — a run the model cancelled. Its tool
        // result already said so; all that is left is to make the outcome
        // recallable.
        if (entry.delivered) {
          if (inlineDelivered.delete(entry)) retain(entry, entry.result);
          return;
        }
        // A claimed run is the waiter's to deliver.
        if (entry.claims === 0) deliver(entry, true);
      })();
    },

    has: (id) => pending.has(id),

    async wait(ids, options = {}) {
      // Deduplicated so an id named twice is one claim and one report, and
      // classified so the caller can tell a typo from a report it already has.
      const claimed: Pending[] = [];
      const alreadyDelivered: string[] = [];
      const unknown: string[] = [];
      for (const id of new Set(ids)) {
        const entry = pending.get(id);
        if (entry) claimed.push(entry);
        else if (retained.has(id)) alreadyDelivered.push(id);
        else unknown.push(id);
      }
      for (const entry of claimed) entry.claims++;

      try {
        const all = Promise.all(claimed.map((entry) => entry.tracked));
        await withDeadline(all, options);

        const reports: string[] = [];
        const collected: WaitOutcome["collected"] = [];
        const stillRunning: string[] = [];
        for (const entry of claimed) {
          if (!entry.result) {
            stillRunning.push(entry.id);
            continue;
          }
          reports.push(formatReport(entry.id, entry.result));
          collected.push({
            id: entry.id,
            agent: entry.result.agent,
            status: entry.result.status,
          });
          deliver(entry, false);
        }
        return { reports, collected, stillRunning, alreadyDelivered, unknown };
      } finally {
        // Releasing last is what lets an abandoned wait fall back to a push:
        // any run that settled while unclaimed is delivered here instead.
        for (const entry of claimed) {
          entry.claims--;
          if (entry.claims === 0 && entry.result) deliver(entry, true);
        }
      }
    },

    recall: (id) => retained.get(id),

    reportLanded(id) {
      if (!awaitingLanding.delete(id)) return;
      runs.release(id);
    },

    cancel(ids) {
      const requested = [...new Set(ids)];
      const cancelled = runs.cancel(requested);
      for (const id of cancelled) {
        const entry = pending.get(id);
        if (!entry) continue;
        // This tool result is the delivery; the settle callback writes
        // retention when the child actually dies.
        entry.delivered = true;
        pending.delete(id);
        runs.release(id);
        inlineDelivered.add(entry);
      }

      const finished: string[] = [];
      const unknown: string[] = [];
      for (const id of requested) {
        if (cancelled.includes(id)) continue;
        // Settled but undelivered, or already recallable: either way the run
        // beat the cancel and its report stands.
        if (pending.has(id) || retained.has(id)) finished.push(id);
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
      );
      // Every undelivered run is marked delivered so nothing pushes into the
      // next session, and released so the registry starts the next session
      // empty. A child that settles after this finds its entry delivered and
      // no longer retained-on-settle, so it writes nothing anywhere.
      for (const entry of pending.values()) {
        entry.delivered = true;
        runs.release(entry.id);
      }
      // Reports pushed but never landed — the session ended with them still
      // queued. Their runs are terminal; the registry drops them now rather
      // than listing them into a conversation that will never see them.
      for (const id of awaitingLanding) runs.release(id);
      awaitingLanding.clear();
      pending.clear();
      inlineDelivered.clear();
      retained.clear();
    },
  };
}

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
      timeoutMs === undefined ? undefined : setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
    void work.then(finish, finish);
  });
}
