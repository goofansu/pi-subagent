/**
 * The bounded Run projection, and the bounds it is bounded by.
 *
 * A projection is what a Run looks like after its observations have been
 * folded. It is the only mutable-in-effect state a Run has, and the reducer is
 * its only writer — no adapter, host handler, or presentation code writes to
 * one.
 *
 * Every list in it is bounded and every text in it is bounded, because a Run
 * is a thing a backend can talk into for as long as it likes. Truncation keeps
 * the most recent items and records what it dropped, so a bounded projection
 * is honest about being bounded rather than quietly lossy.
 */

import { Schema } from "effect";
import type { RunDiagnostic } from "./diagnostics.ts";
import type { RunEnding } from "./endings.ts";
import type { ResultLink } from "./links.ts";
import type { ToolEntry, TranscriptItem } from "./transcript.ts";
import { EMPTY_USAGE_SNAPSHOT, type UsageSnapshot } from "./usage.ts";

/** A count of things bounding removed. Never negative, never fractional. */
const Dropped = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

/**
 * What bounding has removed from a projection so far.
 *
 * The byte counts are split by what they measure rather than pooled, because
 * the fields they measure are bounded differently. A transcript *accumulates*,
 * so its counts add up. The reducer replaces tool-output and final-output
 * counts when their currently shown text is replaced by progress, assistant
 * message, or reconciliation observations. Result bounding can then add to
 * the tool-output count when it removes summaries and to the final-output
 * count when it shortens the answer: the reducer sets the final-output count
 * from streamed or reconciled output, and Result bounding adds any further
 * cut. A pooled counter could not support both behaviours, and terminal
 * reconciliation would stop being idempotent — replaying it would add the
 * same cut a second time.
 */
export const TruncationRecord = Schema.Struct({
  droppedTranscriptItems: Dropped,
  droppedToolEntries: Dropped,
  droppedDiagnostics: Dropped,
  droppedLinks: Dropped,
  /** Bytes cut from the text parts of the transcript as it stands. */
  truncatedTranscriptBytes: Dropped,
  /** Bytes cut from the tool output summary currently shown. */
  truncatedToolOutputBytes: Dropped,
  /**
   * Bytes cut from the final output as it stands. The reducer sets this from
   * the streamed or reconciled output; Result bounding adds any further cut.
   */
  truncatedOutputBytes: Dropped,
});

export type TruncationRecord = typeof TruncationRecord.Type;

export const EMPTY_TRUNCATION_RECORD: TruncationRecord = {
  droppedTranscriptItems: 0,
  droppedToolEntries: 0,
  droppedDiagnostics: 0,
  droppedLinks: 0,
  truncatedTranscriptBytes: 0,
  truncatedToolOutputBytes: 0,
  truncatedOutputBytes: 0,
};

export interface ProjectionBounds {
  readonly maxTranscriptItems: number;
  readonly maxToolEntries: number;
  readonly maxDiagnostics: number;
  readonly maxLinks: number;
  readonly maxTextPartBytes: number;
  readonly maxFinalOutputBytes: number;
}

/**
 * Bounds generous enough that a real Run never notices them, and small enough
 * that a runaway Run cannot take a Pi process down.
 */
export const DEFAULT_PROJECTION_BOUNDS: ProjectionBounds = {
  maxTranscriptItems: 500,
  maxToolEntries: 200,
  maxDiagnostics: 50,
  maxLinks: 20,
  maxTextPartBytes: 16 * 1024,
  maxFinalOutputBytes: 64 * 1024,
};

export interface RunProjection {
  /**
   * Whether the ending has been reduced. A terminal projection ignores every
   * later observation rather than being healed by it.
   */
  readonly terminal: boolean;
  readonly transcript: readonly TranscriptItem[];
  readonly tools: readonly ToolEntry[];
  readonly diagnostics: readonly RunDiagnostic[];
  readonly links: readonly ResultLink[];
  readonly usage: UsageSnapshot;
  /** Conflated, display-only, and cleared by the ending. */
  readonly activity?: string;
  /** Last bounded semantic summary, retained through clears and ending. */
  readonly lastActivity?: string;
  readonly model?: string;
  /** The text of the most recent assistant message, unless reconciled. */
  readonly finalOutput: string;
  readonly ending?: RunEnding;
  readonly truncation: TruncationRecord;
}

export function createRunProjection(): RunProjection {
  return {
    terminal: false,
    transcript: [],
    tools: [],
    diagnostics: [],
    links: [],
    usage: EMPTY_USAGE_SNAPSHOT,
    finalOutput: "",
    truncation: EMPTY_TRUNCATION_RECORD,
  };
}
