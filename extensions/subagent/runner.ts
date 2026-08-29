/**
 * The dispatcher. It enforces depth, owns the run record, and settles
 * lifecycle state. Backend policy is supplied by the selected harness; this
 * module never branches on a backend.
 */

import { createControlGate } from "./control-mailbox.ts";
import type { HarnessRegistry } from "./harnesses/contract.ts";
import type { ParentModel, RunEnding, SubagentTask } from "./run.ts";
import {
  createEmptyResult,
  createRunReporter,
  DEPTH_ENV_KEY,
  settleResultLifecycle,
} from "./run.ts";
import type { SubagentRuns } from "./runs.ts";
import {
  type AgentConfig,
  DEFAULT_HARNESS_NAME,
  type SingleResult,
} from "./types.ts";

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

export interface RunSubagentOptions {
  config: AgentConfig;
  description: string;
  prompt: string;
  signal?: AbortSignal;
  parentModel?: ParentModel;
  projectTrusted?: boolean;
  cwd?: string;
  /** Harness resolution is the only backend decision in the dispatcher. */
  harnesses: HarnessRegistry;
  runs: SubagentRuns;
  now?: () => number;
}

/** A run that has started, named before it has finished. */
export interface StartedSubagent {
  /** Registry id, available immediately to the caller. */
  readonly id: string;
  readonly settled: Promise<SingleResult>;
}

export function startSubagent({
  config,
  description,
  prompt,
  signal,
  parentModel,
  projectTrusted = false,
  cwd = process.cwd(),
  harnesses,
  runs,
  now = Date.now,
}: RunSubagentOptions): StartedSubagent {
  const currentDepth = getSubagentDepth();
  assertSubagentDepthAvailable(currentDepth);

  const harnessName = config.harness ?? DEFAULT_HARNESS_NAME;
  const selectedHarness = harnesses.get(harnessName);
  if (!selectedHarness) {
    throw new Error(`No harness registered for '${harnessName}'`);
  }

  const result = createEmptyResult(
    config.name,
    description,
    now(),
    selectedHarness.name,
  );
  const task: SubagentTask = {
    config,
    description,
    prompt,
    cwd,
    childDepth: currentDepth + 1,
    projectTrusted,
  };
  const prepared = selectedHarness.prepare(task, parentModel);
  if (prepared.model) result.model = prepared.model;
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
          task,
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
