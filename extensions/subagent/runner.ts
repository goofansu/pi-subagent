/**
 * The dispatcher. It enforces depth, owns the run record, and settles
 * lifecycle state. Backend policy is supplied by the selected harness; this
 * module never branches on a backend.
 */

import type { HarnessRegistry } from "./harness.ts";
import type { ParentModel, SubagentOutcome, SubagentTask } from "./run.ts";
import {
  ABORTED_STOP_REASON,
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
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  const handle = runs.track(result, forwardAbort);
  const emit = () => handle.changed();
  const report = createRunReporter(result, emit);

  const settled = (async (): Promise<SingleResult> => {
    try {
      emit();
      if (controller.signal.aborted) {
        settleResultLifecycle(
          result,
          { stopReason: ABORTED_STOP_REASON },
          now(),
          handle.cancellationReason(),
        );
        emit();
        return result;
      }

      let outcome: SubagentOutcome;
      try {
        outcome = await prepared.execute({
          task,
          report,
          signal: controller.signal,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = {
          stopReason: "error",
          errorMessage: `Executor failed unexpectedly: ${message}`,
        };
      }
      settleResultLifecycle(
        result,
        outcome,
        now(),
        handle.cancellationReason(),
      );
      emit();
      return result;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  })();

  return { id: handle.id, settled };
}
