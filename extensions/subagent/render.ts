import type {
  ExtensionUIContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import {
  formatCharacterCount,
  runStatusGlyph,
  runStatusTone,
} from "./formatting.ts";
import type { LifecycleStatus } from "./types.ts";

type SubagentArgs = {
  agent: string;
  description: string;
  prompt: string;
};

type Theme = ExtensionUIContext["theme"];
type RenderCallContext = { lastComponent?: Component; expanded: boolean };

/**
 * The transcript row for `agent_start`: who was asked, and what for.
 *
 * A started run reports nothing else here. Its progress lives in the widget
 * and its answer arrives as a report of its own, so a row that tried to show
 * either would be a stale copy of both.
 */
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
  text.setText(`${header}\n${theme.fg("dim", promptPreview)}`);
  return text;
}

/** The text of a tool result or message body, whatever shape it arrived in. */
export function contentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** Which runs a collected result covers, for the line shown when collapsed. */
export interface CollectedRuns {
  runs: Array<{ id: string; agent: string; status: LifecycleStatus }>;
  /** Runs asked for that had not finished. Only `agent_wait` produces these. */
  stillRunning?: number;
}

function isCollectedRuns(value: unknown): value is CollectedRuns {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as CollectedRuns).runs)
  );
}

/** The single line a collapsed result shows in place of the whole report. */
export function formatCollectedSummary(
  collected: CollectedRuns,
  characters: number,
  theme: Theme,
  renderKeyHint = keyHint,
): string {
  const { runs } = collected;
  let line: string;

  if (runs.length === 1) {
    const run = runs[0];
    line =
      theme.fg(
        runStatusTone(run.status) as Parameters<Theme["fg"]>[0],
        `${runStatusGlyph(run.status)} `,
      ) +
      theme.fg("toolTitle", run.agent) +
      theme.fg("dim", ` (${run.id})`);
  } else {
    line =
      theme.fg("toolTitle", `${runs.length} reports`) +
      theme.fg("dim", ` from ${runs.map((run) => run.agent).join(", ")}`);
  }

  line += theme.fg("dim", ` · ${formatCharacterCount(characters)}`);
  if (collected.stillRunning) {
    line += theme.fg("warning", ` · ${collected.stillRunning} still running`);
  }
  return `${line} ${theme.fg("dim", `(${renderKeyHint("app.tools.expand", "to expand")})`)}`;
}

/**
 * Render a collected report: a summary line collapsed, Markdown expanded.
 *
 * Two things are wrong with the flat default for these tools. What
 * `agent_wait` and `agent_result` return is prose an agent wrote, with the
 * headings, lists and code spans it chose, and rendered flat it reads as a
 * wall of asterisks and backticks. And a report can be thousands of
 * characters, which is a lot of transcript to scroll past for something you
 * have usually already read once as a delivered message.
 */
export function renderMarkdownResult(
  result: {
    content: string | Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const text = contentText(result.content).trim();
  if (!text) return new Text("", 0, 0);

  if (options.expanded) return new Markdown(text, 0, 0, getMarkdownTheme());

  // Without runs to name there is nothing to summarise from — `agent_wait` on
  // an already-delivered id reports no runs at all — so fall back to the
  // opening line rather than announcing "0 reports".
  if (!isCollectedRuns(result.details) || result.details.runs.length === 0) {
    const firstLine = text.split("\n", 1)[0] ?? "";
    return new Text(theme.fg("toolOutput", firstLine), 0, 0);
  }

  return new Text(
    formatCollectedSummary(result.details, text.length, theme),
    0,
    0,
  );
}
