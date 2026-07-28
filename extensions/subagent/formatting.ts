import * as os from "node:os";
import { resolveClaudeCommand } from "./backends/claude.ts";
import type { Harness, ThemeForeground, UsageStats } from "./types.ts";
import { DEFAULT_HARNESS } from "./types.ts";

/**
 * Tag a result with the harness that produced it. The default harness is left
 * unlabeled so existing pi-only setups look unchanged.
 */
export function formatHarnessBadge(
  harness: Harness,
  themeFg: ThemeForeground,
): string {
  if (harness === DEFAULT_HARNESS) return "";
  return ` ${themeFg("dim", `[${harness}]`)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  // Withheld rather than shown as a floor: the accumulated figure is a
  // placeholder, not an under-estimate, so there is no honest way to render it.
  // Same treatment `cost` already gets when the run never reported one.
  if (usage.output && !usage.outputUnreported)
    parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * The command that reopens a finished subagent's transcript. Claude Code
 * resolves sessions per project directory, so this only works from the
 * directory the subagent ran in.
 *
 * The executable is resolved rather than assumed: the SDK drives a bundled
 * binary that declares no npm `bin`, so a setup can run claude subagents with
 * nothing named `claude` on PATH, and a hint that assumed otherwise would only
 * ever print "command not found".
 */
export function formatResumeHint(
  result: { harness: Harness; sessionId?: string; cwd?: string },
  currentCwd: string = process.cwd(),
  claudeCommand: string = resolveClaudeCommand(),
): string | undefined {
  if (result.harness !== "claude" || !result.sessionId) return undefined;
  const command = `${shellQuote(claudeCommand)} -r ${result.sessionId}`;
  // Resuming only finds the session from the directory it ran in, so include
  // the hop when that is somewhere else.
  if (result.cwd && result.cwd !== currentCwd) {
    return `(cd ${shellQuote(result.cwd)} && ${command})`;
  }
  return command;
}

/**
 * Single-quote a path for a copy-pasteable shell command. Spaces and shell
 * metacharacters in a project directory would otherwise break the hint.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: ThemeForeground,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  // Backends name the same tools differently ("read" in pi, "Read" in Claude
  // Code) while agreeing on the argument names, so match case-insensitively.
  switch (toolName.toLowerCase()) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview =
        command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg(
          "warning",
          `:${startLine}${endLine ? `-${endLine}` : ""}`,
        );
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return (
        themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
      );
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "glob":
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview =
        argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}
