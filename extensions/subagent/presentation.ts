/**
 * Presentation: how a run and its report read to a human, everywhere.
 *
 * This is the one module that interprets a lifecycle status for display —
 * its glyph, its tone, its verbs, its phrases, and what a settled run's
 * report says, including which result field carries the text and which end
 * gets trimmed. Surfaces (the widget, the transcript renderers) compose
 * their own lines from what this module hands them; none of them decides
 * what a status *means*. Adding or renaming a status is a change here, and
 * the exhaustive table below is what turns the old cross-module hunt into
 * a compile error.
 */

import { getFinalOutput } from "./messages.ts";
import type { LifecycleStatus, SingleResult } from "./types.ts";

/**
 * Cap on a pushed report, in characters.
 *
 * A backstop, not a budget. A report arrives uninvited, so a runaway agent
 * that returns a whole file should not be able to swamp the parent's context —
 * but a thorough agent's genuine answer must never be cut, because there is
 * nowhere to recover the rest from: the run is released the moment it is
 * delivered, and there is deliberately no tool to fetch a report twice. Set it
 * high enough that only the pathological case reaches it.
 */
export const REPORT_CHARACTER_LIMIT = 24_000;

/**
 * Cap on the reason a failed run reports.
 *
 * Tighter than a report, and kept from the *end* rather than the beginning: a
 * failure's diagnosis is the last thing said before it died, which is the same
 * reason `appendStderr` keeps the tail.
 */
export const FAILURE_REASON_LIMIT = 4_000;

/**
 * What each status looks and sounds like, in one place.
 *
 * `glyph` matches Herdr's `state_icon` dots: a `●` whose color carries the
 * state — yellow working, green done, red blocked — so the widget reads the
 * same as the agent sidebar the operator already watches. Herdr has no
 * cancelled state; the hollow `○` marks a run nothing came of.
 *
 * `verb` is the collapsed report line's word: "reported" marks a delivery,
 * where a bare "completed" would state a fact about a run the reader has not
 * seen. `phrase` narrates the same status next to its duration.
 */
const STATUS_PRESENTATION: Record<
  LifecycleStatus,
  {
    glyph: string;
    tone: string;
    verb: string;
    phrase: (duration: string) => string;
  }
> = {
  running: {
    glyph: "●",
    tone: "warning",
    verb: "running",
    phrase: (duration) => `running for ${duration}`,
  },
  completed: {
    glyph: "●",
    tone: "success",
    verb: "reported",
    phrase: (duration) => `completed in ${duration}`,
  },
  failed: {
    glyph: "●",
    tone: "error",
    verb: "failed",
    phrase: (duration) => `failed after ${duration}`,
  },
  aborted: {
    glyph: "○",
    tone: "error",
    verb: "aborted",
    phrase: (duration) => `aborted after ${duration}`,
  },
};

/** One glyph per lifecycle state; the widget paints it in the status tone. */
export function runStatusGlyph(status: LifecycleStatus): string {
  return STATUS_PRESENTATION[status].glyph;
}

/** The theme colour a status should be painted in. */
export function runStatusTone(status: LifecycleStatus): string {
  return STATUS_PRESENTATION[status].tone;
}

/** The word a collapsed report line says a run did. */
export function reportVerb(status: LifecycleStatus): string {
  return STATUS_PRESENTATION[status].verb;
}

/** A run's lifecycle in words, with the time it took. */
export function formatRunStatus(run: {
  status: LifecycleStatus;
  elapsedMs: number;
}): string {
  return STATUS_PRESENTATION[run.status].phrase(formatDuration(run.elapsedMs));
}

/** A duration for humans: tenths under a minute, then m/s, then h/m. */
export function formatDuration(milliseconds: number): string {
  const clampedMilliseconds = Math.max(0, milliseconds);
  const tenths = Math.round(clampedMilliseconds / 100);
  if (tenths < 60 * 10) return `${(tenths / 10).toFixed(1)}s`;

  const wholeSeconds = Math.round(clampedMilliseconds / 1000);
  if (wholeSeconds < 60 * 60) {
    return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
  }

  const hours = Math.floor(wholeSeconds / (60 * 60));
  const minutes = Math.floor((wholeSeconds % (60 * 60)) / 60);
  return `${hours}h ${minutes}m`;
}

/** A character count for a summary line, abbreviated once it gets long. */
export function formatCharacterCount(characters: number): string {
  if (characters < 1_000) return `${characters} characters`;
  return `${(characters / 1_000).toFixed(1)}k characters`;
}

/**
 * Keep the head, and say what was dropped.
 *
 * Naming the shortfall matters more than the trim: a report that just stops
 * reads like a report that finished, and a model will act on it as though it
 * were whole.
 */
function keepHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}\n\n[... ${dropped} more characters dropped; this report is incomplete ...]`;
}

/** Keep the tail, for text whose end is the part that explains it. */
function keepTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `[... ${dropped} earlier characters dropped ...]\n${text.slice(-limit)}`;
}

/**
 * Everything a run said, before any cap is applied.
 *
 * The field priority for a failure — `errorMessage`, then `stderr`, then the
 * transcript — is the executor's population order read back, and this module
 * is the only reader that knows it.
 */
export function fullOutput(result: SingleResult): string {
  if (result.status === "aborted") return "";
  if (result.status === "failed") {
    return (
      result.errorMessage || result.stderr || getFinalOutput(result.messages)
    );
  }
  return getFinalOutput(result.messages).trim();
}

/**
 * The report text for one settled run — the part of a delivery the model
 * actually reads. The verb here is load-bearing: without it a failure's
 * stderr tail would read exactly like an answer.
 */
export function formatReport(id: string, result: SingleResult): string {
  const name = `${result.agent} (${id})`;

  if (result.status === "aborted") {
    return `Subagent ${name} was cancelled before it finished.`;
  }
  if (result.status === "failed") {
    const reason =
      result.errorMessage || result.stderr || getFinalOutput(result.messages);
    return `Subagent ${name} failed: ${
      reason ? keepTail(reason, FAILURE_REASON_LIMIT) : "no reason reported"
    }`;
  }

  const output = getFinalOutput(result.messages).trim();
  if (!output) return `Subagent ${name} finished without output.`;

  return `Subagent ${name} finished:\n\n${keepHead(output, REPORT_CHARACTER_LIMIT)}`;
}
