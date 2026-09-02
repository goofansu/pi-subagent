/**
 * The completion Notification as one Pi custom message.
 *
 * One Schema declaration, read two ways: `build` maps a domain
 * `RunNotification` onto it, and `parse` reads a landed host message back into
 * its details. v1 had a hand-written pair — a builder and a `isDetails`
 * predicate — and the failure mode of a hand-written pair is that the two
 * drift and the drift is invisible: a message the builder emits that the
 * parser rejects means a notice that lands and is never marked landed, which
 * shows up as a duplicate notification long after the change that caused it.
 *
 * A custom message rather than a plain user message, because it has to be two
 * things at once: compact in the transcript when collapsed, and the bounded
 * orientation text the model reads when expanded. Pi routes a custom message
 * to the renderer registered for its `customType`, which is what makes that
 * possible.
 *
 * The details carry identity only — Run id, Subagent id, agent, and terminal
 * status. Not the text: the text is the message's content, and details that
 * repeated it would be a second copy that could disagree.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Result, Schema } from "effect";
import {
  RunId,
  type RunNotification,
  SubagentId,
  TerminalRunPhase,
} from "../domain/index.ts";
import {
  contentText,
  formatNotificationSummary,
  formatNotificationText,
  type RenderableTheme,
} from "../presentation/index.ts";

/** The `customType` that routes a notification to its renderer. */
export const NOTIFICATION_MESSAGE_TYPE = "subagent-v2-notification";

/**
 * What a landed notice can be identified by.
 *
 * `runId` is the landing key and the key of every Run-scoped operation;
 * the rest is orientation for the collapsed summary line.
 */
export const NotificationDetails = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  agent: Schema.String,
  status: TerminalRunPhase,
});

export type NotificationDetails = typeof NotificationDetails.Type;

/** The whole custom-message payload, as Pi's `sendMessage` takes it. */
export const NotificationMessage = Schema.Struct({
  customType: Schema.Literal(NOTIFICATION_MESSAGE_TYPE),
  /** The bounded orientation text the model reads. */
  content: Schema.String,
  /** Notifications are always shown: a notice nobody sees is not a notice. */
  display: Schema.Literal(true),
  details: NotificationDetails,
});

export type NotificationMessage = typeof NotificationMessage.Type;

/** Build the payload pushed through the host, from the domain notice. */
export function buildNotificationMessage(
  notice: RunNotification,
): NotificationMessage {
  return {
    customType: NOTIFICATION_MESSAGE_TYPE,
    content: formatNotificationText(notice),
    display: true,
    details: {
      runId: notice.runId,
      subagentId: notice.subagentId,
      agent: notice.agent,
      status: notice.status,
    },
  };
}

/**
 * A landed host message, as `message_start` hands it over.
 *
 * The host's own message type carries a `role` and a great deal else, so the
 * declaration below describes only what identifies one of ours. `role` is
 * checked because a custom message is the only role that can carry a
 * `customType`, and a message that claimed the type under another role did not
 * come from here.
 */
const LandedNotification = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.Literal(NOTIFICATION_MESSAGE_TYPE),
  details: NotificationDetails,
});

// Not `EXACT_KEYS`: a landed host message carries the host's own bookkeeping
// alongside what this extension put on it, and rejecting a message because Pi
// added a timestamp would mean a notice that landed and was never marked
// landed. The exact-key rule is for values *we* produced; this one is Pi's.
const decodeLanded = Schema.decodeUnknownResult(LandedNotification);

/**
 * Read a landed message back into notification identity, or nothing.
 *
 * `undefined` for a message of another custom type, a message with malformed
 * details, and anything that is not a message at all. Every one of those is a
 * message this extension did not send, and the honest answer to "is this one
 * of mine" is no.
 */
export function parseNotificationMessage(
  value: unknown,
): NotificationDetails | undefined {
  const decoded = decodeLanded(value);
  return Result.isSuccess(decoded) ? decoded.success.details : undefined;
}

/**
 * Render a notification: one summary line collapsed, its bounded text
 * expanded.
 *
 * Returning `undefined` lets Pi handle a custom message this extension did not
 * shape — the renderer is registered for a `customType`, but the details are
 * what prove the message is ours. The box reproduces Pi's own custom-message
 * frame so the notice reads as part of the conversation rather than as
 * something bolted onto it.
 */
export function renderNotificationMessage(
  message: { readonly content: unknown; readonly details?: unknown },
  options: { readonly expanded: boolean; readonly outputPad?: number },
  theme: RenderableTheme,
): Component | undefined {
  const details = parseNotificationDetails(message.details);
  if (!details) return undefined;
  const text = contentText(message.content);

  const box = new Box(options.outputPad ?? 1, 1, (line: string) =>
    theme.bg("customMessageBg", line),
  );
  box.addChild(
    new Text(
      formatNotificationSummary(details, text.length, theme, options.expanded),
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

/** The details of a message we shaped, without requiring the host's `role`. */
function parseNotificationDetails(
  value: unknown,
): NotificationDetails | undefined {
  const decoded = decodeDetails(value);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
}

const decodeDetails = Schema.decodeUnknownResult(NotificationDetails);
