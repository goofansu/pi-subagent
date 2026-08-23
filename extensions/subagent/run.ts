/**
 * The run contract: everything the dispatcher hands a child run, and the
 * result bookkeeping both sides share.
 *
 * `runner.ts` owns the rules that hold for every run — the nesting guard,
 * lifecycle transitions and progress plumbing — and
 * `pi-agent.ts` owns the child pi process itself. This module is what they
 * agree on, and the seam tests substitute a stand-in executor at.
 */

import type {
  AgentConfig,
  SingleResult,
  TerminalLifecycleStatus,
} from "./types.ts";

/**
 * Environment variable carrying the subagent nesting depth. The dispatcher
 * reads it and the executor must pass `depth + 1` to its child, so it belongs
 * to neither one alone.
 */
export const DEPTH_ENV_KEY = "PI_SUBAGENT_DEPTH";

/**
 * Cap on captured child stderr, in characters.
 *
 * A failing child can emit without bound — a retry loop, a stack trace per
 * line — and this is one string on the parent's heap with no backpressure
 * behind it, so an unbounded capture is a way for a noisy subagent to take the
 * whole pi process down. The tail is what diagnoses a crash anyway: the last
 * thing said before the exit is what explains it.
 */
const STDERR_CAPTURE_LIMIT = 64 * 1024;

const STDERR_TRUNCATION_MARKER = "[... earlier stderr dropped ...]\n";

/** Append a stderr chunk, keeping at most {@link STDERR_CAPTURE_LIMIT}. */
export function appendStderr(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= STDERR_CAPTURE_LIMIT) return combined;
  // Slicing the tail drops any marker already at the front, so re-prefixing
  // leaves exactly one however many times this runs.
  return (
    STDERR_TRUNCATION_MARKER +
    combined.slice(
      combined.length - STDERR_CAPTURE_LIMIT + STDERR_TRUNCATION_MARKER.length,
    )
  );
}

/** The message an aborted run reports. */
const ABORTED_MESSAGE = "Subagent was aborted";

/**
 * Record that a result was cancelled by the host.
 *
 * The dispatcher separately settles the lifecycle state and finish timestamp.
 *
 * Cancellation is a resolved result rather than a rejection — see
 * {@link SubagentExecutor}. The distinction is not cosmetic: the host turns a
 * thrown tool error into an error string with no `details` attached, so
 * rejecting discards the partial transcript the run had already produced and a
 * cancelled agent renders as a bare message instead of the work it got through.
 *
 * The message is replaced rather than defaulted. A frame can report an error the
 * child then recovered from, and leaving it in place makes a cancelled run name
 * a cause that is not what ended it. The cancellation is what ended it, and the
 * transcript still holds the rest.
 */
export function settleAborted(result: SingleResult): void {
  result.exitCode = 1;
  result.stopReason = "aborted";
  result.errorMessage = ABORTED_MESSAGE;
}

/** Derive one terminal lifecycle state from the recorded outcome fields. */
function terminalStatus(result: SingleResult): TerminalLifecycleStatus {
  if (result.stopReason === "aborted") return "aborted";
  if (result.exitCode === 0 && result.stopReason !== "error")
    return "completed";
  return "failed";
}

/**
 * Settle lifecycle state after a run resolves. The executor owns its exit-code
 * and stop-reason translation; the dispatcher calls this once so lifecycle
 * semantics and finish timestamps live in a single place.
 */
export function settleResultLifecycle(
  result: SingleResult,
  finishedAt: number,
): void {
  if (result.status !== "running") {
    throw new Error(
      `Cannot settle a subagent result in '${result.status}' state`,
    );
  }
  result.status = terminalStatus(result);
  result.finishedAt = finishedAt;
}

/** The caller's model, used when an agent profile does not pin one. */
export interface ParentModel {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

/** Everything needed to run one agent once. */
export interface SubagentTask {
  /** The resolved agent profile. The executor must not mutate it. */
  readonly config: AgentConfig;
  readonly description: string;
  readonly prompt: string;
  /** Working directory for the child. */
  readonly cwd: string;
  readonly parentModel?: ParentModel;
  /** Depth of the *parent*; children must run at `depth + 1`. */
  readonly depth: number;
  /**
   * Pi's project-trust decision for `cwd`, as resolved by the session that is
   * delegating. Forwarded so the child reaches the same answer instead of
   * re-deriving one it cannot: a child runs non-interactively, so it can
   * neither prompt nor see a session-only decision.
   */
  readonly projectTrusted: boolean;
}

/**
 * A run in progress. `result` is pre-initialized by the dispatcher and mutated
 * in place by the executor; `emit` publishes the current snapshot to the TUI.
 */
export interface SubagentRun {
  readonly task: SubagentTask;
  readonly result: SingleResult;
  readonly emit: () => void;
  readonly signal?: AbortSignal;
}

/**
 * Run the task to completion, mutating `run.result` and calling `run.emit` as
 * output arrives. Rejects only when the run could not be represented as a
 * result at all — an aborted or failed agent is a resolved `SingleResult` with
 * a non-zero `exitCode`. See {@link settleAborted} for why cancellation in
 * particular must resolve.
 */
export type SubagentExecutor = (run: SubagentRun) => Promise<SingleResult>;

export function createEmptyResult(
  agent: string,
  description: string,
  startedAt: number,
): SingleResult {
  return {
    agent,
    description,
    status: "running",
    startedAt,
    exitCode: -1, // -1 = pending
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}
