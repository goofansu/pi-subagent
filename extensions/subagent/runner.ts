/**
 * The dispatcher. It enforces the nesting depth guard, owns the run record —
 * the executor reports facts, the fold here writes them — and settles
 * lifecycle state: the rules that apply to a subagent run whatever it does.
 *
 * It deliberately imposes no concurrency cap; see
 * docs/adr/0001-unbounded-subagent-concurrency.md.
 */

import { runPiAgent } from "./pi-agent.ts";
import type {
  ParentModel,
  SubagentExecutor,
  SubagentOutcome,
  SubagentTask,
} from "./run.ts";
import {
  createEmptyResult,
  createRunReporter,
  DEPTH_ENV_KEY,
  settleResultLifecycle,
} from "./run.ts";
import type { SubagentRuns } from "./runs.ts";
import { subagentRuns } from "./runs.ts";
import type { AgentConfig, SingleResult } from "./types.ts";

const MAX_SUBAGENT_DEPTH = 1;

/**
 * Resolve the model id the executor should pass to its harness, if any.
 * Profile policy wins; otherwise the parent session's resolved model flows on.
 */
export function resolveSubagentModel(
  config: AgentConfig,
  parentModel: ParentModel | undefined,
): string | undefined {
  if (config.model) return config.model;
  if (!parentModel) return undefined;
  return `${parentModel.provider}/${parentModel.id}`;
}

/** Resolve the thinking level before the task crosses the executor seam. */
export function resolveSubagentThinking(
  config: AgentConfig,
  parentModel: ParentModel | undefined,
): string | undefined {
  if (config.effort) return config.effort;
  if (config.model) return undefined;
  return parentModel?.thinkingLevel;
}

export function getSubagentDepth(): number {
  const depth = parseInt(process.env[DEPTH_ENV_KEY] || "0", 10);
  return Number.isNaN(depth) ? 0 : depth;
}

export function assertSubagentDepthAvailable(currentDepth: number): void {
  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `Subagent nesting depth ${currentDepth} reached the limit of ${MAX_SUBAGENT_DEPTH}. ` +
        `Subagents cannot spawn other subagents.`,
    );
  }
}

export interface RunSubagentOptions {
  config: AgentConfig;
  description: string;
  prompt: string;
  signal?: AbortSignal;
  parentModel?: ParentModel;
  /**
   * Pi's project-trust decision for `cwd`; unknown is treated as denied.
   */
  projectTrusted?: boolean;
  cwd?: string;
  /** Injected for tests; defaults to running the agent in a child pi. */
  execute?: SubagentExecutor;
  /** Injected for tests; defaults to the process-wide registry. */
  runs?: SubagentRuns;
  /** Injected for deterministic lifecycle timestamps in tests. */
  now?: () => number;
}

/** A run that has started, named before it has finished. */
export interface StartedSubagent {
  /** Registry id, available immediately — this is what `agent_start` returns. */
  readonly id: string;
  readonly settled: Promise<SingleResult>;
}

/**
 * Start a run and return its id without waiting for it.
 *
 * The synchronous part — the depth guard, the result record, the cancellation
 * controller and registration — runs before this returns, which is what lets a
 * fire-and-forget caller name the run it just started.
 */
export function startSubagent({
  config,
  description,
  prompt,
  signal,
  parentModel,
  projectTrusted = false,
  cwd = process.cwd(),
  // Keep this static default while pi is the only harness adapter. A second
  // adapter is the trigger to move default wiring to the composition root.
  execute = runPiAgent,
  runs = subagentRuns,
  now = Date.now,
}: RunSubagentOptions): StartedSubagent {
  const currentDepth = getSubagentDepth();
  assertSubagentDepthAvailable(currentDepth);

  const result = createEmptyResult(config.name, description, now());
  if (config.effort) result.effort = config.effort;
  // The model the run is headed for, before its child has said anything; the
  // fold refines it from each assistant message once the child speaks.
  const resolvedModel = resolveSubagentModel(config, parentModel);
  const resolvedThinking = resolveSubagentThinking(config, parentModel);
  if (resolvedModel) result.model = resolvedModel;

  const task: SubagentTask = {
    config,
    description,
    prompt,
    cwd,
    childDepth: currentDepth + 1,
    projectTrusted,
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(resolvedThinking ? { resolvedThinking } : {}),
  };

  // The host's signal cancels the whole turn. Chaining it onto a controller of
  // this run's own is what lets one run be stopped on its own — by the
  // operator through the registry, or later by the model — without touching
  // the others.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  const handle = runs.track(result, forwardAbort);

  // Progress goes to the registry and from there to whatever is on screen.
  // It cannot go back into the transcript: a detached run's tool-call row is
  // already final by the time its child says anything.
  const emit = () => handle.changed();
  // The executor reports facts; the fold behind this reporter is the only
  // writer of the record, and it emits after every fact it folds.
  const report = createRunReporter(result, emit);

  const settled = (async (): Promise<SingleResult> => {
    try {
      // Put the run on screen before its child has said anything.
      emit();

      // A run cancelled before it starts must not spawn a child at all. The
      // executor would otherwise spawn one and kill it a moment later.
      if (controller.signal.aborted) {
        settleResultLifecycle(
          result,
          { stopReason: "aborted" },
          now(),
          handle.cancellationReason(),
        );
        emit();
        return result;
      }

      let outcome: SubagentOutcome;
      try {
        outcome = await execute({
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
