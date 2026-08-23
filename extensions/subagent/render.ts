import type {
  ExtensionUIContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";

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

/**
 * Render a tool result as Markdown.
 *
 * Pi's default renders a result as flat text, which is right for most tools
 * but not for these: what `agent_wait` and `agent_result` return is prose an
 * agent wrote, with the headings, lists and code spans it chose. Rendered flat
 * it reads as a wall of asterisks and backticks.
 */
export function renderMarkdownResult(
  result: { content: string | Array<{ type: string; text?: string }> },
  _options: ToolRenderResultOptions,
  _theme: Theme,
): Component {
  const text = contentText(result.content).trim();
  if (!text) return new Text("", 0, 0);
  return new Markdown(text, 0, 0, getMarkdownTheme());
}
