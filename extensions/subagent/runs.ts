/**
 * The run registry: the set of subagent runs that exist right now.
 *
 * A run used to exist only as a `SingleResult` closed over by one dispatcher
 * call and pushed at one consumer, the host's tool renderer. Nothing could
 * enumerate runs, so nothing else could show them. This module owns that set
 * instead, and everything that displays or acts on runs reads it. The
 * dispatcher is the only module that adds runs; the delivery module is the
 * only one that releases them.
 *
 * A run lives here from start until its completion notification lands. At that
 * point the conversation names the run and the registry's display job is done.
 */

import type {
  CancellationReason,
  LifecycleStatus,
  SingleResult,
} from "./types.ts";

/** An immutable row derived from a run. Callers never see the live record. */
export interface RunView {
  id: string;
  agent: string;
  description: string;
  status: LifecycleStatus;
  /**
   * Milliseconds from start to now, or to settlement once finished. Display
   * reads it only once a run settles; nothing redraws to keep it moving.
   */
  elapsedMs: number;
  cost: number;
  /**
   * What the run is doing right now, derived from its most recent tool call.
   * Absent until the child's first tool call. Display only.
   */
  activity?: string;
}

/** The dispatcher's write access to one tracked run. */
export interface RunHandle {
  readonly id: string;
  /** Why cancellation was first requested, if it was. */
  cancellationReason(): CancellationReason | undefined;
  /** Publish this run's current state to subscribers. */
  changed(): void;
}

/** Time, injected so tests need no real clock. */
export interface RegistryClock {
  now(): number;
}

export const systemClock: RegistryClock = {
  now: () => Date.now(),
};

export interface SubagentRuns {
  /**
   * Put a run under the registry's care. `cancel` is whatever stops this
   * particular run; the registry calls it and does not care how it works.
   */
  track(result: SingleResult, cancel: () => void): RunHandle;
  /** Every tracked run, projected for display. */
  list(): readonly RunView[];
  /**
   * Drop a run whose notification has reached the model. Unknown ids are ignored,
   * so a caller never has to check whether it already released one.
   */
  release(id: string): void;
  /** Stop the named runs. Returns the ids that were actually cancelled. */
  cancel(ids: readonly string[], reason?: CancellationReason): string[];
  /** Stop every running run without querying the display projection. */
  cancelRunning(reason: CancellationReason): string[];
  /** Called on every change. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

interface TrackedRun {
  id: string;
  result: SingleResult;
  cancel: () => void;
  cancellationReason?: CancellationReason;
}

function isTerminal(status: LifecycleStatus): boolean {
  return status !== "running";
}

function shortId(): string {
  return globalThis.crypto.randomUUID().slice(0, 8);
}

export function createSubagentRuns(
  clock: RegistryClock = systemClock,
  generateId: () => string = shortId,
): SubagentRuns {
  const runs = new Map<string, TrackedRun>();
  // Releasing a run removes it from display, but its identity remains spent:
  // callers may still hold or mention that id for the rest of the session.
  const issuedIds = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      // Notify runs inside child-process stream callbacks, where an uncaught
      // throw kills the whole pi process. One broken or stale listener — a
      // widget whose session has since been torn down — must not do that, nor
      // stop the listeners after it from hearing the change.
      try {
        listener();
      } catch {
        // Display-only subscribers; there is nowhere useful to report this.
      }
    }
  };

  const cancel = (
    ids: readonly string[],
    reason: CancellationReason,
  ): string[] => {
    const cancelled: string[] = [];
    for (const id of ids) {
      const run = runs.get(id);
      // Cancelling a run that already settled is a no-op, not an error: the
      // caller raced the run and lost, which is not a failure of theirs.
      if (
        !run ||
        run.cancellationReason !== undefined ||
        isTerminal(run.result.lifecycle.phase)
      )
        continue;
      // Record before forwarding the abort: settlement can run from the
      // callback, and must observe the reason that caused it.
      run.cancellationReason = reason;
      run.cancel();
      cancelled.push(id);
    }
    if (cancelled.length > 0) notify();
    return cancelled;
  };

  const project = (run: TrackedRun): RunView => {
    const { result } = run;
    const end =
      result.lifecycle.phase === "running"
        ? clock.now()
        : result.lifecycle.finishedAt;
    return {
      id: run.id,
      agent: result.agent,
      description: result.description,
      status: result.lifecycle.phase,
      elapsedMs: Math.max(0, end - result.startedAt),
      cost: result.usage.cost,
      // Recorded by the dispatcher's fold as messages arrive; the registry
      // never looks inside a transcript.
      ...(result.activity ? { activity: result.activity } : {}),
    };
  };

  return {
    track(result, cancel) {
      // Short ids can collide. An id remains unavailable after release because
      // run identity is stable for the whole session, not merely while live.
      let id = generateId();
      while (issuedIds.has(id)) id = generateId();
      issuedIds.add(id);
      runs.set(id, { id, result, cancel });
      notify();

      return {
        id,
        cancellationReason: () => runs.get(id)?.cancellationReason,
        changed() {
          notify();
        },
      };
    },

    release(id) {
      if (!runs.delete(id)) return;
      notify();
    },

    list() {
      return [...runs.values()].map(project);
    },

    cancel: (ids, reason = "requested") => cancel(ids, reason),

    cancelRunning(reason) {
      return cancel(
        [...runs.values()]
          .filter((run) => run.result.lifecycle.phase === "running")
          .map((run) => run.id),
        reason,
      );
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The process-wide registry every dispatch reports to. */
export const subagentRuns: SubagentRuns = createSubagentRuns();
