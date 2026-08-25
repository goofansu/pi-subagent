import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Fact } from "./run.ts";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

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

/** The shared seven-value effort scale used by every harness. */
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

/** A generic profile: only the common fields are interpreted by core. */
export interface AgentConfig {
  name: string;
  description: string;
  /** Profiles default to pi; optional keeps programmatic stand-ins concise. */
  harness?: string;
  /** Every frontmatter field other than description and harness. */
  readonly fields?: Readonly<Record<string, unknown>>;
  systemPrompt: string;
  /** Opaque programmatic profile fields; parsed profiles use `fields`. */
  readonly [field: string]: unknown;
}

export interface SingleResult {
  agent: string;
  description: string;
  lifecycle: Lifecycle;
  /** Epoch milliseconds when the run's child was spawned. */
  startedAt: number;
  messages: Fact[];
  stderr: string;
  usage: UsageStats;
  /** Display-only activity derived from the most recent tool call. */
  activity?: string;
  model?: string;
  effort?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Live session facts inherited by runs started through registered tools. */
export interface SessionContext {
  cwd: string;
  projectTrusted: boolean;
}

/** Status colours presentation may select. */
export type Tone = "warning" | "success" | "error";

/** The shared host-theme surface used by every subagent renderer. */
export type RenderableTheme = Pick<Theme, "fg" | "bg" | "bold">;
