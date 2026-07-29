import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
  /**
   * Set when the run never reported its own token totals, which makes `output`
   * meaningless rather than merely incomplete.
   *
   * A harness reports totals once, at the end. Until then the running figure is
   * assembled from per-response frames, and on Claude Code a live frame's
   * `output_tokens` is a placeholder backfilled later — measured at 4 against a
   * true 667. A run cut short (cancelled, or whose stream died) never
   * gets the frame that would replace it, so the count must be withheld rather
   * than printed in the same shape as an exact one.
   *
   * Only `output` is affected: prompt-side counts settle before generation and
   * are genuinely accumulated, just missing whatever request was in flight.
   *
   * Absent means the totals are trustworthy — which is also what every result
   * persisted before this field existed means.
   */
  outputUnreported?: boolean;
}

/** Execution backends an agent profile can select. */
export const HARNESSES = ["pi", "claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const DEFAULT_HARNESS: Harness = "pi";
export const DEFAULT_APPEND_SYSTEM_PROMPT = true;

/**
 * Backend-neutral reasoning depth. Backends map this onto their own knob:
 * pi onto a model thinking level, Claude Code onto its effort setting.
 */
export const EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type Effort = (typeof EFFORTS)[number];

export interface SingleResult {
  agent: string;
  description: string;
  /** Backend that produced this result. */
  harness: Harness;
  /** -1 while running, 0 on success, non-zero on failure. */
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /**
   * The harness's own session/thread identifier, when it keeps one. This makes
   * a finished external-harness run inspectable with `claude -r <sessionId>` or
   * `codex resume <sessionId>`. The pi harness runs with `--no-session` and
   * reports none.
   */
  sessionId?: string;
  /**
   * Directory the subagent ran in. Recorded so a resume hint restores the same
   * project context before reopening the external-harness session.
   */
  cwd?: string;
}

export interface SubagentDetails {
  results: SingleResult[];
}

/**
 * A result as it comes back out of a persisted session. Results written before
 * the harness field existed carry none, and every one of those was a pi run —
 * so an omitted harness means {@link DEFAULT_HARNESS}.
 */
export type PersistedSingleResult = Omit<SingleResult, "harness"> & {
  harness?: Harness;
};

export interface PersistedSubagentDetails {
  results: PersistedSingleResult[];
}

/** Restore the harness an older persisted result was written without. */
export function resolveResultHarness(
  result: PersistedSingleResult,
): SingleResult {
  if (result.harness) return result as SingleResult;
  return { ...result, harness: DEFAULT_HARNESS };
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export type AgentSource = "default" | "package" | "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  /** Execution backend. Omitted means {@link DEFAULT_HARNESS}. */
  harness?: Harness;
  /**
   * The model id, handed to the harness exactly as written — no provider
   * stripping, no suffix parsing. `inherit` is the one reserved value.
   */
  model?: string;
  /** Reasoning depth. Independent of `model`; every harness takes it separately. */
  effort?: Effort;
  /** pi only: external harnesses run their own tool sets. */
  tools?: string;
  /** pi only: external harnesses manage their own skills. */
  skills?: string[];
  /** Append to native instructions. Omitted means the shared default. */
  appendSystemPrompt?: boolean;
  systemPrompt: string;
  source?: AgentSource;
}

/** The harness an agent runs on, resolving the documented default. */
export function resolveHarness(config: AgentConfig): Harness {
  return config.harness ?? DEFAULT_HARNESS;
}

/** Whether to append an agent prompt, resolving the documented default. */
export function resolveAppendSystemPrompt(config: AgentConfig): boolean {
  return config.appendSystemPrompt ?? DEFAULT_APPEND_SYSTEM_PROMPT;
}

export type OnUpdateCallback = (
  partial: AgentToolResult<SubagentDetails>,
) => void;

// biome-ignore lint/suspicious/noExplicitAny: theme.fg uses ThemeColor which is narrower than string
export type ThemeForeground = (color: any, text: string) => string;
