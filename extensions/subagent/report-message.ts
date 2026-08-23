/**
 * How a delivered report looks in the transcript.
 *
 * Reports arrive uninvited and can be long, so they are pushed as a custom
 * message with a renderer of their own rather than as plain user text. Pi
 * renders custom messages against the same expansion state that `ctrl+o`
 * toggles for tool output, which starts collapsed — so a report is a single
 * summary line until you ask for it.
 */

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { runStatusGlyph, runStatusTone } from "./formatting.ts";
import type { LifecycleStatus } from "./types.ts";

/** The `customType` that routes a report to the renderer below. */
export const REPORT_MESSAGE_TYPE = "subagent-report";

export interface ReportMessageDetails {
  id: string;
  agent: string;
  status: LifecycleStatus;
  truncated: boolean;
}

interface RenderableMessage {
  content: string | Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface RenderableTheme {
  // biome-ignore lint/suspicious/noExplicitAny: theme.fg takes a narrower ThemeColor
  fg(color: any, text: string): string;
  // biome-ignore lint/suspicious/noExplicitAny: theme.bg takes a narrower ThemeColor
  bg(color: any, text: string): string;
  bold(text: string): string;
}

/** Plain text of a message body, whatever shape it arrived in. */
export function messageText(content: RenderableMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function isDetails(value: unknown): value is ReportMessageDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReportMessageDetails).id === "string" &&
    typeof (value as ReportMessageDetails).agent === "string"
  );
}

function abbreviate(characters: number): string {
  if (characters < 1_000) return `${characters} characters`;
  return `${(characters / 1_000).toFixed(1)}k characters`;
}

/** The one line a collapsed report shows. */
export function formatReportSummary(
  details: ReportMessageDetails,
  characters: number,
  theme: RenderableTheme,
  expanded = false,
  renderKeyHint = keyHint,
): string {
  const tone = runStatusTone(details.status);
  const verb = details.status === "completed" ? "reported" : details.status;

  let line =
    theme.fg(tone, `${runStatusGlyph(details.status)} `) +
    theme.fg("toolTitle", theme.bold(details.agent)) +
    theme.fg("dim", ` (${details.id}) `) +
    theme.fg("muted", verb) +
    theme.fg("dim", ` · ${abbreviate(characters)}`);

  if (details.truncated) {
    line += theme.fg(
      "warning",
      ` · trimmed, agent_result ${details.id} has the rest`,
    );
  }
  // One key toggles both ways, so the hint has to name the direction it will
  // actually go rather than always offering to expand.
  const hint = renderKeyHint(
    "app.tools.expand",
    expanded ? "to collapse" : "to expand",
  );
  return `${line} ${theme.fg("dim", `(${hint})`)}`;
}

/**
 * Render a delivered report: one summary line collapsed, the whole thing
 * expanded. Returning `undefined` lets pi fall back to its default rendering
 * for a message this extension did not shape.
 *
 * The box is not decoration. Pi renders a custom message itself only when no
 * extension supplies a renderer — "it handles its own styling" — so returning
 * a bare component silently opts out of the frame every other message in the
 * transcript has, and the report reads as loose text rather than as something
 * the session said. This reproduces pi's own custom-message styling so a
 * report sits in the conversation like a message.
 */
export function renderReportMessage(
  message: RenderableMessage,
  options: { expanded: boolean; outputPad?: number },
  theme: RenderableTheme,
): Component | undefined {
  if (!isDetails(message.details)) return undefined;
  const text = messageText(message.content);

  const box = new Box(options.outputPad ?? 1, 1, (line: string) =>
    theme.bg("customMessageBg", line),
  );
  box.addChild(
    new Text(
      formatReportSummary(
        message.details,
        text.length,
        theme,
        options.expanded,
      ),
      0,
      0,
    ),
  );

  if (options.expanded) {
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
  }
  return box;
}
