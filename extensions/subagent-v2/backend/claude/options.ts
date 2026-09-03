/**
 * The fixed native policy one Claude Query is started with.
 *
 * Ported from v1, decision for decision, because every one of them was
 * arrived at by running children for real:
 *
 * - **The operator's environment is inherited.** `settingSources` and
 *   `mcpServers` are deliberately *omitted*, which is what makes the SDK load
 *   the operator's own settings and expose their MCP servers and cloud
 *   connectors to the child. That is the feature being bought — different
 *   backends exist to bring different toolsets to the work — and it is
 *   [ADR-0008](../../../../docs/adr/0008-claude-children-inherit-operator-environment.md).
 * - **The process environment is spread, not replaced.** The SDK's `env`
 *   *replaces* the subprocess environment entirely rather than merging into
 *   it, so a bare depth variable would strip the child of `PATH`, the
 *   operator's credentials, and everything else the inheritance is for.
 * - **The depth variable closes the other half of the Depth constraint.**
 *   `disallowedTools` stops the SDK spawning an agent in-process; the depth
 *   key stops a Bash-launched grandchild Pi from starting at depth zero. Both
 *   halves are needed because the two escapes are different escapes.
 * - **`Agent` and `Task` are always disallowed**, whatever a Profile's `tools`
 *   says, because delegation is one level deep.
 * - **Permissions are bypassed unconditionally.** A child runs
 *   non-interactively and cannot prompt, so a permission gate would be a
 *   child that hangs rather than a child that is safe.
 * - **The system prompt is the Claude Code preset with the Profile's appended**
 *   unless the Profile explicitly opted out, in which case the Profile's
 *   prompt replaces it. That is the shared `appendSystemPrompt` rule.
 *
 * Everything here is a pure function of its arguments plus `process.env`.
 * Nothing performs provider I/O, reads a file, or mutates the environment: the
 * parent is a long-lived Pi process, and a mutated environment would outlive
 * the Run that wanted it.
 */

import type { Profile, SubagentContext } from "../../domain/index.ts";
import { DEPTH_ENV_KEY } from "../depth.ts";
import { parseTools, shouldAppendSystemPrompt } from "../profile-fields.ts";
import type { Options } from "./query.ts";

/** The two tools a child may never have, whatever its Profile says. */
export const CLAUDE_DISALLOWED_TOOLS = ["Agent", "Task"] as const;

/**
 * The thinking budget each effort buys, in tokens.
 *
 * v1's table, unchanged. The shared effort scale is seven words and this maps
 * six of them; `off` disables thinking outright rather than buying a budget of
 * zero, because a zero budget and no extended thinking are different requests.
 */
export const CLAUDE_THINKING_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 512,
  low: 1_024,
  medium: 4_096,
  high: 8_192,
  xhigh: 16_384,
  max: 32_768,
};

/** The efforts the SDK's own `effort` parameter accepts. */
export const CLAUDE_EFFORT_LEVELS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The thinking configuration one effort buys.
 *
 * Three answers, and the third is why this is a function rather than a lookup:
 * no effort at all leaves the SDK's own default, `off` disables extended
 * thinking explicitly, and anything else buys a budget — defaulting to the
 * high one rather than omitting the setting, because an effort the Profile
 * asked for should not silently become no effort.
 */
export function claudeThinking(
  effort: string | undefined,
): Options["thinking"] {
  if (effort === undefined) return undefined;
  if (effort === "off") return { type: "disabled" };
  return {
    type: "enabled",
    budgetTokens:
      CLAUDE_THINKING_BUDGETS[effort] ?? CLAUDE_THINKING_BUDGETS.high,
  };
}

/** The SDK's `effort` parameter, for the values it understands. */
export function claudeEffort(effort: string | undefined): {
  effort?: NonNullable<Options["effort"]>;
} {
  if (effort === undefined || !CLAUDE_EFFORT_LEVELS.includes(effort)) return {};
  return { effort: effort as NonNullable<Options["effort"]> };
}

/** What the child's environment is, without touching the parent's. */
export function claudeChildEnvironment(
  childDepth: number,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  env[DEPTH_ENV_KEY] = String(childDepth);
  return env;
}

/** The system prompt the child runs with, per the shared append rule. */
export function claudeSystemPrompt(profile: Profile): Options["systemPrompt"] {
  return shouldAppendSystemPrompt(profile)
    ? { type: "preset", preset: "claude_code", append: profile.systemPrompt }
    : profile.systemPrompt;
}

export interface ClaudeOptionsInput {
  readonly profile: Profile;
  readonly subagent: SubagentContext;
  /** The family alias, lowercased, as validation accepted it. */
  readonly model?: string;
  readonly effort?: string;
  /** The execution's own controller. One per Run, owned by the execution. */
  readonly abort: NonNullable<Options["abortController"]>;
  /** The retained conversation identity, on a resumed Run. */
  readonly resume?: string;
  /** Where the SDK's own diagnostics go, to be confined at the end. */
  readonly stderr?: (data: string) => void;
  /** The process environment to inherit. Supplied by a test. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Build the options one Run's Query is started with.
 *
 * Per Run rather than per Subagent, because two of the fields are Run-scoped:
 * the abort controller the execution owns, and the continuation a resumed Run
 * attaches with. Everything else is fixed for the Subagent's life and is
 * recomputed here rather than cached, because building this is free.
 */
export function createClaudeOptions(input: ClaudeOptionsInput): Options {
  const tools = parseTools(input.profile);
  return {
    cwd: input.subagent.cwd,
    ...(input.model === undefined ? {} : { model: input.model }),
    abortController: input.abort,
    thinking: claudeThinking(input.effort),
    ...claudeEffort(input.effort),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...CLAUDE_DISALLOWED_TOOLS],
    env: claudeChildEnvironment(input.subagent.childDepth, input.env),
    ...(tools === undefined ? {} : { tools }),
    systemPrompt: claudeSystemPrompt(input.profile),
    ...(input.resume === undefined ? {} : { resume: input.resume }),
    ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
  };
}
