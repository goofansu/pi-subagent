/**
 * The run registry: the set of subagent runs that exist right now, and the
 * clock that keeps their elapsed times moving.
 *
 * A run used to exist only as a `SingleResult` closed over by one dispatcher
 * call and pushed at one consumer, the host's tool renderer. Nothing could
 * enumerate runs, so nothing else could show them. This module owns that set
 * instead, and everything that displays or acts on runs reads it. The
 * dispatcher is its only writer.
 *
 * A run lives here from the moment it starts until its report is delivered.
 * Delivery is the point at which the result has entered the conversation, so
 * the registry's job — showing work that is otherwise invisible — is done, and
 * the transcript holds it from then on.
 */

import type { LifecycleStatus, SingleResult } from "./types.ts";

/** How often elapsed times are republished while a run is unfinished. */
export const TICK_INTERVAL_MS = 1_000;

/** An immutable row derived from a run. Callers never see the live record. */
export interface RunView {
  id: string;
  agent: string;
  description: string;
  status: LifecycleStatus;
  /** Milliseconds from start to now, or to settlement once finished. */
  elapsedMs: number;
  /** What the child actually ran as, once it has reported one. */
  model?: string;
  /** Assistant turns the child has taken. Zero until it first speaks. */
  turns: number;
  cost: number;
}

/** The dispatcher's write access to one tracked run. */
export interface RunHandle {
  readonly id: string;
  /** Publish this run's current state to subscribers. */
  changed(): void;
}

/**
 * Time and scheduling, injected so tests need no real clock.
 *
 * `schedule` returns its own cancel rather than a handle, which keeps the
 * registry from knowing whether it is talking to `setInterval`, a fake, or
 * nothing at all.
 */
export interface RegistryClock {
  now(): number;
  schedule(callback: () => void, intervalMs: number): () => void;
}

export const systemClock: RegistryClock = {
  now: () => Date.now(),
  schedule: (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs);
    // A redraw timer must never be the reason the process stays up.
    timer.unref?.();
    return () => clearInterval(timer);
  },
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
  /** Called on every change and on every tick. Returns an unsubscribe. */
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
  let stopTicking: (() => void) | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  /**
   * One interval for every run, alive only while something is unfinished.
   * Elapsed time advances with no state change at all, so a change signal on
   * its own would leave a run that sits silently in one tool call showing a
   * frozen clock.
   */
  const syncTicker = (): void => {
    const needsTicking = [...runs.values()].some(
      (run) => !isTerminal(run.result.status),
    );
    if (needsTicking && !stopTicking) {
      stopTicking = clock.schedule(notify, TICK_INTERVAL_MS);
      return;
    }
    if (!needsTicking && stopTicking) {
      stopTicking();
      stopTicking = null;
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
      ...(result.model ? { model: result.model } : {}),
      turns: result.usage.turns,
      cost: result.usage.cost,
    };
  };

  return {
    track(result, cancel) {
      const id = generateId();
      runs.set(id, { id, result, cancel });
      syncTicker();
      notify();

      return {
        id,
        changed() {
          syncTicker();
          notify();
        },
      };
    },

    release(id) {
      if (!runs.delete(id)) return;
      syncTicker();
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
