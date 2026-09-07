/**
 * What a Run's phase looks and sounds like, and how numbers are written.
 *
 * Every surface that says something about a Run — a widget row, a dashboard
 * row, a tool outcome, a completion notice, a result card — reads this module,
 * the operational surfaces through `run-presentation.ts` rather than directly.
 * The table below is the baseline: one word and one tone per phase, and none
 * decided locally. What a *cancellation* then does to that word and that tone
 * is the resolution's, in `run-presentation.ts`, because it is a fact about a
 * Run rather than about a phase. Adding a phase to the domain fails to compile
 * here first, which is where the decision belongs.
 *
 * v2 has five Run phases where v1 had four: `finalizing` is the window between
 * a backend's execution ending and the Run settling, and it exists so a
 * surface never shows a Run as terminal while its cleanup is still running.
 * It gets its own verb and its own tone rather than borrowing `running`'s,
 * because a reader watching a row wants to know the difference.
 *
 * The tones here are what a phase *means*, and a surface may still decline
 * them: the ambient widget flattens ordinary operational tones to one muted
 * foreground, because a count an operator has already delegated does not need
 * colour to restate the word beside it. That decision is stated at the
 * widget's own seam. This table remains the shared meaning every other surface
 * reads, and the only place a new phase's tone is decided.
 */

import {
  isTerminalRunPhase,
  type RunPhase,
  type TerminalRunPhase,
} from "../domain/index.ts";

/** The theme colours presentation may select. */
export type Tone = "warning" | "success" | "error" | "muted";

/**
 * One row per phase: the colour, the status word, and the phrase that narrates
 * it beside a duration.
 *
 * `running` and `finalizing` name no duration in their *phrase*, which is
 * what a sentence about a Run reads. A phrase that named a live duration
 * would be stale the moment it was written into a tool result.
 */
const PHASE_PRESENTATION: {
  readonly [P in RunPhase]: {
    readonly tone: Tone;
    readonly verb: string;
    readonly phrase: (duration: string) => string;
  };
} = {
  running: {
    tone: "warning",
    verb: "running",
    phrase: () => "running",
  },
  finalizing: {
    tone: "warning",
    verb: "finalizing",
    phrase: () => "finalizing",
  },
  completed: {
    tone: "success",
    verb: "completed",
    phrase: (duration) => `completed in ${duration}`,
  },
  failed: {
    tone: "error",
    verb: "failed",
    phrase: (duration) => `failed after ${duration}`,
  },
  cancelled: {
    tone: "error",
    verb: "cancelled",
    phrase: (duration) => `cancelled after ${duration}`,
  },
};

/** Phase order used by widget summaries, so two Sessions read the same way. */
export const RUN_PHASE_DISPLAY_ORDER = Object.freeze(
  Object.keys(PHASE_PRESENTATION) as RunPhase[],
);

/** The theme colour a phase should be painted in. */
export function runPhaseTone(phase: RunPhase): Tone {
  return PHASE_PRESENTATION[phase].tone;
}

/** The one word a collapsed line says about a Run in this phase. */
export function runPhaseVerb(phase: RunPhase): string {
  return PHASE_PRESENTATION[phase].verb;
}

/**
 * The verb a completion notice's opening sentence uses.
 *
 * A second dictionary rather than a sixth column on the phase table, and
 * keyed by the *terminal* phases alone, because only a terminal Run has a
 * notice: a table that had to invent a sentence for `running` would be
 * inviting one to be written.
 *
 * It differs from {@link runPhaseVerb} in one entry. A column reads
 * `cancelled` because a column is a label; a sentence reads `was cancelled`
 * because a Run does not cancel itself, and the notice is the one surface
 * that says so in prose.
 */
const NOTICE_VERB: { readonly [P in TerminalRunPhase]: string } = {
  completed: "completed",
  failed: "failed",
  cancelled: "was cancelled",
};

export function runPhaseNoticeVerb(phase: TerminalRunPhase): string {
  return NOTICE_VERB[phase];
}

/** A Run's phase in words, with the time it took where that is meaningful. */
export function formatRunPhase(run: {
  readonly phase: RunPhase;
  readonly elapsedMillis: number;
}): string {
  return PHASE_PRESENTATION[run.phase].phrase(
    formatDuration(run.elapsedMillis),
  );
}

/** A duration for humans: tenths under a minute, then m/s, then h/m. */
export function formatDuration(milliseconds: number): string {
  const clamped = Math.max(0, milliseconds);
  const tenths = Math.round(clamped / 100);
  if (tenths < 60 * 10) return `${(tenths / 10).toFixed(1)}s`;

  const wholeSeconds = Math.round(clamped / 1000);
  if (wholeSeconds < 60 * 60) {
    return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
  }

  const hours = Math.floor(wholeSeconds / (60 * 60));
  const minutes = Math.floor((wholeSeconds % (60 * 60)) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * How long a Run has been going, or how long it went for. The one rule.
 *
 * A live Run is measured against the supplied instant; a settled one has
 * stopped, and is measured against the instant it stopped at, which it carries
 * itself. That is the difference between naming what a Run cost and naming how
 * long ago it started: a settled row stays on screen until its completion
 * notice lands, and a duration recomputed against a later clock on every redraw
 * climbs the whole time it waits. A widget row and a result card once disagreed
 * about one Run for exactly that reason.
 *
 * `now` is optional because a terminal Run never needs it: the phase decides
 * which instant ends the Run, and for a terminal phase that instant is the
 * Run's own. A caller holding a stored Result therefore supplies nothing.
 *
 * `undefined` means the duration is not knowable — a terminal phase whose
 * settled instant is missing, which the published row's invariant says cannot
 * happen. It is reported rather than guessed, so that a caller with nothing to
 * print says so instead of printing a number that climbs.
 *
 * Presentation still reads no clock of its own: a renderer calling `Date.now()`
 * would produce a different string every time it was asked, which is not
 * something a golden test can pin.
 */
export function runElapsedMillis(
  run: {
    readonly phase: RunPhase;
    readonly startedAt: number;
    readonly settledAt?: number;
  },
  now?: number,
): number | undefined {
  const end = isTerminalRunPhase(run.phase) ? run.settledAt : now;
  return end === undefined ? undefined : Math.max(0, end - run.startedAt);
}

/** Elapsed Run duration at a supplied event instant; terminal durations freeze. */
export function formatRunElapsed(
  run: {
    readonly phase: RunPhase;
    readonly startedAt: number;
    readonly settledAt?: number;
  },
  now: number,
): string {
  const millis = runElapsedMillis(run, now);
  return millis === undefined ? "—" : formatDuration(millis);
}

/** A character count for a summary line, abbreviated once it gets long. */
export function formatCharacterCount(characters: number): string {
  if (characters < 1_000) return `${characters} characters`;
  return `${(characters / 1_000).toFixed(1)}k characters`;
}

/** A token or turn count, abbreviated the way an accounting line wants it. */
export function formatTokenCount(value: number): string {
  if (Math.abs(value) < 1_000) return String(value);

  const units = ["k", "m", "b", "t"];
  let scaled = value / 1_000;
  let unit = 0;
  while (Math.abs(scaled) >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit++;
  }
  // Promote a value whose one-decimal rendering crosses the next boundary, so
  // nothing ever reads as "1000.0k".
  if (Math.abs(Number(scaled.toFixed(1))) >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit++;
  }
  return `${scaled.toFixed(1)}${units[unit]}`;
}

/** Turn accounting, with the grammar a single turn needs. */
export function formatTurns(turns: number): string {
  if (turns === 0) return "—";
  return `${turns} ${turns === 1 ? "turn" : "turns"}`;
}
