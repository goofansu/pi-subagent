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
 * A push is not the end of the story: while the model is mid-turn, pi parks
 * the report in its follow-up queue, and the operator's interrupt clears that
 * queue — the report would never enter the conversation. So a pushed report is
 * kept until it lands, and `turnAborted`/`agentSettled` re-push what an
 * interrupt threw away. One *landing* per run is the invariant the retry
 * preserves; the push itself may have to happen more than once.
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
  status: LifecycleStatus;
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
  push: PushMessage;
  runs?: SubagentRuns;
  /** Injected for tests; defaults to {@link RESULT_STORE_CHARACTER_BUDGET}. */
  resultBudget?: number;
}

export interface WaitOutcome {
  /** Reports for runs that settled, in the order they were asked for. */
  reports: string[];
  /** Which runs those reports came from, for the collapsed result line. */
  collected: Array<{ id: string; agent: string; status: LifecycleStatus }>;
  /** Ids still running when the wait gave up. Empty unless it timed out. */
  stillRunning: string[];
  /** Ids whose reports were delivered before this wait; `result` has them. */
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
   * are still results once they settle, so `result` can answer for them.
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
  resultBudget = RESULT_STORE_CHARACTER_BUDGET,
}: DeliveryOptions): SubagentDelivery {
  const pending = new Map<string, Pending>();
  const results = new Map<string, RetainedResult>();
  /**
   * Runs cancelled by the model, delivered by that tool result but not yet
   * settled — the child is still dying. Membership means "write result store
   * when the settle arrives, push nothing". Keyed by id so the id keeps
   * answering while the child dies — a cancel, wait, or result in that
   * window must not call the run one that never existed. A shutdown empties
   * the map so a child that dies after the session cannot write into the
   * next one's result store.
   */
  const inlineDelivered = new Map<string, Pending>();
  /**
   * Reports pushed but not yet entered into the conversation, kept whole so
   * they can be pushed again if an interrupt clears them out of pi's queue.
   * Their runs stay in the registry so the widget keeps showing them; the
   * landing signal — `reportLanded`, wired to the message actually joining
   * the session — lets the registry drop them.
   */
  const awaitingLanding = new Map<string, PushedReport>();
  /**
   * What was pushed and unlanded when the turn aborted. The interrupt that
   * aborted the turn is the one thing that discards queued reports, and only
   * what was already pushed by then can have been in the queue it cleared —
   * anything pushed later either lands through pi's queue-draining
   * continuation or starts a turn of its own.
   */
  let unlandedAtAbort: string[] = [];

  /**
   * Evict the oldest whole outputs until result store fits its budget. The
   * entries stay — id, agent, status — so an evicted run still answers
   * rather than reading like an id that never existed; only the heavy string
   * goes. The newest entry is never evicted: the report that just landed is
   * the one whose trim note points here.
   */
  const enforceResultStoreBudget = (): void => {
    let total = 0;
    for (const report of results.values()) total += report.output.length;
    const ids = [...results.keys()];
    const newest = ids.at(-1);
    for (const id of ids) {
      if (total <= resultBudget || id === newest) break;
      const report = results.get(id);
      if (!report?.output) continue;
      total -= report.output.length;
      results.set(id, { ...report, output: "", evicted: true });
    }
  };

  /** Keep the run's whole answer addressable by id for `result`. */
  const storeResult = (entry: Pending, result: SingleResult): void => {
    results.set(entry.id, {
      id: entry.id,
      agent: result.agent,
      status: result.lifecycle.phase,
      output: fullOutput(result),
    });
    enforceResultStoreBudget();
  };

  /**
   * Push without letting a throw escape. Delivery runs inside promise chains
   * nothing else awaits, so a push that throws — a session torn down between
   * settle and delivery — would surface as an unhandled rejection and take pi
   * down with it. The bookkeeping has already run by the time push is called,
   * and the report stays resultable through `result`, so swallowing here loses
   * nothing that result store does not keep.
   */
  const safePush: PushMessage = (report) => {
    try {
      push(report);
    } catch {
      // Result storage still holds the run's whole output.
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
    if (!byPush) {
      // A wait returns the report through its tool result, which enters the
      // conversation with the call itself — landed by construction.
      runs.release(entry.id);
      return;
    }

    // Pushed is not landed: pi holds a follow-up while the model is mid-turn.
    // The run stays in the registry until `reportLanded` confirms the message
    // joined the conversation, so the widget never drops a run whose report
    // the model has not seen. The report itself is kept so `agentSettled`
    // can push it again if an interrupt clears it out of pi's queue.
    const output = fullOutput(result);
    const text = formatReport(entry.id, result);
    const report: PushedReport = {
      id: entry.id,
      agent: result.agent,
      status: result.lifecycle.phase,
      text,
      truncated: !text.includes(output) && output.length > 0,
    };
    awaitingLanding.set(entry.id, report);
    safePush(report);
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
          // Shutdown removes both owners before children finish dying, so a
          // late settle cannot leak a result into the next session.
          if (pending.get(id) === entry || inlineDelivered.get(id) === entry) {
            storeResult(entry, entry.result);
          }
        } catch (error: unknown) {
          // The executor contract says a failed run resolves; a rejection is a
          // bug, and swallowing it would leave a row on screen forever.
          const alreadyDelivered = entry.delivered;
          entry.delivered = true;
          inlineDelivered.delete(id);
          pending.delete(id);
          runs.release(id);
          if (alreadyDelivered) return;
          const notice: PushedReport = {
            id,
            agent: "unknown",
            status: "failed",
            text: `Subagent run ${id} ended unexpectedly: ${
              error instanceof Error ? error.message : String(error)
            }`,
            truncated: false,
          };
          // Landing-tracked like any push, so an interrupt cannot silently
          // swallow the one notice that says the run died.
          awaitingLanding.set(id, notice);
          safePush(notice);
          return;
        }
        // Delivered before it settled — a run the model cancelled. Its tool
        // result already said so; all that is left is to make the outcome
        // resultable.
        if (entry.delivered) {
          inlineDelivered.delete(entry.id);
          return;
        }
        // A claimed run is the waiter's to deliver.
        if (entry.claims === 0) deliver(entry, true);
      })();
    },

    // A cancelled run whose child is still dying is not a stranger: its id
    // keeps answering until result store takes over at the settle.
    has: (id) => pending.has(id) || inlineDelivered.has(id),

    async wait(ids, options = {}) {
      // Deduplicated so an id named twice is one claim and one report, and
      // classified so the caller can tell a typo from a report it already has.
      const claimed: Pending[] = [];
      const alreadyDelivered: string[] = [];
      const unknown: string[] = [];
      for (const id of new Set(ids)) {
        const entry = pending.get(id);
        if (entry) claimed.push(entry);
        // A cancelled run still dying was delivered by its cancel's tool
        // result; calling it unknown would tell the model the id never
        // existed.
        else if (results.has(id) || inlineDelivered.has(id))
          alreadyDelivered.push(id);
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
            status: entry.result.lifecycle.phase,
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
        // Still unlanded now that the queues are drained: the interrupt threw
        // it away. Landed in the meantime — pi's continuation injected the
        // surviving queue — and it drops out here instead of doubling.
        const report = awaitingLanding.get(id);
        if (report) safePush(report);
      }
    },

    cancel(ids) {
      const requested = [...new Set(ids)];
      const cancelled = runs.cancel(requested);
      for (const id of cancelled) {
        const entry = pending.get(id);
        if (!entry) continue;
        // This tool result is the delivery; the settle callback writes
        // result store when the child actually dies.
        entry.delivered = true;
        pending.delete(id);
        runs.release(id);
        inlineDelivered.set(id, entry);
      }

      const finished: string[] = [];
      const unknown: string[] = [];
      for (const id of requested) {
        if (cancelled.includes(id)) continue;
        // Cancelled before and still dying: the cancel is idempotent, not a
        // report of an id that never existed.
        if (inlineDelivered.has(id)) {
          cancelled.push(id);
          continue;
        }
        // Settled but undelivered, or already resultable: either way the run
        // beat the cancel and its report stands.
        if (pending.has(id) || results.has(id)) finished.push(id);
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
      // Every undelivered run is marked delivered so nothing pushes into the
      // next session, and released so the registry starts the next session
      // empty. A child that settles after this finds its entry delivered and
      // no longer results-on-settle, so it writes nothing anywhere.
      for (const entry of pending.values()) {
        entry.delivered = true;
        runs.release(entry.id);
      }
      // Reports pushed but never landed — the session ended with them still
      // queued. Their runs are terminal; the registry drops them now rather
      // than listing them into a conversation that will never see them.
      for (const id of awaitingLanding.keys()) runs.release(id);
      awaitingLanding.clear();
      unlandedAtAbort = [];
      pending.clear();
      inlineDelivered.clear();
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
