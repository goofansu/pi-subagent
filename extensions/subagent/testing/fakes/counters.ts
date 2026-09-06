/**
 * Resource counters for the fake backends.
 *
 * "Every retained resource is released" is not something a test can assert by
 * reading code, and it is exactly the property the Scope hierarchy exists to
 * guarantee. So the fakes count: how many BackendAgents were opened and
 * closed, how many execution scopes, execution fibers, and subscriptions are
 * live right now, and what Controls arrived in what order for which Run.
 *
 * A counter that must return to zero is a leak test that works the same way
 * for a fake and, later, for a real adapter — which is why the shared
 * conformance suite asks for a snapshot of these rather than for anything
 * fake-specific.
 */

import type { RunId } from "../../domain/index.ts";

export interface ResourceCountersSnapshot {
  readonly opens: number;
  readonly closes: number;
  readonly executionsStarted: number;
  /** Executions whose scope has not yet closed. Zero after cleanup. */
  readonly liveExecutions: number;
  /**
   * Execution fibers that have not returned. The fake keeps this distinct
   * from `liveExecutions`, whose execution-scope finalizer can already have
   * run after the runtime abandons the fiber.
   */
  readonly liveExecutionFibers?: number;
  /** Per-execution event subscriptions still attached. Zero after cleanup. */
  readonly liveSubscriptions: number;
  /** Every Control the backend actually received, in delivery order. */
  readonly controlsReceived: readonly string[];
  /** The most Controls the backend ever had in flight at once. */
  readonly maxConcurrentControls: number;
  /** Which Run each Control was delivered to, so a leak is visible. */
  readonly controlsByRun: ReadonlyMap<RunId, readonly string[]>;
}

export interface ResourceCounters {
  snapshot(): ResourceCountersSnapshot;
  opened(): void;
  closed(): void;
  executionStarted(): void;
  executionReleased(): void;
  executionFiberStarted(): void;
  executionFiberReleased(): void;
  subscriptionAcquired(): void;
  subscriptionReleased(): void;
  controlStarted(runId: RunId, text: string): void;
  controlFinished(): void;
}

export function createResourceCounters(): ResourceCounters {
  let opens = 0;
  let closes = 0;
  let executionsStarted = 0;
  let liveExecutions = 0;
  let liveExecutionFibers = 0;
  let liveSubscriptions = 0;
  let concurrentControls = 0;
  let maxConcurrentControls = 0;
  const controlsReceived: string[] = [];
  const controlsByRun = new Map<RunId, string[]>();

  return {
    snapshot: () => ({
      opens,
      closes,
      executionsStarted,
      liveExecutions,
      liveExecutionFibers,
      liveSubscriptions,
      controlsReceived: [...controlsReceived],
      maxConcurrentControls,
      controlsByRun: new Map(
        [...controlsByRun].map(([runId, texts]) => [runId, [...texts]]),
      ),
    }),
    opened: () => {
      opens += 1;
    },
    closed: () => {
      closes += 1;
    },
    executionStarted: () => {
      executionsStarted += 1;
      liveExecutions += 1;
    },
    executionReleased: () => {
      liveExecutions -= 1;
    },
    executionFiberStarted: () => {
      liveExecutionFibers += 1;
    },
    executionFiberReleased: () => {
      liveExecutionFibers -= 1;
    },
    subscriptionAcquired: () => {
      liveSubscriptions += 1;
    },
    subscriptionReleased: () => {
      liveSubscriptions -= 1;
    },
    controlStarted: (runId, text) => {
      concurrentControls += 1;
      maxConcurrentControls = Math.max(
        maxConcurrentControls,
        concurrentControls,
      );
      controlsReceived.push(text);
      const forRun = controlsByRun.get(runId) ?? [];
      forRun.push(text);
      controlsByRun.set(runId, forRun);
    },
    controlFinished: () => {
      concurrentControls -= 1;
    },
  };
}
