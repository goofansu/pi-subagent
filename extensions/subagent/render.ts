import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

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
