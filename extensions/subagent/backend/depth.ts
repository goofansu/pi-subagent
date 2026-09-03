/**
 * How deep in a delegation chain this process is, in one environment variable.
 *
 * The key lives in the backend module rather than in an adapter because the
 * **Depth** constraint binds every backend, not one of them: delegation is one
 * level deep whichever backend ran the parent, and a Bash-launched grandchild
 * has to read the same variable whichever adapter set it. Two adapters each
 * spelling their own constant would be two places for the two to drift, and
 * the drift would only show up as a grandchild that started at depth zero.
 *
 * The parent's own process is depth 0. A child a Subagent spawns is depth 1,
 * and a child of *that* would be depth 2 — which admission rejects.
 *
 * A missing or unparsable value reads as 0. That is deliberate: a parent
 * launched by hand has no such variable, and a garbled one is far more likely
 * to be an unrelated environment than a real nesting the guard should trust.
 */

/** The environment variable carrying the child depth. Shared with v1. */
export const DEPTH_ENV_KEY = "PI_SUBAGENT_DEPTH";

/** What a process's environment looks like, as much as this module needs. */
export type DepthEnvironment = Readonly<Record<string, string | undefined>>;

/** The depth this process is running at. Zero unless something said so. */
export function readChildDepth(env: DepthEnvironment = process.env): number {
  const parsed = Number.parseInt(env[DEPTH_ENV_KEY] ?? "0", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}
