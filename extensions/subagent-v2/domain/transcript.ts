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

export const MESSAGE_ROLES = ["user", "assistant"] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

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
export type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly name: string;
      readonly callId?: string;
    };

/** How a native tool call is going, as a backend reports it. */
export const TOOL_STATUSES = ["running", "completed", "failed"] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];

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

export type ToolEntryStatus = (typeof TOOL_ENTRY_STATUSES)[number];

export interface TranscriptItem {
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  readonly model?: string;
}

export interface ToolEntry {
  readonly name?: string;
  readonly status: ToolEntryStatus;
  readonly callId?: string;
  readonly outputSummary?: string;
}

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
