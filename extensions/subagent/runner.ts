/**
 * The dispatcher. It enforces the nesting depth guard, holds every run to the
 * concurrency cap, settles lifecycle state, and plumbs progress updates — the
 * rules that apply to a subagent run whatever it does.
 */

import type { ReleaseSlot, SubagentLimiter } from "./concurrency.ts";
import { QueueAbortedError, subagentLimiter } from "./concurrency.ts";
import { getFinalOutput } from "./messages.ts";
import { runPiAgent } from "./pi-agent.ts";
import type { ParentModel, SubagentExecutor, SubagentTask } from "./run.ts";
import {
  createEmptyResult,
  DEPTH_ENV_KEY,
  markResultRunning,
  settleAborted,
  settleResultLifecycle,
} from "./run.ts";
import type { AgentConfig, OnUpdateCallback, SingleResult } from "./types.ts";

const MAX_SUBAGENT_DEPTH = 1;

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
  onUpdate?: OnUpdateCallback;
  cwd?: string;
  /** Injected for tests; defaults to running the agent in a child pi. */
  execute?: SubagentExecutor;
  /** Injected for tests; defaults to the process-wide cap. */
  limiter?: SubagentLimiter;
  /** Injected for deterministic lifecycle timestamps in tests. */
  now?: () => number;
}

export async function runSubagent({
  config,
  description,
  prompt,
  signal,
  parentModel,
  projectTrusted = false,
  onUpdate,
  cwd = process.cwd(),
  execute = runPiAgent,
  limiter = subagentLimiter,
  now = Date.now,
}: RunSubagentOptions): Promise<SingleResult> {
  const currentDepth = getSubagentDepth();
  assertSubagentDepthAvailable(currentDepth);

  const result = createEmptyResult(config.name, description, now());
  if (config.effort) result.effort = config.effort;

  const task: SubagentTask = {
    config,
    description,
    prompt,
    cwd,
    depth: currentDepth,
    projectTrusted,
    ...(parentModel ? { parentModel } : {}),
  };

  const emit = () => {
    if (!onUpdate) return;
    const emptyOutput =
      result.status === "queued"
        ? "(queued...)"
        : result.status === "running"
          ? "(running...)"
          : result.status === "aborted"
            ? "(aborted)"
            : "(no output)";
    onUpdate({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || emptyOutput,
        },
      ],
      details: { results: [result] },
    });
  };

  // Report the run before it may have to wait. The cap means a fan-out wider
  // than four leaves agents queued with no child running yet, and nothing
  // else would put a row on screen for them.
  emit();

  let release: ReleaseSlot;
  try {
    release = await limiter.acquire(signal);
  } catch (cause) {
    // Cancelled while waiting for a slot. That is a cancelled run like any
    // other — resolved, not thrown — and its child never started.
    if (cause instanceof QueueAbortedError) {
      settleAborted(result);
      settleResultLifecycle(result, now());
      emit();
      return result;
    }
    throw cause;
  }

  try {
    markResultRunning(result, now());
    emit();
    const settled = await execute({ task, result, emit, signal });
    settleResultLifecycle(settled, now());
    emit();
    return settled;
  } finally {
    release();
  }
}
