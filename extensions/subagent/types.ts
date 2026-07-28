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
export const HARNESSES = ["pi", "claude"] as const;
export type Harness = (typeof HARNESSES)[number];

export const DEFAULT_HARNESS: Harness = "pi";

/**
 * Harness names from the multi-backend design that this version recognizes but
 * cannot run yet. Naming them explicitly turns a future-facing agent file into
 * a clear diagnostic instead of a generic "unknown harness".
 */
export const PLANNED_HARNESSES = ["codex"] as const;

/**
 * Backend-neutral reasoning depth. Backends map this onto their own knob:
 * pi onto a model thinking level, Claude Code onto its effort setting.
 */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

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
   * The harness's own session identifier, when it keeps one. Claude Code
   * persists a transcript per session, so this is what makes a finished
   * subagent run inspectable with `claude -r <sessionId>`. The pi harness runs
   * with `--no-session` and reports none.
   */
  sessionId?: string;
  /**
   * Directory the subagent ran in. Recorded because Claude Code resolves
   * sessions per project directory, so reopening one requires being there.
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
   * `provider/id:effort`, or `inherit`. Effort rides here rather than in a field
   * of its own — see the README. Kept whole: each backend maps the effort onto a
   * different knob, so splitting is theirs to do.
   */
  model?: string;
  /** pi only: a claude subagent runs Claude Code's own tool set. */
  tools?: string;
  /** pi only: a claude subagent manages its own skills. */
  skills?: string[];
  appendSystemPrompt?: boolean;
  systemPrompt: string;
  source?: AgentSource;
}

/** The harness an agent runs on, resolving the documented default. */
export function resolveHarness(config: AgentConfig): Harness {
  return config.harness ?? DEFAULT_HARNESS;
}

export type OnUpdateCallback = (
  partial: AgentToolResult<SubagentDetails>,
) => void;

// biome-ignore lint/suspicious/noExplicitAny: theme.fg uses ThemeColor which is narrower than string
export type ThemeForeground = (color: any, text: string) => string;
