/**
 * The Dispatcher owns each Run record and settles lifecycle state. Admission
 * policy and adapter lifetime belong to the Subagent manager; this module
 * never branches on a backend.
 */

import { createControlGate } from "./control-source.ts";
import type { HarnessAdapter, HarnessRun } from "./harnesses/contract.ts";
import type { RunEnding, SubagentTask } from "./run.ts";
import {
  createEmptyResult,
  createRunReporter,
  DEPTH_ENV_KEY,
  settleResultLifecycle,
} from "./run.ts";
import type { SubagentRuns } from "./runs.ts";
import type { SingleResult } from "./types.ts";

const MAX_SUBAGENT_DEPTH = 1;

export function getSubagentDepth(): number {
  const depth = parseInt(process.env[DEPTH_ENV_KEY] || "0", 10);
  return Number.isNaN(depth) ? 0 : depth;
}

export function assertSubagentDepthAvailable(currentDepth: number): void {
  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `Subagent nesting depth ${currentDepth} reached the limit of ${MAX_SUBAGENT_DEPTH}. ` +
        "Subagents cannot spawn other subagents.",
    );
  }
}

/** A run that has started, named before it has finished. */
export interface StartedSubagent {
  /** Registry Run id, available immediately to the caller. */
  readonly id: string;
  readonly settled: Promise<SingleResult>;
}

/** Inputs for one Run on an adapter whose lifetime is owned elsewhere. */
export interface DispatchSubagentRunOptions {
  subagentId: string;
  agent: string;
  harness: string;
  description: string;
  prompt: string;
  adapter: HarnessAdapter;
  /** A Run already prepared by synchronous Resume admission. */
  preparedRun?: HarnessRun;
  signal?: AbortSignal;
  runs: SubagentRuns;
  now?: () => number;
}

/**
 * Dispatch one Run without owning the prepared Subagent adapter.
 *
 * The Session-scoped manager owns adapter lifetime; this function remains the
 * sole writer of the Run record, fold, Control gate, and terminal lifecycle.
 */
export function dispatchSubagentRun({
  subagentId,
  agent,
  harness,
  description,
  prompt,
  adapter,
  preparedRun,
  signal,
  runs,
  now = Date.now,
}: DispatchSubagentRunOptions): StartedSubagent {
  const result = createEmptyResult(
    agent,
    description,
    now(),
    harness,
    subagentId,
  );
  const task: SubagentTask = { description, prompt };
  const prepared = preparedRun ?? adapter.prepareRun(task);
  if (adapter.model) result.model = adapter.model;
  const controlGate = createControlGate(prepared.supportedControls);
  const controller = new AbortController();
  const abortExecutor = () => controller.abort();
  const handle = runs.track(result, abortExecutor, controlGate);
  const forwardAbort = () => {
    // External and tool-driven cancellation share the Registry's synchronous
    // reason-recording and Control-gate linearization point.
    runs.cancel([handle.id], "requested");
  };
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  const emit = () => handle.changed();
  const report = createRunReporter(result, emit);

  const settled = (async (): Promise<SingleResult> => {
    try {
      emit();
      if (controller.signal.aborted) {
        controlGate.close();
        settleResultLifecycle(
          result,
          { ending: "cancelled" },
          now(),
          handle.cancellationReason(),
        );
        emit();
        return result;
      }

      let ending: RunEnding;
      try {
        ending = await prepared.execute({
          report,
          signal: controller.signal,
          controls: controlGate.controls,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        ending = {
          ending: "failed",
          errorMessage: `Executor failed unexpectedly: ${message}`,
        };
      }
      // Settlement closes admission and drops pending Controls before the
      // lifecycle becomes terminal; neither path waits for queue drainage.
      controlGate.close();
      settleResultLifecycle(result, ending, now(), handle.cancellationReason());
      emit();
      return result;
    } finally {
      controlGate.close();
      signal?.removeEventListener("abort", forwardAbort);
    }
  })();

  return { id: handle.id, settled };
}
