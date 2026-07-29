import * as os from "node:os";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { resolveClaudeCommand } from "./backends/claude.ts";
import type { Harness, ThemeForeground, UsageStats } from "./types.ts";
import { DEFAULT_HARNESS } from "./types.ts";

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
 * The command that reopens a finished external-harness transcript. Both Claude
 * Code and Codex restore the run's working directory context, so the hint hops
 * there first when necessary.
 *
 * The executable is resolved rather than assumed: the SDK drives a bundled
 * binary that declares no npm `bin`, so a setup can run claude subagents with
 * nothing named `claude` on PATH, and a hint that assumed otherwise would only
 * ever print "command not found".
 */
export function formatResumeHint(
  result: { harness: Harness; sessionId?: string; cwd?: string },
  currentCwd: string = process.cwd(),
  commandOverride?: string,
): string | undefined {
  if (
    (result.harness !== "claude" && result.harness !== "codex") ||
    !result.sessionId
  ) {
    return undefined;
  }
  const executable =
    commandOverride ??
    (result.harness === "claude" ? resolveClaudeCommand() : "codex");
  const resumeArgs =
    result.harness === "claude"
      ? `-r ${result.sessionId}`
      : `resume ${result.sessionId}`;
  const command = `${shellQuote(executable)} ${resumeArgs}`;
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

  // Backends name the same tools differently ("read" in pi, "Read" in Claude
  // Code) while agreeing on the argument names, so match case-insensitively.
  switch (toolName.toLowerCase()) {
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
    case "glob":
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
    case "todowrite": {
      if (Array.isArray(args.todos)) {
        const count = args.todos.length;
        const details =
          displayMode === "expanded" ? formatTodoDetails(args.todos) : [];
        return render([
          { color: "accent", text: displayToolName },
          {
            color: "dim",
            text: ` (${count} ${count === 1 ? "todo" : "todos"}${details.length > 0 ? `: ${details.join("; ")}` : ""})`,
          },
        ]);
      }
      break;
    }
    case "apply_patch": {
      if (Array.isArray(args.changes)) {
        const count = args.changes.length;
        const paths =
          displayMode === "expanded" ? changedPaths(args.changes) : [];
        return render([
          { color: "accent", text: displayToolName },
          {
            color: "dim",
            text: ` (${count} ${count === 1 ? "change" : "changes"}${paths.length > 0 ? `: ${paths.join(", ")}` : ""})`,
          },
        ]);
      }
      break;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function changedPaths(changes: unknown[]): string[] {
  return changes.flatMap((change) => {
    if (!isRecord(change)) return [];
    const path = [change.path, change.file_path].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return path ? [sanitizeInlineText(path)] : [];
  });
}

function formatTodoDetails(todos: unknown[]): string[] {
  return todos.flatMap((todo) => {
    if (typeof todo === "string" && todo.length > 0) {
      return [`[?] ${sanitizeInlineText(todo)}`];
    }
    if (!isRecord(todo)) return [];
    const content = [todo.content, todo.activeForm].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (!content) return [];
    const status =
      todo.status === "completed"
        ? "[x]"
        : todo.status === "in_progress"
          ? "[>]"
          : todo.status === "pending"
            ? "[ ]"
            : "[?]";
    return [`${status} ${sanitizeInlineText(content)}`];
  });
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
