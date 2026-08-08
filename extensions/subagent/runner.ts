/**
 * The harness-neutral dispatcher. It resolves an agent profile to a backend,
 * enforces the nesting depth guard and plumbs progress updates — so those
 * rules cannot drift between backends.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BackendRegistry, ParentModel, SubagentTask } from "./backend.ts";
import {
  createBackendRegistry,
  createEmptyResult,
  DEPTH_ENV_KEY,
  markResultRunning,
  resolveBackend,
  settleAborted,
  settleResultLifecycle,
} from "./backend.ts";
import { claudeBackend } from "./backends/claude.ts";
import { codexBackend } from "./backends/codex.ts";
import { piBackend } from "./backends/pi.ts";
import type { ReleaseSlot, SubagentLimiter } from "./concurrency.ts";
import { QueueAbortedError, subagentLimiter } from "./concurrency.ts";
import { getFinalOutput } from "./messages.ts";
import type { AgentConfig, OnUpdateCallback, SingleResult } from "./types.ts";
import { resolveHarness } from "./types.ts";

const MAX_SUBAGENT_DEPTH = 1;

export const defaultBackendRegistry: BackendRegistry = createBackendRegistry([
  piBackend,
  claudeBackend,
  codexBackend,
]);

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
   * Whether the child may load project-controlled configuration from `cwd`;
   * unknown is treated as denied.
   */
  allowProjectConfig?: boolean;
  onUpdate?: OnUpdateCallback;
  cwd?: string;
  agentDir?: string;
  registry?: BackendRegistry;
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
  allowProjectConfig = false,
  onUpdate,
  cwd = process.cwd(),
  agentDir = getAgentDir(),
  registry = defaultBackendRegistry,
  limiter = subagentLimiter,
  now = Date.now,
}: RunSubagentOptions): Promise<SingleResult> {
  const currentDepth = getSubagentDepth();
  assertSubagentDepthAvailable(currentDepth);

  const harness = resolveHarness(config);
  const backend = resolveBackend(registry, harness);

  const result = createEmptyResult(config.name, description, harness, now());
  if (config.effort) result.effort = config.effort;

  const task: SubagentTask = {
    config,
    description,
    prompt,
    cwd,
    agentDir,
    depth: currentDepth,
    allowProjectConfig,
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
  // than four leaves agents queued with no backend running yet, and nothing
  // else would put a row on screen for them.
  emit();

  let release: ReleaseSlot;
  try {
    release = await limiter.acquire(signal);
  } catch (cause) {
    // Cancelled while waiting for a slot. That is a cancelled run like any
    // other — resolved, not thrown — and its backend never started.
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
    const settled = await backend.run({ task, result, emit, signal });
    settleResultLifecycle(settled, now());
    emit();
    return settled;
  } finally {
    release();
  }
}

// Re-exported for convenience: this module was the single entry point before
// the backend extraction. Note that package consumers cannot reach it — the
// `exports` map publishes only index.ts — so these are for in-tree use.
export type { ParentModel } from "./backend.ts";
export {
  applyPiJsonEvent,
  buildPiArgs,
  getPiInvocation,
  getSpawnOptions,
  resolveSubagentModel,
  writePromptToTempFile,
} from "./backends/pi.ts";
