/**
 * The backend seam. One `SubagentBackend` per execution harness (Pi, Claude
 * Code, or Codex), each turning the same `SubagentTask`
 * into the same normalized `SingleResult` the tool result and TUI already read.
 *
 * Backends own everything harness-specific: process or SDK lifecycle, argument
 * and option mapping, permission and skill wiring, and the translation of
 * native events into pi `Message`s. Everything harness-neutral — agent
 * resolution, the nesting depth guard, skill path resolution, and progress
 * plumbing — stays in the dispatcher so it cannot drift between backends.
 */

import type { AgentConfig, Harness, SingleResult } from "./types.ts";

/**
 * Environment variable carrying the subagent nesting depth. The guard is
 * harness-neutral: the dispatcher reads it and every backend must pass
 * `depth + 1` to its child, so it lives here rather than in any one backend.
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
export const STDERR_CAPTURE_LIMIT = 64 * 1024;

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

/** The message an aborted run reports, kept identical across every harness. */
export const ABORTED_MESSAGE = "Subagent was aborted";

/**
 * Settle a result as cancelled by the host.
 *
 * Cancellation is a resolved result rather than a rejection — see `run` below.
 * The distinction is not cosmetic: the host turns a thrown tool error into an
 * error string with no `details` attached, so rejecting discards the partial
 * transcript the run had already produced and a cancelled agent renders as a
 * bare message instead of the work it got through.
 *
 * The message is replaced rather than defaulted. A frame can report an error the
 * harness then recovered from — an `overloaded` that a retry cleared — and
 * leaving it in place makes a cancelled run say `Agent aborted: Claude Code
 * reported overloaded`, naming a cause that is not what ended it. The
 * cancellation is what ended it, and the transcript still holds the rest.
 */
export function settleAborted(result: SingleResult): void {
  result.exitCode = 1;
  result.stopReason = "aborted";
  result.errorMessage = ABORTED_MESSAGE;
}

/** The caller's model, used when an agent inherits instead of pinning one. */
export interface ParentModel {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

/** Everything a backend needs to run one agent once. */
export interface SubagentTask {
  /** The resolved agent profile. Backends must not mutate it. */
  readonly config: AgentConfig;
  readonly description: string;
  readonly prompt: string;
  /** Working directory for the child. */
  readonly cwd: string;
  /** Pi's agent directory, used for user-scope resource lookups. */
  readonly agentDir: string;
  /** Directory that owns agent and skill configuration (often === cwd). */
  readonly configCwd: string;
  readonly parentModel?: ParentModel;
  /** Depth of the *parent*; children must run at `depth + 1`. */
  readonly depth: number;
  /**
   * Whether pi trusts `cwd`. Backends that load configuration from disk must
   * gate it on this, so delegating never grants a directory more than working in
   * it already did. Absent means unknown, which every backend treats as
   * untrusted.
   */
  readonly projectTrusted?: boolean;
  /**
   * Resolved SKILL.md paths. `undefined` means the agent declared no skills and
   * the backend may use its native discovery; an array means this extension
   * owns the skill set exactly.
   */
  readonly skillPaths?: string[];
}

/**
 * A run in progress. `result` is pre-initialized by the dispatcher and mutated
 * in place by the backend; `emit` publishes the current snapshot to the TUI.
 */
export interface SubagentRunContext {
  readonly task: SubagentTask;
  readonly result: SingleResult;
  readonly emit: () => void;
  readonly signal?: AbortSignal;
}

export interface SubagentBackend {
  readonly name: Harness;
  /**
   * Whether this backend can run at all (binary on PATH, SDK importable).
   * Used for diagnostics; `run` is still responsible for its own errors.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Run the task to completion, mutating `ctx.result` and calling `ctx.emit`
   * as output arrives. Rejects only when the run could not be represented as a
   * result at all — an aborted or failed agent is a resolved `SingleResult`
   * with a non-zero `exitCode`. See {@link settleAborted} for why cancellation
   * in particular must resolve.
   */
  run(ctx: SubagentRunContext): Promise<SingleResult>;
}

export type BackendRegistry = ReadonlyMap<Harness, SubagentBackend>;

export function createBackendRegistry(
  backends: readonly SubagentBackend[],
): BackendRegistry {
  return new Map(backends.map((backend) => [backend.name, backend]));
}

export function resolveBackend(
  registry: BackendRegistry,
  harness: Harness,
): SubagentBackend {
  const backend = registry.get(harness);
  if (!backend) {
    throw new Error(
      `No backend registered for harness '${harness}'. Registered: ${[...registry.keys()].join(", ") || "none"}`,
    );
  }
  return backend;
}

export function createEmptyResult(
  agent: string,
  description: string,
  harness: Harness,
): SingleResult {
  return {
    agent,
    description,
    harness,
    exitCode: -1, // -1 = running
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
