import type { Message } from "@earendil-works/pi-ai";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Applied when a profile does not say; see {@link resolveAppendSystemPrompt}. */
const DEFAULT_APPEND_SYSTEM_PROMPT = true;

/**
 * Reasoning depth, which pi takes as a thinking level of its own rather than as
 * part of the model id.
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

export type CancellationReason = "requested" | "shutdown";
export type Lifecycle =
  | { phase: "running" }
  | { phase: "completed"; finishedAt: number; exitCode?: number }
  | { phase: "failed"; finishedAt: number; exitCode?: number }
  | {
      phase: "cancelled";
      finishedAt: number;
      exitCode?: number;
      reason: CancellationReason;
    };
export type LifecycleStatus = Lifecycle["phase"];
export type TerminalLifecycleStatus = Exclude<LifecycleStatus, "running">;

export interface SingleResult {
  agent: string;
  description: string;
  lifecycle: Lifecycle;
  /** Epoch milliseconds when the run's child pi was spawned. */
  startedAt: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  /**
   * What the run is doing right now, derived from its most recent tool call
   * as messages fold in. Display only; absent before the first tool call.
   */
  activity?: string;
  model?: string;
  /** Explicit reasoning effort configured by the profile. */
  effort?: Effort;
  stopReason?: string;
  errorMessage?: string;
}

export interface AgentConfig {
  name: string;
  description: string;
  /** Model id, handed to pi exactly as written. */
  model?: string;
  /** Reasoning depth. Independent of `model`; pi takes it separately. */
  effort?: Effort;
  /** Comma-separated pi tool names. Omitted means pi's own defaults. */
  tools?: string;
  /** Append to pi's instructions. Omitted means the shared default. */
  appendSystemPrompt?: boolean;
  systemPrompt: string;
}

/** Whether to append an agent prompt, resolving the documented default. */
export function resolveAppendSystemPrompt(config: AgentConfig): boolean {
  return config.appendSystemPrompt ?? DEFAULT_APPEND_SYSTEM_PROMPT;
}

// biome-ignore lint/suspicious/noExplicitAny: theme.fg uses ThemeColor which is narrower than string
export type ThemeForeground = (color: any, text: string) => string;
