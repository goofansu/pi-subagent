import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { formatCharacterCount, runStatusTone } from "./presentation.ts";
import type { LifecycleStatus, RenderableTheme } from "./types.ts";

type SubagentArgs = {
  agent: string;
  description: string;
  prompt: string;
};

type RenderCallContext = { lastComponent?: Component; expanded: boolean };

/**
 * The transcript row for `agent_start`: who was asked, and what for.
 *
 * A started run returns nothing else here. Its progress lives in the widget
 * and its answer is retrieved separately, so a row that tried to show
 * either would be a stale copy of both.
 *
 * The host paints the tool result below this row in the same grey as the
 * prompt, and two adjacent grey paragraphs read as one voice. A `Prompt:`
 * label and a blank line on each side are what keep the brief and the answer
 * apart — plain text, no markdown, so the row reads the same however the
 * brief is written and however narrow the terminal wraps it.
 */
export function renderSubagentCall(
  args: SubagentArgs,
  theme: RenderableTheme,
  context: RenderCallContext,
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  const header =
    theme.fg("toolTitle", theme.bold(args.agent)) +
    " " +
    theme.fg("muted", args.description);
  const lines = args.prompt.split("\n");
  // A cut preview must say it is one: three lines that just stop read as the
  // whole brief.
  const preview = context.expanded
    ? args.prompt
    : lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n…" : "");
  // The trailing newline is air between the brief and whatever the host
  // paints below it — the tool result otherwise reads as the prompt's last
  // line.
  text.setText(
    `${header}\n\n${theme.fg("muted", "Prompt:")} ${theme.fg("dim", preview)}\n`,
  );
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
  /** Runs asked for that had not finished. Only `agent_await` produces these. */
  stillRunning?: number;
}

function isCollectedRuns(value: unknown): value is CollectedRuns {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as CollectedRuns).runs)
  );
}

/**
 * The single line a collapsed result shows in place of the whole body.
 *
 * No status glyph — lifecycle state is written as text. A lone run states its
 * status as a word, painted in the status tone so a failure stands out.
 */
export function formatCollectedSummary(
  collected: CollectedRuns,
  characters: number,
  theme: RenderableTheme,
  renderKeyHint = keyHint,
): string {
  const { runs } = collected;
  let line: string;

  if (runs.length === 1) {
    const run = runs[0];
    line =
      theme.fg("toolTitle", run.agent) +
      theme.fg("dim", ` (${run.id}) `) +
      theme.fg(runStatusTone(run.status), run.status);
  } else {
    // A fan-out is usually N of the same agent, and naming it N times says
    // nothing the count does not. Names appear only where they differ.
    const counts = new Map<string, number>();
    for (const run of runs) {
      counts.set(run.agent, (counts.get(run.agent) ?? 0) + 1);
    }
    line =
      counts.size === 1
        ? theme.fg("toolTitle", `${runs.length} ${runs[0].agent} results`)
        : theme.fg("toolTitle", `${runs.length} results`) +
          theme.fg(
            "dim",
            ` from ${[...counts]
              .map(([agent, n]) => (n > 1 ? `${agent} ×${n}` : agent))
              .join(", ")}`,
          );
  }

  line += theme.fg("dim", ` · ${formatCharacterCount(characters)}`);
  if (collected.stillRunning) {
    line += theme.fg("warning", ` · ${collected.stillRunning} still running`);
  }
  return `${line} ${theme.fg("dim", `(${renderKeyHint("app.tools.expand", "to expand")})`)}`;
}

/**
 * Render a collected result: a summary line collapsed, Markdown expanded.
 * Agent output may contain Markdown and can be thousands of characters, so
 * the flat default is both hard to read and hard to scroll past.
 */
export function renderMarkdownResult(
  result: {
    content: string | Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: ToolRenderResultOptions,
  theme: RenderableTheme,
): Component {
  const text = contentText(result.content).trim();
  if (!text) return new Text("", 0, 0);

  if (options.expanded) return new Markdown(text, 0, 0, getMarkdownTheme());

  // Without runs to name there is nothing to summarise, so fall back to the
  // opening line rather than announcing "0 results".
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
