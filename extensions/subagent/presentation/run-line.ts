/**
 * Fitting a Run into a width: one algebra, one Label cap, three policies.
 *
 * Three surfaces draw a Run as a single line — the ambient widget's detail
 * row, the dashboard history's table row, and a completion notice's collapsed
 * line — and each used to carry its own arithmetic for deciding how many
 * columns the Label, the status word, the activity and the duration were worth
 * on a terminal of a given width. Three implementations of one idea meant the
 * Label could be capped at forty columns in two of them and forty-eight in the
 * third, and a maintainer changing how a line gives way had to find all three
 * and reason about each separately.
 *
 * So the arithmetic lives here and each surface supplies a **policy**: named
 * column budgets saying what its line is made of and what gives way first.
 * The widget's is label-first with an activity floor, a right-aligned duration
 * and a one-column inset; the dashboard history's is content-sized shared
 * columns with a selection prefix and a duration above eighty columns; a
 * notice's is agent-first, with the outcome never giving. A fourth surface is
 * a fourth policy value, not a fourth implementation.
 *
 * **This module fits; it does not paint.** It returns the parts of a line at
 * the widths they were allotted, and the surface that owns the line paints
 * them, joins them with its own separators and writes them to the screen. That
 * split is what lets three very differently painted surfaces share one
 * algebra, and it is why the theme never reaches this file.
 *
 * {@link fitToWidth} is the module's other job: the one wrapper over Pi's
 * width primitive. Clipping a line to a width and padding it out to fill one
 * were written five separate times across this module — once per Run surface,
 * once for the browser panel and once more for the identity banner — so a
 * change to how a line is elided had five places to land.
 */

import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type RunPresentation, runElapsed } from "./run-presentation.ts";

/**
 * Maximum visible Label columns, wherever a Run line names one.
 *
 * A Label is bounded to 200 UTF-8 bytes at admission, which is a bound on what
 * may be *stored*, not on what is worth *reading* in a column beside other
 * columns. On a wide terminal an unfitted Label would push the status word and
 * the duration so far right that a reader scanning a list could not find them.
 * A notice's collapsed line caps its Label further still — that is its own
 * policy, stated at its own surface, and this is the cap the surfaces that
 * draw a Run *beside other Runs* share.
 */
export const MAX_RUN_LABEL_WIDTH = 40;

/** How the one wrapper over Pi's width primitive should treat a line. */
export interface FitOptions {
  /** Pad the result out to the full width, so a list's columns line up. */
  readonly pad?: boolean;
  /**
   * The text is plain, so the clip's own resets are discarded.
   *
   * Pi's truncator may leave a reset sequence behind. On text a surface is
   * about to paint itself, that reset would land inside the paint and cut it
   * short; on text that is already painted, it is what closes the paint and
   * must stay.
   */
  readonly plain?: boolean;
}

/** Clip a line to a width by display cells, ANSI and wide graphemes included. */
export function fitToWidth(
  text: string,
  width: number,
  options: FitOptions = {},
): string {
  const columns = Math.max(0, width);
  const clipped = truncateToWidth(text, columns, "…");
  const fitted = options.plain ? stripTerminalSequences(clipped) : clipped;
  return options.pad
    ? fitted + " ".repeat(Math.max(0, columns - visibleWidth(fitted)))
    : fitted;
}

/**
 * The column a list of values shares: the widest of them, up to a cap.
 *
 * A table's columns are content-sized so that a list of short Labels does not
 * leave a third of the screen blank, and shared across the list so that the
 * status words below each other line up. Both are properties of the list, so
 * they are measured once for it rather than once per row.
 */
export function runLineColumn(
  values: readonly string[],
  cap = Number.POSITIVE_INFINITY,
): number {
  return Math.min(cap, Math.max(0, ...values.map(visibleWidth)));
}

/**
 * How many columns the Label may take.
 *
 * `column` and `cap` are the two ways it is sized and a policy states one of
 * them: `column` fixes its width for every row in a list, whatever this Run's
 * own Label needs, and `cap` lets it size to its own text up to a limit. A
 * Label sized to its text gives the columns it did not use to the parts after
 * it; one in a fixed column keeps them, which is what makes a table line up.
 *
 * The Label is the first part and is never dropped, so it has no gate, no gap
 * and no floor of its own. What it keeps when a later part presses is that
 * part's business, and is stated there.
 */
export interface RunLineLabelBudget {
  /** A column shared by every row in one list. See {@link runLineColumn}. */
  readonly column?: number;
  /** The most columns the Label takes when it sizes to its own text. */
  readonly cap?: number;
}

/**
 * How many columns the status word may take.
 *
 * It is drawn at a fixed width — a phase's word, or a column the list shares —
 * so it either fits or it does not: the two budgets below are the two ways a
 * surface says when it does not.
 */
export interface RunLineStatusBudget {
  /** A column shared by every row in one list. Absent: the word's own width. */
  readonly column?: number;
  /**
   * The status appears only once the parts share at least this many columns.
   *
   * Measured against what is left after the duration has reserved the right
   * edge, which is what the parts actually have to divide — not the width of
   * the line, which is what {@link RunLineDurationBudget.minLineWidth} reads.
   */
  readonly gate?: number;
  /**
   * The status appears only if it leaves the Label this many columns.
   *
   * The alternative to a gate, for a surface whose status word is as wide as
   * its Run's phase happens to be and so cannot state an absolute width.
   */
  readonly leaves?: number;
  /** Blank columns between the status and the Label. */
  readonly gap?: number;
}

/**
 * How many columns the activity may take.
 *
 * The activity is the part that absorbs whatever the Label did not use, so its
 * budgets are about what it holds back rather than what it occupies: `needs`
 * and `share` are the two ways a surface reserves columns for it before the
 * Label takes its own, and `leaves` is what it may never take from the Label.
 */
export interface RunLineActivityBudget {
  /**
   * The activity appears only once the parts share this many columns.
   *
   * Measured against what is left after the duration has reserved the right
   * edge. See {@link RunLineStatusBudget.gate}.
   */
  readonly gate?: number;
  /**
   * Columns held back for the activity before the Label takes its own, and the
   * width below which the activity gives way whole rather than clipping
   * further.
   *
   * Clamped to the activity's own text: an activity with three columns to show
   * does not hold back twelve. A surface that states this is one where half an
   * activity says less than none — `bash: …` names no tool.
   */
  readonly needs?: number;
  /**
   * Columns held back as a fraction of what the parts share, for a surface
   * whose activity shares out the remainder rather than giving way.
   */
  readonly share?: number;
  /** Columns the activity never takes from the Label. */
  readonly leaves?: number;
  /** Blank columns between the activity and the part before it. */
  readonly gap?: number;
}

/**
 * How many columns the Run's duration may take, at the line's right edge.
 *
 * A duration is its own budget because it is the one part placed from the
 * right rather than flowing from the left: it reserves its columns before
 * anything else is allotted, and what it does when the rest of the line will
 * not fit is a decision the other parts do not have.
 */
export interface RunLineDurationBudget {
  /** A column the duration is right-aligned in. Absent: it takes its own width. */
  readonly column?: number;
  /**
   * The whole line must be at least this wide before a duration is shown.
   *
   * Measured against the line, not against what the parts share, because
   * whether a screen can afford a clock at all is a fact about the screen.
   */
  readonly minLineWidth?: number;
  /** The least blank columns between the last part and the duration. */
  readonly gap?: number;
  /**
   * The duration gives way whole when any other part had to.
   *
   * A clock is the least of what a row says, so a surface may prefer to spend
   * its right edge on useful activity instead. One that does is fitted twice:
   * once with the duration reserved, and again without it when that cost the
   * line a part it would rather have kept.
   */
  readonly yields?: boolean;
}

/** What one surface's Run line is made of, and what gives way first. */
export interface RunLinePolicy {
  /**
   * Columns the surface keeps clear at each edge of the line it draws.
   *
   * Surface metadata rather than a budget: the fitting never subtracts it,
   * because a surface insets the line it *contains* rather than the line it
   * fits, and hands the fitting a width the inset has already come off. It is
   * stated here so that a policy value is the whole of what a surface decides
   * about its geometry.
   */
  readonly inset?: number;
  /**
   * Columns the surface has already spent before the first part.
   *
   * The dashboard history's selection prefix and a notice's agent, outcome and
   * hint are all this: columns the line does not have, that no budget here can
   * take back. Stating a notice's fixed parts this way is what "the outcome
   * never gives" means as a policy value.
   */
  readonly reserved?: number;
  readonly label: RunLineLabelBudget;
  readonly status?: RunLineStatusBudget;
  readonly activity?: RunLineActivityBudget;
  readonly duration?: RunLineDurationBudget;
  /** Pad each part out to its column, so a list's columns line up. */
  readonly padded?: boolean;
  /** Every part's text is plain. See {@link FitOptions.plain}. */
  readonly plain?: boolean;
}

/** The text of each part of a Run line, before any of it is fitted. */
export interface RunLineParts {
  readonly label: string;
  readonly status?: string;
  readonly activity?: string;
  readonly duration?: string;
}

/**
 * What a Run line's parts say, from a Run whose presentation is resolved.
 *
 * A surface may still say one of them differently — the dashboard history
 * writes its status word as a table heading — but what a Run *means* was
 * decided once, in `run-presentation.ts`, and nothing here reopens it.
 */
export function runLineParts(
  run: RunPresentation,
  now: number,
): Required<RunLineParts> {
  return {
    label: run.label,
    status: run.status.text,
    activity: run.activity,
    duration: runElapsed(run, now),
  };
}

/** One Run line's parts, each clipped to the columns it was allotted. */
export interface FittedRunLine {
  /** The Label. Empty when the line had no room for even one column of it. */
  readonly label: string;
  /** Present when the part was drawn at all. */
  readonly status?: string;
  readonly activity?: string;
  /** Already right-aligned in its column, where the policy gives it one. */
  readonly duration?: string;
  /** Blank columns between the last part and the duration. */
  readonly gap: number;
}

/** One fitting, and whether it cost the line a part the policy declared. */
interface FitPass {
  readonly line: FittedRunLine;
  readonly complete: boolean;
}

/**
 * Fit a Run's parts into a width, under one surface's policy.
 *
 * Parts flow from the left in the order the policy names them — Label, status,
 * activity — and the first that cannot be drawn ends the line: a row too
 * narrow for its status word has no room for the activity beside it either,
 * and a fragment of one would say less than the Label alone. The duration is
 * placed from the right and reserves its columns first, so what remains is
 * what the rest of the line shares.
 */
export function fitRunLine(
  parts: RunLineParts,
  policy: RunLinePolicy,
  width: number,
): FittedRunLine {
  const pass = fitPass(parts, policy, width, policy.duration !== undefined);
  return pass.complete || !policy.duration?.yields
    ? pass.line
    : fitPass(parts, policy, width, false).line;
}

const EMPTY_LINE: FittedRunLine = { label: "", gap: 0 };

function fitPass(
  parts: RunLineParts,
  policy: RunLinePolicy,
  width: number,
  allowDuration: boolean,
): FitPass {
  const fit = (text: string, columns: number) =>
    fitToWidth(text, columns, {
      pad: policy.padded ?? false,
      plain: policy.plain ?? false,
    });
  const columns = Math.max(0, width - (policy.reserved ?? 0));

  const duration = policy.duration;
  const durationText = parts.duration ?? "";
  const durationColumn = duration?.column ?? visibleWidth(durationText);
  const durationGap = duration?.gap ?? 0;
  const showDuration =
    allowDuration &&
    duration !== undefined &&
    durationColumn > 0 &&
    width >= (duration.minLineWidth ?? 0);
  const available = columns - (showDuration ? durationColumn + durationGap : 0);
  if (available <= 0) return { line: EMPTY_LINE, complete: false };

  const status = policy.status;
  const statusText = parts.status ?? "";
  const statusColumn = status?.column ?? visibleWidth(statusText);
  const statusGap = status?.gap ?? 0;
  const showStatus =
    status !== undefined &&
    statusColumn > 0 &&
    available >= (status.gate ?? 0) &&
    (status.leaves === undefined ||
      available - statusColumn - statusGap >= status.leaves);

  const activity = policy.activity;
  const activityText = parts.activity ?? "";
  const activityGap = activity?.gap ?? 0;
  let showActivity =
    (status === undefined || showStatus) &&
    activity !== undefined &&
    available >= (activity.gate ?? 0);

  const labelWant =
    policy.label.column ??
    visibleWidth(fitToWidth(parts.label, policy.label.cap ?? available));
  const beside =
    available - (showStatus ? statusColumn + statusGap : 0) - activityGap;

  let labelColumns = 0;
  let activityColumns = 0;
  if (showActivity && activity !== undefined) {
    const room = Math.max(0, beside);
    const held =
      activity.share !== undefined
        ? Math.floor(available * activity.share)
        : Math.min(activity.needs ?? 0, visibleWidth(activityText));
    labelColumns = Math.min(
      labelWant,
      Math.max(activity.leaves ?? 0, room - held),
    );
    activityColumns = Math.max(0, room - labelColumns);
    if (activity.needs !== undefined && activityColumns < held) {
      showActivity = false;
    }
  }
  if (!showActivity) {
    labelColumns = Math.min(labelWant, Math.max(0, beside + activityGap));
  }

  const label = labelColumns > 0 ? fit(parts.label, labelColumns) : "";
  const fittedStatus = showStatus ? fit(statusText, statusColumn) : undefined;
  const fittedActivity =
    showActivity && activityColumns > 0
      ? fit(activityText, activityColumns)
      : undefined;
  // Measured, not budgeted: an unpadded part clipped at a wide grapheme
  // occupies a column less than it was allotted. The Label is always the first
  // part and always spends its own columns, a Label of none included, so every
  // part after it pays for its gap whether or not the Label drew anything.
  const inline =
    visibleWidth(label) +
    (fittedStatus === undefined ? 0 : statusGap + visibleWidth(fittedStatus)) +
    (fittedActivity === undefined
      ? 0
      : activityGap + visibleWidth(fittedActivity));
  const fittedDuration = showDuration
    ? fitToWidth(durationText, durationColumn)
    : undefined;

  return {
    line: {
      label,
      ...(fittedStatus === undefined || fittedStatus === ""
        ? {}
        : { status: fittedStatus }),
      ...(fittedActivity === undefined || fittedActivity === ""
        ? {}
        : { activity: fittedActivity }),
      ...(fittedDuration === undefined
        ? {}
        : {
            duration:
              " ".repeat(
                Math.max(0, durationColumn - visibleWidth(fittedDuration)),
              ) + fittedDuration,
          }),
      gap: showDuration ? Math.max(0, columns - inline - durationColumn) : 0,
    },
    complete:
      label !== "" &&
      (status === undefined || showStatus) &&
      (activity === undefined || showActivity),
  };
}
