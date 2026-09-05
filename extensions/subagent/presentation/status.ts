/**
 * What a Run's phase looks and sounds like, and how numbers are written.
 *
 * Every surface that says something about a Run — a widget row, a tool
 * outcome, a completion notice, a result card — reads its tone, its verb, and
 * its phrase from the one table below. None of them decides what a phase
 * means. Adding a phase to the domain therefore fails to compile here first,
 * which is where the decision belongs.
 *
 * v2 has five Run phases where v1 had four: `finalizing` is the window between
 * a backend's execution ending and the Run settling, and it exists so a
 * surface never shows a Run as terminal while its cleanup is still running.
 * It gets its own verb and its own tone rather than borrowing `running`'s,
 * because a reader watching a row wants to know the difference.
 */

import type { RunPhase, TerminalRunPhase } from "../domain/index.ts";

/** The theme colours presentation may select. */
export type Tone = "warning" | "success" | "error";

/**
 * The theme backgrounds a widget row may be painted on.
 *
 * These are the three Pi paints its own tool calls with — pending while a call
 * runs, then success or error — so a Run's row reads as what it is: a tool
 * call the parent made, in the same colours as the tool calls above it.
 */
export type Background = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

/**
 * One row per phase: the colour, the status word, and the phrase that narrates
 * it beside a duration.
 *
 * `running` and `finalizing` name no duration in their *phrase*, which is
 * what a sentence about a Run reads. The widget row shows a live duration in
 * its own column instead, and redraws to keep it honest; a phrase that named
 * one would be stale the moment it was written into a tool result.
 */
const PHASE_PRESENTATION: {
  readonly [P in RunPhase]: {
    readonly tone: Tone;
    readonly background: Background;
    readonly glyph: string;
    readonly verb: string;
    readonly phrase: (duration: string) => string;
  };
} = {
  running: {
    tone: "warning",
    background: "toolPendingBg",
    // A live Run's glyph is the spinner, which the widget draws from the
    // instant it renders at; this is the frame a still picture shows.
    glyph: "⠿",
    verb: "running",
    phrase: () => "running",
  },
  finalizing: {
    tone: "warning",
    background: "toolPendingBg",
    glyph: "◌",
    verb: "finalizing",
    phrase: () => "finalizing",
  },
  completed: {
    tone: "success",
    background: "toolSuccessBg",
    glyph: "✓",
    verb: "completed",
    phrase: (duration) => `completed in ${duration}`,
  },
  failed: {
    tone: "error",
    background: "toolErrorBg",
    glyph: "✗",
    verb: "failed",
    phrase: (duration) => `failed after ${duration}`,
  },
  cancelled: {
    tone: "error",
    background: "toolErrorBg",
    glyph: "⊘",
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
 * The one character a widget row leads with for a Run in this phase.
 *
 * Every glyph is East Asian Width *neutral*, deliberately: a terminal in a
 * CJK locale draws an *ambiguous*-width character two cells wide while
 * `visibleWidth` counts one, and a column that is off by one on some
 * terminals is a column that is not aligned. The glyph is never the only
 * encoding of the phase — the word beside it says the same thing — so a font
 * that lacks one loses nothing a reader needed.
 */
export function runPhaseGlyph(phase: RunPhase): string {
  return PHASE_PRESENTATION[phase].glyph;
}

/** The theme background a widget row for this phase is painted on. */
export function runPhaseBackground(phase: RunPhase): Background {
  return PHASE_PRESENTATION[phase].background;
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
