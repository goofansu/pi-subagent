/**
 * The fixed inputs a Subagent's BackendAgent is opened with.
 *
 * Every field is decided once, when the Subagent is created, and none of them
 * changes for the rest of its life. That is why they are here rather than on a
 * Run: a Run cannot move its working directory, change its trust posture, or
 * re-nest itself.
 *
 * These are the same four facts v1 fixes per Subagent, in plain types.
 */

import type { SubagentId } from "./ids.ts";

/** The caller's model policy, inherited when a Profile pins no model. */
export interface ParentModel {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevel?: string;
}

export interface SubagentContext {
  readonly subagentId: SubagentId;
  /** Working directory, fixed for the Subagent's lifetime. */
  readonly cwd: string;
  /** Nesting depth every execution must pass to whatever it spawns. */
  readonly childDepth: number;
  /**
   * The delegating session's project-trust decision for `cwd`.
   *
   * Forwarded rather than re-derived: a child runs non-interactively, so it can
   * neither prompt for trust nor see a session-only decision.
   */
  readonly projectTrusted: boolean;
  readonly parentModel?: ParentModel;
}
