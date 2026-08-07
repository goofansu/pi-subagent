import type {
  AgentToolResult,
  ExtensionUIContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  formatHarnessBadge,
  formatToolCall,
  formatUsageStats,
  TOOL_CALL_ARROW_PREFIX,
} from "./formatting.ts";
import { getDisplayItems, getFinalOutput } from "./messages.ts";
import type {
  DisplayItem,
  PersistedSubagentDetails,
  ResolvedPersistedResult,
} from "./types.ts";
import { resolvePersistedResult } from "./types.ts";

export const COLLAPSED_ITEM_COUNT = 10;

type SubagentArgs = {
  agent: string;
  description: string;
  prompt: string;
};

type Theme = ExtensionUIContext["theme"];
type RenderCallContext = { lastComponent?: Component; expanded: boolean };

function formatDuration(milliseconds: number): string {
  const clampedMilliseconds = Math.max(0, milliseconds);
  const tenths = Math.round(clampedMilliseconds / 100);
  if (tenths < 60 * 10) return `${(tenths / 10).toFixed(1)}s`;

  const wholeSeconds = Math.round(clampedMilliseconds / 1000);
  if (wholeSeconds < 60 * 60) {
    return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
  }

  const hours = Math.floor(wholeSeconds / (60 * 60));
  const minutes = Math.floor((wholeSeconds % (60 * 60)) / 60);
  return `${hours}h ${minutes}m`;
}

function elapsed(start: number | undefined, end: number): string | undefined {
  if (start === undefined || !Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return formatDuration(end - start);
}

/** Human-readable lifecycle state with queue or backend time where known. */
export function formatLifecycleStatus(
  result: ResolvedPersistedResult,
  now: number = Date.now(),
): string {
  switch (result.status) {
    case "queued": {
      const duration = elapsed(result.queuedAt, now);
      return duration ? `queued for ${duration}` : "queued";
    }
    case "running": {
      const duration = elapsed(result.startedAt, now);
      return duration ? `running for ${duration}` : "running";
    }
    case "completed": {
      const duration = elapsed(result.startedAt, result.finishedAt ?? now);
      return duration ? `completed in ${duration}` : "completed";
    }
    case "failed": {
      const duration = elapsed(result.startedAt, result.finishedAt ?? now);
      return duration ? `failed after ${duration}` : "failed";
    }
    case "aborted": {
      if (result.startedAt !== undefined) {
        const duration = elapsed(result.startedAt, result.finishedAt ?? now);
        return duration ? `aborted after ${duration}` : "aborted";
      }
      const duration = elapsed(result.queuedAt, result.finishedAt ?? now);
      if (duration) return `aborted while queued after ${duration}`;
      return "aborted";
    }
  }
}

export function renderSubagentCall(
  args: SubagentArgs,
  theme: Theme,
  context: RenderCallContext,
): Component {
  const text =
    (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const header =
    theme.fg("toolTitle", theme.bold(args.agent)) +
    " " +
    theme.fg("muted", args.description);
  const promptPreview = context.expanded
    ? args.prompt
    : args.prompt.split("\n").slice(0, 3).join("\n");
  const body = `\n${theme.fg("dim", promptPreview)}`;
  text.setText(`${header}${body}`);
  return text;
}

export function renderSubagentResult(
  result: AgentToolResult<PersistedSubagentDetails | undefined>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
  _context: unknown,
): Component {
  const details = result.details as PersistedSubagentDetails | undefined;
  if (!details || details.results.length === 0) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  // Reopening an old session can replay results that predate both the harness
  // and lifecycle fields. Resolve them on a copy before rendering.
  const r = resolvePersistedResult(details.results[0]);
  const isQueued = r.status === "queued";
  const isRunning = r.status === "running";
  const isError = r.status === "failed" || r.status === "aborted";
  const icon = isQueued
    ? theme.fg("warning", "○")
    : isRunning
      ? theme.fg("warning", "⏳")
      : isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
  const lifecycle = `[${formatLifecycleStatus(r)}]`;
  const lifecycleLabel = isError
    ? theme.fg("error", lifecycle)
    : isQueued || isRunning
      ? theme.fg("warning", lifecycle)
      : theme.fg("success", lifecycle);
  const emptyOutput = isQueued
    ? "(queued...)"
    : isRunning
      ? "(running...)"
      : "(no output)";
  const displayItems = getDisplayItems(r.messages);
  const finalOutput = getFinalOutput(r.messages);
  const mdTheme = getMarkdownTheme();

  const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
    const toShow = limit ? items.slice(-limit) : items;
    const skipped = limit && items.length > limit ? items.length - limit : 0;
    let text = "";
    if (skipped > 0)
      text += theme.fg("muted", `... ${skipped} earlier items\n`);
    for (const item of toShow) {
      if (item.type === "text") {
        const preview = item.text.split("\n").slice(0, 3).join("\n");
        text += `${theme.fg("toolOutput", preview)}\n`;
      } else {
        text += `${theme.fg("muted", TOOL_CALL_ARROW_PREFIX)}${formatToolCall(
          item.name,
          item.args,
          theme.fg.bind(theme),
          "collapsed",
        )}\n`;
      }
    }
    return text.trimEnd();
  };

  if (expanded) {
    const container = new Container();
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
    header += formatHarnessBadge(r.harness, theme.fg.bind(theme));
    if (r.description) header += ` ${theme.fg("muted", r.description)}`;
    header += ` ${lifecycleLabel}`;
    if (isError && r.stopReason && r.stopReason !== r.status)
      header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
    container.addChild(new Text(header, 0, 0));

    if (isError && r.errorMessage) {
      container.addChild(
        new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
      );
    }

    const toolCalls = displayItems.filter((item) => item.type === "toolCall");
    if (toolCalls.length > 0) {
      container.addChild(new Spacer(1));
      for (const item of toolCalls) {
        if (item.type === "toolCall") {
          container.addChild(
            new Text(
              theme.fg("muted", TOOL_CALL_ARROW_PREFIX) +
                formatToolCall(
                  item.name,
                  item.args,
                  theme.fg.bind(theme),
                  "expanded",
                ),
              0,
              0,
            ),
          );
        }
      }
    }

    if (finalOutput) {
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
    } else if (!isError) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", emptyOutput), 0, 0));
    }

    const usageStr = formatUsageStats(r.usage, r.model, r.effort);
    if (usageStr) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
    }
    return container;
  }

  // Collapsed / running view
  let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
  text += formatHarnessBadge(r.harness, theme.fg.bind(theme));
  if (r.description) text += ` ${theme.fg("muted", r.description)}`;
  text += ` ${lifecycleLabel}`;
  if (isError && r.stopReason && r.stopReason !== r.status)
    text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

  if (isError && r.errorMessage) {
    text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
  } else if (displayItems.length === 0) {
    text += `\n${theme.fg("muted", emptyOutput)}`;
  } else {
    text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
  }

  const usageStr = formatUsageStats(r.usage, r.model, r.effort);
  if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
  text += `\n${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`;

  return new Text(text, 0, 0);
}
