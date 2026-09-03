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
 * The details carry what the collapsed line needs and nothing the text
 * already says. Identity — Run id, Subagent id — because that is what a
 * later tool call and the landing key are addressed by; agent, label, status
 * and duration because those *are* the collapsed line, and a renderer that
 * had to parse them back out of the content would be a second reader of
 * prose. The text itself is not in the details: it is the message's content,
 * and a copy of it here could disagree with it. Nor is the cost: the line
 * does not show one, and a payload field nothing reads is the same mistake
 * the notice made when it carried a backend id.
 *
 * The payload is **host-shaped**. The notice's own fields can be renamed or
 * regrouped without touching the renderer, because the renderer reads this
 * schema and not `RunNotification`.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Markdown, Spacer } from "@earendil-works/pi-tui";
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
export const NOTIFICATION_MESSAGE_TYPE = "subagent-notification";

/**
 * What a landed notice can be identified by, and what its one line says.
 *
 * `runId` is the landing key and the key of every Run-scoped operation; the
 * rest is the collapsed summary line, field by field.
 */
export const NotificationDetails = Schema.Struct({
  runId: RunId,
  subagentId: SubagentId,
  agent: Schema.String,
  /** The Run's bounded label, which is what a human recognises it by. */
  label: Schema.String,
  status: TerminalRunPhase,
  durationMillis: Schema.Number,
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
      label: notice.label,
      status: notice.status,
      durationMillis: notice.durationMillis,
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
  // The summary is built inside `render`, not before it, because that is the
  // only place the width is known. Pi's `MessageRenderOptions` carry the
  // expansion state and the padding and no width — but `Component.render` is
  // handed the live viewport width on every draw, and `Box` passes each child
  // the width left after its own padding. Formatting eagerly meant fitting the
  // line to a guess, which cut a label on a wide terminal and wrapped one on a
  // narrow terminal. It also means the line re-fits itself when the terminal
  // is resized, for free.
  box.addChild({
    render: (width: number) => [
      formatNotificationSummary(details, theme, width, options.expanded),
    ],
    // Nothing is cached, so there is nothing to drop. `Box` calls this on
    // every child when its own cache is invalidated.
    invalidate: () => {},
  });
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
