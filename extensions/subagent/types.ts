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

export const LIFECYCLE_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export type TerminalLifecycleStatus = Exclude<
  LifecycleStatus,
  "queued" | "running"
>;

export interface SingleResult {
  agent: string;
  description: string;
  /** Backend that produced this result. */
  harness: Harness;
  /** Backend-neutral lifecycle state. */
  status: LifecycleStatus;
  /** Epoch milliseconds when the run entered the concurrency queue. */
  queuedAt: number;
  /** Epoch milliseconds when the limiter admitted the run to its backend. */
  startedAt?: number;
  /** Epoch milliseconds when the run reached a terminal state. */
  finishedAt?: number;
  /** -1 while pending, 0 on success, non-zero on failure. */
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  /** Explicit reasoning effort configured by the profile. */
  effort?: Effort;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  results: SingleResult[];
}

/**
 * A result as it comes back out of a persisted session. Older results can omit
 * both the harness (all such runs used pi) and the explicit lifecycle status.
 * Lifecycle timestamps are optional in persisted data because they cannot be
 * truthfully reconstructed for those sessions.
 */
export type PersistedSingleResult = Omit<
  SingleResult,
  "harness" | "status" | "queuedAt"
> & {
  harness?: Harness;
  status?: LifecycleStatus;
  queuedAt?: number;
};

/** A current or restored result; only legacy data can lack its queue time. */
export type ResolvedPersistedResult = Omit<SingleResult, "queuedAt"> & {
  queuedAt?: number;
};

export interface PersistedSubagentDetails {
  results: PersistedSingleResult[];
}

/** Infer the lifecycle state recorded implicitly by an older result. */
export function inferLegacyLifecycleStatus(
  result: Pick<SingleResult, "exitCode" | "stopReason">,
): LifecycleStatus {
  if (result.exitCode === -1) return "running";
  if (result.stopReason === "aborted") return "aborted";
  if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
  return "completed";
}

/** Restore fields omitted from an older persisted result without mutating it. */
export function resolvePersistedResult(
  result: PersistedSingleResult,
): ResolvedPersistedResult {
  if (result.harness && result.status) return result as ResolvedPersistedResult;
  return {
    ...result,
    harness: result.harness ?? DEFAULT_HARNESS,
    status: result.status ?? inferLegacyLifecycleStatus(result),
  };
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export type AgentSource = "user" | "project";

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
