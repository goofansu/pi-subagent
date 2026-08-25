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
import {
  formatCharacterCount,
  notificationVerb,
  runStatusTone,
} from "./presentation.ts";
import { contentText } from "./render.ts";
import type { LifecycleStatus } from "./types.ts";

/** The `customType` that routes a report to the renderer below. */
export const NOTIFICATION_MESSAGE_TYPE = "subagent-notification";

export interface NotificationMessageDetails {
  id: string;
  agent: string;
  status: LifecycleStatus;
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

function isDetails(value: unknown): value is NotificationMessageDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NotificationMessageDetails).id === "string" &&
    typeof (value as NotificationMessageDetails).agent === "string"
  );
}

/**
 * The one line a collapsed report shows.
 *
 * No status glyph: the dots belong to the widget, where rows are scanned as a
 * column. Here the verb says what happened, and it is painted in the status
 * tone so a failure still stands out.
 */
export function formatNotificationSummary(
  details: NotificationMessageDetails,
  characters: number,
  theme: RenderableTheme,
  expanded = false,
  renderKeyHint = keyHint,
): string {
  const tone = runStatusTone(details.status);
  const verb = notificationVerb(details.status);

  const line =
    theme.fg("toolTitle", theme.bold(details.agent)) +
    theme.fg("dim", ` (${details.id}) `) +
    theme.fg(tone, verb) +
    theme.fg("dim", ` · ${formatCharacterCount(characters)}`);

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
export function renderNotificationMessage(
  message: RenderableMessage,
  options: { expanded: boolean; outputPad?: number },
  theme: RenderableTheme,
): Component | undefined {
  if (!isDetails(message.details)) return undefined;
  const text = contentText(message.content);

  const box = new Box(options.outputPad ?? 1, 1, (line: string) =>
    theme.bg("customMessageBg", line),
  );
  box.addChild(
    new Text(
      formatNotificationSummary(
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
