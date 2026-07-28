/**
 * How many subagents may run at once.
 *
 * The dispatcher runs one agent per call, but the host executes a turn's tool
 * calls concurrently unless a tool declares itself sequential — so a parent that
 * emits five `subagent` calls in one turn starts five children at once, each a
 * full harness process with its own model traffic. Nothing in the tool shape
 * bounds that, which is why the bound lives here.
 *
 * The cap is process-wide rather than per-call: it exists to protect local
 * resources, and those are shared by every run in flight.
 */

/**
 * The default cap. Four is enough for the fan-out a parallel fan-out is
 * actually for while staying inside what one machine can host — each slot is a
 * child harness process, not a coroutine.
 */
export const MAX_CONCURRENT_SUBAGENTS = 4;

/** Thrown by {@link SubagentLimiter.acquire} when the caller gave up waiting. */
export class QueueAbortedError extends Error {
  constructor() {
    super("Subagent was cancelled while waiting for a concurrency slot");
    this.name = "QueueAbortedError";
  }
}

/** Release a held slot. Calling it more than once is a no-op. */
export type ReleaseSlot = () => void;

export interface SubagentLimiter {
  readonly limit: number;
  /** Slots currently held. */
  active(): number;
  /** Callers waiting for a slot. */
  queued(): number;
  /**
   * Take a slot, waiting when the limit is reached. Rejects with
   * {@link QueueAbortedError} if `signal` aborts first — a cancelled run must
   * leave the queue rather than start later for nobody.
   */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot>;
}

interface Waiter {
  admit: () => void;
  reject: (cause: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createSubagentLimiter(
  limit: number = MAX_CONCURRENT_SUBAGENTS,
): SubagentLimiter {
  let active = 0;
  const waiting: Waiter[] = [];

  const detach = (waiter: Waiter): void => {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  };

  const release = (): void => {
    const next = waiting.shift();
    if (!next) {
      active--;
      return;
    }
    // The slot is handed straight over rather than freed and re-taken, so a
    // waiter cannot lose it to an acquire that arrives in between.
    detach(next);
    next.admit();
  };

  /**
   * A release that only counts once. The dispatcher releases in a `finally`,
   * and a second call would free a slot this run never held — admitting two
   * children into one slot and quietly breaking the cap.
   */
  const takeSlot = (): ReleaseSlot => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };

  return {
    limit,
    active: () => active,
    queued: () => waiting.length,
    async acquire(signal?: AbortSignal): Promise<ReleaseSlot> {
      if (signal?.aborted) throw new QueueAbortedError();
      if (active < limit) {
        active++;
        return takeSlot();
      }
      await new Promise<void>((admit, reject) => {
        const waiter: Waiter = { admit, reject, ...(signal ? { signal } : {}) };
        if (signal) {
          waiter.onAbort = () => {
            const index = waiting.indexOf(waiter);
            if (index !== -1) waiting.splice(index, 1);
            reject(new QueueAbortedError());
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        waiting.push(waiter);
      });
      return takeSlot();
    },
  };
}

/** The process-wide cap every dispatch shares. */
export const subagentLimiter: SubagentLimiter = createSubagentLimiter();
