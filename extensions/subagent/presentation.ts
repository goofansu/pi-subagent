/**
 * Presentation: how run state, notifications, and retained results read.
 *
 * This is the one module that interprets lifecycle status for display — its
 * glyph, tone, verbs, phrases, notification text, and result text. Surfaces (the widget, the transcript renderers) compose
 * their own lines from what this module hands them; none of them decides
 * what a status *means*. Adding or renaming a status is a change here, and
 * the exhaustive table below is what turns the old cross-module hunt into
 * a compile error.
 */

import { getFinalOutput } from "./messages.ts";
import type { LifecycleStatus, SingleResult } from "./types.ts";

/** Maximum characters of completed output included in a notification. */
export const NOTIFICATION_PREVIEW_CHARACTER_LIMIT = 1_000;

/**
 * What each status looks and sounds like, in one place.
 *
 * `glyph` matches Herdr's `state_icon` dots: a `●` whose color carries the
 * state — yellow working, green done, red blocked — so the widget reads the
 * same as the agent sidebar the operator already watches. Herdr has no
 * cancelled state; the hollow `○` marks a run nothing came of.
 *
 * `verb` is the collapsed notification line's status word. `phrase` narrates
 * the same status next to its duration.
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
    // No duration: a live clock would need a once-a-second redraw of the
    // whole widget, and the settled phrases already say what a run cost in
    // time once that number stops moving.
    phrase: () => "running",
  },
  completed: {
    glyph: "●",
    tone: "success",
    verb: "completed",
    phrase: (duration) => `completed in ${duration}`,
  },
  failed: {
    glyph: "●",
    tone: "error",
    verb: "failed",
    phrase: (duration) => `failed after ${duration}`,
  },
  cancelled: {
    glyph: "○",
    tone: "error",
    verb: "cancelled",
    phrase: (duration) => `cancelled after ${duration}`,
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

/** The word a collapsed notification says about a run. */
export function notificationVerb(status: LifecycleStatus): string {
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

/** Deterministic head preview, preferring a nearby newline before the limit. */
function notificationPreview(text: string): string {
  if (text.length <= NOTIFICATION_PREVIEW_CHARACTER_LIMIT) return text;
  const candidate = text.slice(0, NOTIFICATION_PREVIEW_CHARACTER_LIMIT);
  const newline = candidate.lastIndexOf("\n");
  const cut =
    newline >= NOTIFICATION_PREVIEW_CHARACTER_LIMIT * 0.7
      ? newline
      : NOTIFICATION_PREVIEW_CHARACTER_LIMIT;
  return `${text.slice(0, cut)}\n…`;
}

/**
 * Everything a run said, before any cap is applied.
 *
 * The field priority for a failure — `errorMessage`, then `stderr`, then the
 * transcript — is the executor's population order read back, and this module
 * is the only reader that knows it.
 */
export function fullOutput(result: SingleResult): string {
  const output = getFinalOutput(result.messages);
  switch (result.lifecycle.phase) {
    case "running":
      return "";
    case "completed":
      return output;
    case "failed": {
      const partialOutput = output.trim();
      const sections = ["This run failed before completing."];
      if (result.errorMessage) sections.push(`Failure: ${result.errorMessage}`);
      if (result.stderr) sections.push(`Diagnostics:\n\n${result.stderr}`);
      sections.push(
        partialOutput
          ? `Output produced before failure:\n\n${partialOutput}`
          : "The run failed before producing output.",
      );
      return sections.join("\n\n");
    }
    case "cancelled": {
      const partialOutput = output.trim();
      return partialOutput
        ? `This run was cancelled before finishing.\n\nOutput produced before cancellation:\n\n${partialOutput}`
        : "The run was cancelled before producing output.";
    }
  }
}

/** Small status-specific orientation message for one terminal run. */
export function formatNotification(id: string, result: SingleResult): string {
  const name = `${result.agent} (${id})`;
  const pointer = `Use agent_result with id ${id} to retrieve the full result.`;

  switch (result.lifecycle.phase) {
    case "running":
      throw new Error(`Cannot notify for running subagent ${id}`);
    case "completed": {
      const output = getFinalOutput(result.messages).trim();
      const preview = output
        ? notificationPreview(output)
        : "No output was produced.";
      return `Subagent ${name} completed.\n\n${preview}\n\n${pointer}`;
    }
    case "failed": {
      // Bounded like the completed preview (N1): the primary error is
      // normally short, but nothing upstream guarantees it, and the whole
      // message stays behind agent_result either way.
      const reason = notificationPreview(
        result.errorMessage || "no reason reported",
      );
      return `Subagent ${name} failed: ${reason}\n\n${pointer}`;
    }
    case "cancelled":
      return `Subagent ${name} was cancelled (${result.lifecycle.reason}).`;
  }
}
