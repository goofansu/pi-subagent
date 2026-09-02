/**
 * Keeping a projection inside its bounds, deterministically.
 *
 * Two rules, applied everywhere: a list that overflows drops its **oldest**
 * entries, and a text that overflows is cut at a character boundary. Both
 * report what they removed, so a bounded projection can say it is bounded
 * instead of quietly being lossy.
 *
 * Newest-kept is the right choice for every list here. A transcript's recent
 * items are what a reader needs; a runaway Run's opening pleasantries are not.
 */

import type { ProjectionBounds } from "./projection.ts";
import { boundText } from "./text.ts";
import type { MessagePart, TranscriptItem } from "./transcript.ts";

/** What one bounding step removed, named so a report can list it. */
export interface TruncationEvent {
  readonly of:
    | "transcript"
    | "tools"
    | "diagnostics"
    | "links"
    | "transcript-text"
    | "tool-output"
    | "final-output"
    | "activity";
  /** Items dropped for a list, bytes cut for a text. */
  readonly amount: number;
}

export interface BoundedList<T> {
  readonly items: readonly T[];
  readonly droppedItems: number;
  readonly dropped: readonly TruncationEvent[];
}

/** Keep the newest `max` entries, reporting how many older ones went. */
export function boundList<T>(
  items: readonly T[],
  max: number,
  of: TruncationEvent["of"],
): BoundedList<T> {
  if (items.length <= max) {
    return { items, droppedItems: 0, dropped: [] };
  }
  const droppedItems = items.length - max;
  return {
    items: items.slice(droppedItems),
    droppedItems,
    dropped: [{ of, amount: droppedItems }],
  };
}

export interface BoundedProjectionText {
  readonly text: string;
  readonly cutBytes: number;
  readonly dropped: readonly TruncationEvent[];
}

export function boundProjectionText(
  text: string,
  maxBytes: number,
  of: TruncationEvent["of"],
): BoundedProjectionText {
  const bounded = boundText(text, maxBytes);
  return {
    text: bounded.text,
    cutBytes: bounded.droppedBytes,
    dropped:
      bounded.droppedBytes === 0 ? [] : [{ of, amount: bounded.droppedBytes }],
  };
}

export interface BoundedParts {
  readonly parts: readonly MessagePart[];
  readonly cutBytes: number;
  readonly dropped: readonly TruncationEvent[];
}

/** Bound every text part of one message. Tool call parts carry no text. */
export function boundParts(
  parts: readonly MessagePart[],
  maxTextPartBytes: number,
): BoundedParts {
  let cutBytes = 0;
  const bounded = parts.map((part) => {
    if (part.kind !== "text") return part;
    const text = boundText(part.text, maxTextPartBytes);
    cutBytes += text.droppedBytes;
    return text.droppedBytes === 0 ? part : { ...part, text: text.text };
  });
  return {
    parts: cutBytes === 0 ? parts : bounded,
    cutBytes,
    dropped:
      cutBytes === 0 ? [] : [{ of: "transcript-text", amount: cutBytes }],
  };
}

export interface BoundedTranscript {
  readonly transcript: readonly TranscriptItem[];
  readonly droppedItems: number;
  readonly cutBytes: number;
  readonly dropped: readonly TruncationEvent[];
}

/**
 * Bound a whole transcript: every item's text, then the item count.
 *
 * Used for a reconciliation's replacement transcript, which arrives all at
 * once rather than an item at a time.
 */
export function boundTranscript(
  transcript: readonly TranscriptItem[],
  bounds: ProjectionBounds,
): BoundedTranscript {
  const kept = boundList(transcript, bounds.maxTranscriptItems, "transcript");
  let cutBytes = 0;
  const items = kept.items.map((item) => {
    const parts = boundParts(item.parts, bounds.maxTextPartBytes);
    cutBytes += parts.cutBytes;
    return parts.cutBytes === 0 ? item : { ...item, parts: parts.parts };
  });
  return {
    transcript: items,
    droppedItems: kept.droppedItems,
    cutBytes,
    dropped: [
      ...kept.dropped,
      ...(cutBytes === 0
        ? []
        : [{ of: "transcript-text" as const, amount: cutBytes }]),
    ],
  };
}
