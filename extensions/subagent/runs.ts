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
 * A run lives here from the moment it starts until its report is delivered.
 * Delivery is the point at which the result has entered the conversation, so
 * the registry's job — showing work that is otherwise invisible — is done, and
 * the transcript holds it from then on.
 */

import type { LifecycleStatus, SingleResult } from "./types.ts";

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
   * Drop a run whose report has reached the model. Unknown ids are ignored,
   * so a caller never has to check whether it already released one.
   */
  release(id: string): void;
  /** Stop the named runs. Returns the ids that were actually cancelled. */
  cancel(ids: readonly string[]): string[];
  /** Called on every change. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** How many runs are tracked, terminal ones included. */
  size(): number;
}

interface TrackedRun {
  id: string;
  result: SingleResult;
  cancel: () => void;
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

  const project = (run: TrackedRun): RunView => {
    const { result } = run;
    const end = result.finishedAt ?? clock.now();
    return {
      id: run.id,
      agent: result.agent,
      description: result.description,
      status: result.status,
      elapsedMs: Math.max(0, end - result.startedAt),
      cost: result.usage.cost,
      // Recorded by the dispatcher's fold as messages arrive; the registry
      // never looks inside a transcript.
      ...(result.activity ? { activity: result.activity } : {}),
    };
  };

  return {
    track(result, cancel) {
      // Short ids can collide; a collision would silently orphan the run
      // already tracked under the id, so draw again instead.
      let id = generateId();
      while (runs.has(id)) id = generateId();
      runs.set(id, { id, result, cancel });
      notify();

      return {
        id,
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

    cancel(ids) {
      const cancelled: string[] = [];
      for (const id of ids) {
        const run = runs.get(id);
        // Cancelling a run that already settled is a no-op, not an error: the
        // caller raced the run and lost, which is not a failure of theirs.
        if (!run || isTerminal(run.result.status)) continue;
        run.cancel();
        cancelled.push(id);
      }
      if (cancelled.length > 0) notify();
      return cancelled;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    size: () => runs.size,
  };
}

/** The process-wide registry every dispatch reports to. */
export const subagentRuns: SubagentRuns = createSubagentRuns();
