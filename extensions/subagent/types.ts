import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  description: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  results: SingleResult[];
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export type AgentSource = "default" | "user";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string;
  systemPrompt: string;
  source?: AgentSource;
}

export type OnUpdateCallback = (
  partial: AgentToolResult<SubagentDetails>,
) => void;

// biome-ignore lint/suspicious/noExplicitAny: theme.fg uses ThemeColor which is narrower than string
export type ThemeForeground = (color: any, text: string) => string;
