/**
 * How deep in a delegation chain this process is.
 *
 * The depth travels from a parent to its children in one environment
 * variable, set on the Bash spawns a Pi child performs. It is the contract
 * between the adapter that sets it and the entry point that reads it, so the
 * key and both halves of the contract live here.
 *
 * The parent's own process is depth 0. A child a Subagent spawns is depth 1,
 * and a child of *that* would be depth 2 — which admission rejects, because
 * delegation is one level deep.
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
