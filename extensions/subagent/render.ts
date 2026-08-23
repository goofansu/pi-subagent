import type {
  ExtensionUIContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { formatCharacterCount, runStatusTone } from "./presentation.ts";
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
 *
 * The prompt is rendered as a markdown blockquote because the host paints the
 * tool result below it in the same grey, and two adjacent grey paragraphs read
 * as one voice. The quote's gutter says "this is what was asked"; the
 * unquoted text after it is what came back. Going through the markdown
 * renderer rather than painting a gutter by hand keeps the bar on every row
 * of a soft-wrapped brief and matches how quotes look everywhere else.
 */
export function renderSubagentCall(
  args: SubagentArgs,
  theme: Theme,
  context: RenderCallContext,
): Component {
  const header =
    theme.fg("toolTitle", theme.bold(args.agent)) +
    " " +
    theme.fg("muted", args.description);
  const lines = args.prompt.split("\n");
  // A cut preview must say it is one: three lines that just stop read as the
  // whole brief.
  const previewLines = context.expanded
    ? lines
    : [...lines.slice(0, 3), ...(lines.length > 3 ? ["…"] : [])];
  const quote = previewLines.map((line) => `> ${line}`).join("\n");

  const row =
    context.lastComponent instanceof Container
      ? context.lastComponent
      : new Container();
  row.clear();
  row.addChild(new Text(header, 0, 0));
  row.addChild(new Markdown(quote, 0, 0, getMarkdownTheme()));
  return row;
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

/**
 * The single line a collapsed result shows in place of the whole report.
 *
 * No status glyph — the dots belong to the widget. A lone run states its
 * status as a word, painted in the status tone so a failure stands out.
 */
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
      theme.fg("toolTitle", run.agent) +
      theme.fg("dim", ` (${run.id}) `) +
      theme.fg(
        runStatusTone(run.status) as Parameters<Theme["fg"]>[0],
        run.status,
      );
  } else {
    // A fan-out is usually N of the same agent, and naming it N times says
    // nothing the count does not. Names appear only where they differ.
    const counts = new Map<string, number>();
    for (const run of runs) {
      counts.set(run.agent, (counts.get(run.agent) ?? 0) + 1);
    }
    line =
      counts.size === 1
        ? theme.fg("toolTitle", `${runs.length} ${runs[0].agent} reports`)
        : theme.fg("toolTitle", `${runs.length} reports`) +
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
