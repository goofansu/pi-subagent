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

import { getFinalOutput } from "./messages.ts";
import type { SubagentRuns } from "./runs.ts";
import { subagentRuns } from "./runs.ts";
import type { LifecycleStatus, SingleResult } from "./types.ts";

/**
 * Cap on a pushed report, in characters.
 *
 * A backstop, not a budget. A report arrives uninvited, so a runaway agent
 * that returns a whole file should not be able to swamp the parent's context —
 * but a thorough agent's genuine answer must never be cut, because there is
 * nowhere to recover the rest from: the run is released the moment it is
 * delivered, and there is deliberately no tool to fetch a report twice. Set it
 * high enough that only the pathological case reaches it.
 */
export const REPORT_CHARACTER_LIMIT = 24_000;

/**
 * Cap on the reason a failed run reports.
 *
 * Tighter than a report, and kept from the *end* rather than the beginning: a
 * failure's diagnosis is the last thing said before it died, which is the same
 * reason `appendStderr` keeps the tail.
 */
export const FAILURE_REASON_LIMIT = 4_000;

/** A report on its way to the model, with what a renderer needs to show it. */
export interface PushedReport {
  id: string;
  agent: string;
  status: LifecycleStatus;
  /** The message text the model reads. Capped; see the limits above. */
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
 */
export interface RetainedReport {
  id: string;
  agent: string;
  status: LifecycleStatus;
  /** The run's full final output, untrimmed. */
  output: string;
}

export interface DeliveryOptions {
  push: PushMessage;
  runs?: SubagentRuns;
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
   * The session is over: stop everything still running, mark every
   * undelivered run delivered so no notice follows the operator into the
   * next session, and clear retention — a report belongs to the conversation
   * that asked for it.
   */
  shutdown(): void;
  /** What a run said, whole, after it has been delivered. */
  recall(id: string): RetainedReport | undefined;
}

/**
 * Keep the head, and say what was dropped.
 *
 * Naming the shortfall matters more than the trim: a report that just stops
 * reads like a report that finished, and a model will act on it as though it
 * were whole.
 */
function keepHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}\n\n[... ${dropped} more characters dropped; this report is incomplete ...]`;
}

/** Keep the tail, for text whose end is the part that explains it. */
function keepTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `[... ${dropped} earlier characters dropped ...]\n${text.slice(-limit)}`;
}

/** Everything a run said, before any cap is applied. */
export function fullOutput(result: SingleResult): string {
  if (result.status === "aborted") return "";
  if (result.status === "failed") {
    return (
      result.errorMessage || result.stderr || getFinalOutput(result.messages)
    );
  }
  return getFinalOutput(result.messages).trim();
}

/** The report text for one settled run. */
export function formatReport(id: string, result: SingleResult): string {
  const name = `${result.agent} (${id})`;

  if (result.status === "aborted") {
    return `Subagent ${name} was cancelled before it finished.`;
  }
  if (result.status === "failed") {
    const reason =
      result.errorMessage || result.stderr || getFinalOutput(result.messages);
    return `Subagent ${name} failed: ${
      reason ? keepTail(reason, FAILURE_REASON_LIMIT) : "no reason reported"
    }`;
  }

  const output = getFinalOutput(result.messages).trim();
  if (!output) return `Subagent ${name} finished without output.`;

  return `Subagent ${name} finished:\n\n${keepHead(output, REPORT_CHARACTER_LIMIT)}`;
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

  /** Keep the run's whole answer addressable by id for `recall`. */
  const retain = (entry: Pending, result: SingleResult): void => {
    retained.set(entry.id, {
      id: entry.id,
      agent: result.agent,
      status: result.status,
      output: fullOutput(result),
    });
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
    runs.release(entry.id);
    if (!entry.result) return;

    const result = entry.result;
    // Retained before the cap is applied, so what `agent_result` returns is
    // the run's whole answer rather than the copy that fitted in a message.
    retain(entry, result);

    if (!byPush) return;
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
