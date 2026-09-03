/**
 * What a Run's transcript and tool list are made of.
 *
 * These types are shared by observations (what a backend reports), the
 * projection (what the reducer folds), and terminal reconciliation (what a
 * backend's authoritative snapshot replaces), so they live apart from all
 * three.
 *
 * A tool call part deliberately carries no arguments. M1's vocabulary is what
 * a bounded projection can hold, and provider-shaped tool input is neither
 * bounded nor needed to prove any M1 rule; adding it later means adding a
 * bound for it, which is a visible change rather than an accident.
 */

import { Schema } from "effect";

/**
 * Who a transcript item is from.
 *
 * `tool` is the result of a native tool call, reported as its own item rather
 * than folded into the assistant message that asked for it. It is here because
 * every backend has one — a provider that runs tools produces tool results —
 * and because the alternatives are worse: attributing a tool's output to the
 * assistant would make the Run look as though the model said it, and dropping
 * it would lose the one part of a tool call a reader usually wants.
 *
 * Only an `assistant` item is an answer, which is why the final output is
 * taken from those alone. A `tool` item is evidence, not a reply.
 */
export const MESSAGE_ROLES = ["user", "assistant", "tool"] as const;

export const MessageRole = Schema.Literals(MESSAGE_ROLES);

export type MessageRole = typeof MessageRole.Type;

/**
 * One piece of a message.
 *
 * `callId` is the adapter's own handle for one native tool call. It is the
 * join key between a streamed tool call and the tool-progress observations
 * about it, and it is the one adapter-supplied identifier the boundary admits:
 * without it, a streamed part and a progress update about the same call would
 * become two tools. It is optional because an adapter may genuinely not have
 * one, and the reducer keeps such calls distinct rather than inventing an id
 * that could collide.
 */
export const MessagePart = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("tool_call"),
    name: Schema.String.check(Schema.isNonEmpty()),
    callId: Schema.optionalKey(Schema.String),
  }),
]);

export type MessagePart = typeof MessagePart.Type;

/** How a native tool call is going, as a backend reports it. */
export const TOOL_STATUSES = ["running", "completed", "failed"] as const;

export const ToolStatus = Schema.Literals(TOOL_STATUSES);

export type ToolStatus = typeof ToolStatus.Type;

/**
 * How a tool call ended up in the projection.
 *
 * The two statuses beyond what a backend reports are what settlement writes
 * onto a tool that never reported an outcome: `cancelled` or `failed` when the
 * Run ended that way, and `unfinished` when the Run answered anyway. Without
 * them a cancelled Run would show a tool as still running forever.
 */
export const TOOL_ENTRY_STATUSES = [
  ...TOOL_STATUSES,
  "cancelled",
  "unfinished",
] as const;

export const ToolEntryStatus = Schema.Literals(TOOL_ENTRY_STATUSES);

export type ToolEntryStatus = typeof ToolEntryStatus.Type;

export const TranscriptItem = Schema.Struct({
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  model: Schema.optionalKey(Schema.String),
});

export type TranscriptItem = typeof TranscriptItem.Type;

export const ToolEntry = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  status: ToolEntryStatus,
  callId: Schema.optionalKey(Schema.String),
  outputSummary: Schema.optionalKey(Schema.String),
});

export type ToolEntry = typeof ToolEntry.Type;

/** The text of a transcript item, which is its text parts joined. */
export function transcriptItemText(item: TranscriptItem): string {
  return item.parts
    .filter(
      (part): part is Extract<MessagePart, { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.text)
    .join("");
}
