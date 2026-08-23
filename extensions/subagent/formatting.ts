import * as os from "node:os";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Effort, ThemeForeground, UsageStats } from "./types.ts";

// Tool renderers do not receive the terminal width until the returned
// component renders, so keep the source line conservative and let Text handle
// the remaining wrap on especially narrow terminals. The row renderer prepends
// this arrow, so reserve its columns rather than silently producing 74-column
// "72-column" previews.
export const TOOL_CALL_ARROW_PREFIX = "→ ";
export const COLLAPSED_TOOL_CALL_LINE_WIDTH = 72;
export const COLLAPSED_TOOL_CALL_PREVIEW_WIDTH =
  COLLAPSED_TOOL_CALL_LINE_WIDTH - visibleWidth(TOOL_CALL_ARROW_PREFIX);
// Expanded calls should be useful for ordinary commands without allowing an
// unusually large tool payload to flood the transcript.
export const EXPANDED_TOOL_CALL_PREVIEW_LENGTH = 3 * 1024;

export type ToolCallDisplayMode = "collapsed" | "expanded";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
  usage: UsageStats,
  model?: string,
  effort?: Effort,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  if (effort) parts.push(`effort:${effort}`);
  return parts.join(" ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: ThemeForeground,
  displayMode: ToolCallDisplayMode,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  const argumentText = (value: unknown, fallback: string) => {
    const text = typeof value === "string" && value ? value : fallback;
    return sanitizeInlineText(text);
  };
  const pathArgument = (fallback: string, ...values: unknown[]) => {
    const value = values.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0,
    );
    return sanitizeInlineText(value ?? fallback);
  };
  const displayToolName = sanitizeInlineText(toolName);
  const render = (fragments: ToolCallFragment[]) =>
    renderBoundedFragments(fragments, themeFg, displayMode);

  switch (toolName) {
    case "bash": {
      const rawCommand =
        typeof args.command === "string" && args.command ? args.command : "...";
      const command =
        displayMode === "collapsed"
          ? normalizeWhitespace(rawCommand)
          : rawCommand;
      return render([
        { color: "muted", text: "$ " },
        { color: "toolOutput", text: command },
      ]);
    }
    case "read": {
      const rawPath = pathArgument("...", args.file_path, args.path);
      const filePath = shortenPath(rawPath);
      const offset =
        typeof args.offset === "number" && Number.isFinite(args.offset)
          ? args.offset
          : undefined;
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? args.limit
          : undefined;
      const fragments: ToolCallFragment[] = [
        { color: "muted", text: "read " },
        { color: "accent", text: filePath },
      ];
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        fragments.push({
          color: "warning",
          text: `:${startLine}${endLine ? `-${endLine}` : ""}`,
        });
      }
      return render(fragments);
    }
    case "write": {
      const rawPath = pathArgument("...", args.file_path, args.path);
      const filePath = shortenPath(rawPath);
      const content = typeof args.content === "string" ? args.content : "";
      const lines = content.split("\n").length;
      const fragments: ToolCallFragment[] = [
        { color: "muted", text: "write " },
        { color: "accent", text: filePath },
      ];
      if (lines > 1)
        fragments.push({ color: "dim", text: ` (${lines} lines)` });
      return render(fragments);
    }
    case "edit": {
      const rawPath = pathArgument("...", args.file_path, args.path);
      return render([
        { color: "muted", text: "edit " },
        { color: "accent", text: shortenPath(rawPath) },
      ]);
    }
    case "ls": {
      const rawPath = pathArgument(".", args.path);
      return render([
        { color: "muted", text: "ls " },
        { color: "accent", text: shortenPath(rawPath) },
      ]);
    }
    case "find": {
      const pattern = argumentText(args.pattern, "*");
      const rawPath = pathArgument(".", args.path);
      return render([
        { color: "muted", text: "find " },
        { color: "accent", text: pattern },
        { color: "dim", text: ` in ${shortenPath(rawPath)}` },
      ]);
    }
    case "grep": {
      const pattern = argumentText(args.pattern, "");
      const rawPath = pathArgument(".", args.path);
      return render([
        { color: "muted", text: "grep " },
        { color: "accent", text: `/${pattern}/` },
        { color: "dim", text: ` in ${shortenPath(rawPath)}` },
      ]);
    }
  }

  const argsStr = serializeToolArgs(args);
  return render([
    { color: "accent", text: displayToolName },
    { color: "dim", text: ` ${argsStr}` },
  ]);
}

type ToolCallFragment = {
  color: Parameters<ThemeForeground>[0];
  text: string;
};

/**
 * Keep non-command values on one terminal row without rewriting ordinary
 * spaces, which can be meaningful in file names and search patterns.
 */
function sanitizeInlineText(value: string): string {
  let sanitized = "";
  let replacedPrevious = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    if (isControl) {
      if (!replacedPrevious) sanitized += " ";
      replacedPrevious = true;
    } else {
      sanitized += character;
      replacedPrevious = false;
    }
  }
  return sanitized;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function serializeToolArgs(args: Record<string, unknown>): string {
  try {
    return (
      JSON.stringify(args, (_key, value) =>
        typeof value === "string" ? sanitizeInlineText(value) : value,
      ) ?? "{}"
    );
  } catch {
    return "[unserializable arguments]";
  }
}

function sliceWithoutSplittingSurrogatePair(
  value: string,
  maxCodeUnits: number,
): string {
  if (value.length <= maxCodeUnits) return value;
  let end = Math.max(0, maxCodeUnits);
  if (
    end > 0 &&
    end < value.length &&
    /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(value[end] ?? "")
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function renderBoundedFragments(
  fragments: ToolCallFragment[],
  themeFg: ThemeForeground,
  displayMode: ToolCallDisplayMode,
): string {
  const truncationMarker =
    displayMode === "collapsed" ? "…" : "\n… [truncated]";
  const limit =
    displayMode === "collapsed"
      ? COLLAPSED_TOOL_CALL_PREVIEW_WIDTH
      : EXPANDED_TOOL_CALL_PREVIEW_LENGTH;
  const measure = displayMode === "collapsed" ? visibleWidth : stringLength;
  const totalSize = fragments.reduce(
    (size, fragment) => size + measure(fragment.text),
    0,
  );

  if (totalSize <= limit) {
    return fragments
      .map((fragment) => themeFg(fragment.color, fragment.text))
      .join("");
  }

  let remaining = Math.max(0, limit - measure(truncationMarker));
  const bounded: ToolCallFragment[] = [];
  for (const fragment of fragments) {
    if (remaining === 0) break;
    const fragmentSize = measure(fragment.text);
    if (fragmentSize <= remaining) {
      bounded.push(fragment);
      remaining -= fragmentSize;
      continue;
    }
    const text =
      displayMode === "collapsed"
        ? sliceByColumn(fragment.text, 0, remaining, true)
        : sliceWithoutSplittingSurrogatePair(fragment.text, remaining);
    if (text.length > 0) bounded.push({ ...fragment, text });
    break;
  }
  bounded.push({ color: "dim", text: truncationMarker });
  return bounded
    .map((fragment) => themeFg(fragment.color, fragment.text))
    .join("");
}

function stringLength(value: string): number {
  return value.length;
}
