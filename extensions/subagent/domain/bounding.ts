/**
 * Keeping observation text and projections inside their bounds, deterministically.
 *
 * Every string that can become projection text is bounded in one
 * {@link boundObservation} step after decoding. Reducer cases then only apply
 * structure. Lists use a separate structural rule: when one overflows, keep
 * its newest entries. Every cut and drop is reported.
 */

import type { RunObservation } from "./observations.ts";
import type { ProjectionBounds } from "./projection.ts";
import type { MessagePart, TranscriptItem } from "./transcript.ts";
import { transcriptItemText } from "./transcript.ts";

/** Long enough to explain a failure, short enough to keep on a heap. */
export const DIAGNOSTIC_MESSAGE_MAX_BYTES = 2048;
/** One line of link display text. */
export const RESULT_LINK_LABEL_MAX_BYTES = 200;
/** A path or URL, bounded well below what a terminal would show. */
export const RESULT_LINK_TARGET_MAX_BYTES = 2048;
/** Bound on the fallback message a failed ending may carry. */
export const RUN_ENDING_MESSAGE_MAX_BYTES = 2048;

/** UTF-8 length, the unit every text bound in v2 is expressed in. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface BoundedText {
  readonly text: string;
  /** Bytes removed. Zero means the text was already within the bound. */
  readonly droppedBytes: number;
}

/** Keep the longest prefix that fits, cutting only between characters. */
export function boundText(text: string, maxBytes: number): BoundedText {
  if (maxBytes < 0) {
    throw new RangeError(`a byte bound cannot be negative: ${maxBytes}`);
  }
  const encoder = new TextEncoder();
  const total = encoder.encode(text).length;
  if (total <= maxBytes) return { text, droppedBytes: 0 };

  let kept = "";
  let keptBytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (keptBytes + size > maxBytes) break;
    kept += character;
    keptBytes += size;
  }
  return { text: kept, droppedBytes: total - keptBytes };
}

/** Collapse a one-line value, trim it, and apply its byte bound. */
export function boundOneLineText(text: string, maxBytes: number): BoundedText {
  return boundText(text.replace(/[\r\n]+/g, " ").trim(), maxBytes);
}

/** The same one-line bound for callers with nothing to report. */
export function boundOneLine(text: string, maxBytes: number): string {
  return boundOneLineText(text, maxBytes).text;
}

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
    | "activity"
    | "diagnostic"
    | "link-label"
    | "link-target"
    | "ending";
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

function boundOneLineProjectionText(
  text: string,
  maxBytes: number,
  of: TruncationEvent["of"],
): BoundedProjectionText {
  const bounded = boundOneLineText(text, maxBytes);
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

/** Bound a whole transcript's text and item count. */
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

export interface BoundedObservation {
  readonly observation: RunObservation;
  readonly dropped: readonly TruncationEvent[];
  /** The independently bounded answer carried by an assistant message. */
  readonly assistantOutput?: BoundedProjectionText;
}

/**
 * Bound every projection text carried by one decoded observation.
 *
 * Message parts and an assistant answer have independent bounds, so the
 * answer is returned separately rather than derived from already-bounded
 * transcript parts. Reconciliation lists remain structural and are bounded by
 * reconciliation; their text is bounded here.
 */
export function boundObservation(
  observation: RunObservation,
  bounds: ProjectionBounds,
): BoundedObservation {
  switch (observation.kind) {
    case "message": {
      const parts = boundParts(observation.parts, bounds.maxTextPartBytes);
      const answer = transcriptItemText(observation);
      const assistantOutput =
        observation.role === "assistant" && answer.trim() !== ""
          ? boundProjectionText(
              answer,
              bounds.maxFinalOutputBytes,
              "final-output",
            )
          : undefined;
      return {
        observation:
          parts.cutBytes === 0
            ? observation
            : { ...observation, parts: parts.parts },
        dropped: [...parts.dropped, ...(assistantOutput?.dropped ?? [])],
        ...(assistantOutput === undefined ? {} : { assistantOutput }),
      };
    }
    case "tool_progress": {
      if (observation.outputSummary === undefined) {
        return { observation, dropped: [] };
      }
      const summary = boundProjectionText(
        observation.outputSummary,
        bounds.maxTextPartBytes,
        "tool-output",
      );
      return {
        observation:
          summary.cutBytes === 0
            ? observation
            : { ...observation, outputSummary: summary.text },
        dropped: summary.dropped,
      };
    }
    case "activity": {
      if (observation.activity === undefined)
        return { observation, dropped: [] };
      const activity = boundOneLineProjectionText(
        observation.activity,
        bounds.maxTextPartBytes,
        "activity",
      );
      return {
        observation: { ...observation, activity: activity.text },
        dropped: activity.dropped,
      };
    }
    case "diagnostic": {
      const message = boundOneLineProjectionText(
        observation.diagnostic.message,
        DIAGNOSTIC_MESSAGE_MAX_BYTES,
        "diagnostic",
      );
      return {
        observation: {
          ...observation,
          diagnostic: { ...observation.diagnostic, message: message.text },
        },
        dropped: message.dropped,
      };
    }
    case "link": {
      const label = boundOneLineProjectionText(
        observation.link.label,
        RESULT_LINK_LABEL_MAX_BYTES,
        "link-label",
      );
      const target = boundProjectionText(
        observation.link.target.trim(),
        RESULT_LINK_TARGET_MAX_BYTES,
        "link-target",
      );
      return {
        observation: {
          ...observation,
          link: { ...observation.link, label: label.text, target: target.text },
        },
        dropped: [...label.dropped, ...target.dropped],
      };
    }
    case "reconciliation": {
      let transcriptCut = 0;
      const transcript = observation.reconciliation.transcript?.map((item) => {
        const parts = boundParts(item.parts, bounds.maxTextPartBytes);
        transcriptCut += parts.cutBytes;
        return parts.cutBytes === 0 ? item : { ...item, parts: parts.parts };
      });
      const finalOutput =
        observation.reconciliation.finalOutput === undefined
          ? undefined
          : boundProjectionText(
              observation.reconciliation.finalOutput,
              bounds.maxFinalOutputBytes,
              "final-output",
            );
      return {
        observation: {
          ...observation,
          reconciliation: {
            ...observation.reconciliation,
            ...(transcript === undefined ? {} : { transcript }),
            ...(finalOutput === undefined
              ? {}
              : { finalOutput: finalOutput.text }),
          },
        },
        dropped: [
          ...(transcriptCut === 0
            ? []
            : [{ of: "transcript-text" as const, amount: transcriptCut }]),
          ...(finalOutput?.dropped ?? []),
        ],
      };
    }
    case "ending": {
      if (
        observation.ending.ending !== "failed" ||
        observation.ending.message === undefined
      ) {
        return { observation, dropped: [] };
      }
      const message = boundOneLineProjectionText(
        observation.ending.message,
        RUN_ENDING_MESSAGE_MAX_BYTES,
        "ending",
      );
      return {
        observation: {
          ...observation,
          ending: { ...observation.ending, message: message.text },
        },
        dropped: message.dropped,
      };
    }
    case "usage":
    case "context":
    case "model":
      return { observation, dropped: [] };
  }
}
