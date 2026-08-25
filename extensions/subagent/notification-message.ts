/**
 * How a completion notification looks in the transcript.
 *
 * Notifications use a custom message so they can stay compact when collapsed
 * and reveal their bounded orientation text when expanded.
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

/** The `customType` that routes a notification to the renderer below. */
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
 * The one line a collapsed notification shows.
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
 * Render a notification as one summary line when collapsed and its bounded
 * orientation text when expanded. Returning `undefined` lets pi handle a
 * custom message this extension did not shape. The box reproduces pi's own
 * custom-message frame so the notification reads as part of the conversation.
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
