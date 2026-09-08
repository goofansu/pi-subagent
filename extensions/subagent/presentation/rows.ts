/**
 * Ambient widget: aggregate state and, for exactly one active Run, one detail line.
 *
 * A single active Run reads in priority order: Label, state, useful activity,
 * elapsed Run duration. Duration is right-aligned; Labels share history's
 * 40-column cap and shrink further to preserve useful activity.
 *
 * ```
 *  subagents   1 running   1 completed
 *  look around  running · grep: x                      12.4s
 * ```
 *
 * A live row has no spinner or ticking clock. Elapsed time uses the host's
 * latest Run-event sample, independent of activity. No glyph column either:
 * the state word already says which phase the Run is in.
 *
 * The widget is a quiet surface: borderless, painted on the terminal's default
 * background, and monochrome apart from an accented title and the error tone
 * kept for a failed Run or a completion hand-off that needs attention. It sits
 * above the editor for the whole session, so ordinary progress reads as
 * foreground text rather than a coloured block — the words already say which
 * phase a Run is in. Terminal Runs contribute only counts to the widget,
 * never individual rows.
 *
 * Deliberately no Run id and no model. The widget is read by the operator, and
 * a human names a Run by its agent and what it is doing; ids live in tool
 * results and notifications, where the model that acts on them reads them.
 * Deliberately no tool count and no context gauge either: both were tried,
 * and neither told an operator anything they acted on.
 *
 * This module formats. It does not decide which Runs exist, when the widget
 * appears, or when it redraws — those are host concerns, and a presentation
 * module that knew them would be holding lifecycle state. Nothing here reads
 * a clock; the host supplies the event instant as plain presentation input.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { isTerminalRunPhase, type RunPhase } from "../domain/index.ts";
import {
  fitRunLine,
  MAX_RUN_LABEL_WIDTH,
  type RunLinePolicy,
  runLineParts,
} from "./run-line.ts";
import { runPresentationFromRow } from "./run-presentation.ts";
import { RUN_PHASE_DISPLAY_ORDER, runPhaseVerb, type Tone } from "./status.ts";
import { fitToWidth } from "./text-width.ts";
import type { FailedHandoffStatus, RunRowView } from "./views.ts";

/**
 * The theme surface every subagent renderer uses.
 *
 * `italic` and `inverse` have no production caller. They are kept because an
 * instrumented theme cannot prove a renderer left slanted or inverted text
 * alone unless it is able to produce some, and the widget's quiet-surface
 * promise is exactly that.
 */
export interface RenderableTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  inverse(text: string): string;
}

/** Label and status are separated by two spaces. */
export const ROW_DELIMITER = "  ";
const ACTIVITY_DELIMITER = " · ";

/** A recognisable Label prefix retained before shortening activity. */
const MIN_LABEL_WIDTH = 7;

/** A shortened activity remains useful at this width (`bash: …`, for example). */
const MIN_ACTIVITY_WIDTH = 12;

/**
 * The widget's column budgets: label-first, with an activity floor.
 *
 * The Label leads and keeps a recognisable prefix; the state word gives way
 * only when the Label would be left with nothing beside it; the activity gives
 * way whole rather than being cut below the width at which `bash: …` still
 * says something. Elapsed duration reserves the right edge, and is the first
 * thing dropped when reserving it would have cost the line useful activity —
 * a clock is the least of what this row says.
 *
 * The inset is the widget's own: rows are drawn one column in from each edge,
 * so the right-aligned duration stops one column short. Nothing pads the right
 * column, because there is no background to carry to the edge.
 *
 * ADR-0035's presentation note is this value. Elapsed duration belongs to the
 * one active Run's detail line and is sampled at the instant the host supplies;
 * terminal Runs never reach this policy at all, because
 * {@link renderRunRows} draws them as aggregate counts instead.
 */
export const WIDGET_RUN_LINE: RunLinePolicy = {
  inset: 1,
  plain: true,
  label: { cap: MAX_RUN_LABEL_WIDTH },
  status: { leaves: 1, gap: ROW_DELIMITER.length },
  activity: {
    needs: MIN_ACTIVITY_WIDTH,
    leaves: MIN_LABEL_WIDTH,
    gap: ACTIVITY_DELIMITER.length,
  },
  duration: { gap: ROW_DELIMITER.length, yields: true },
};

interface DetailPart {
  readonly text: string;
  readonly paint: (text: string) => string;
  readonly separator?: string;
}

function paintParts(parts: readonly DetailPart[]): string {
  return parts
    .map(
      (part, index) =>
        (index === 0 ? "" : (part.separator ?? ROW_DELIMITER)) +
        part.paint(part.text),
    )
    .join("");
}

/**
 * One active Run as a single width-aware line.
 *
 * The fitting is `run-line.ts`'s under {@link WIDGET_RUN_LINE}; what is left
 * here is the paint. What the row *says* about a Run is resolved once, in
 * `run-presentation.ts`, so a terminal row here reads the same as the
 * dashboard history's rather than keeping a second rule for the activity cell.
 * The widget draws no terminal row — {@link renderRunRows} keeps only active
 * ones — so that branch reaches this formatter through its own interface alone.
 */
export function formatRunRow(
  row: RunRowView,
  theme: RenderableTheme,
  width: number,
  now: number,
): string {
  const run = runPresentationFromRow(row);
  const fitted = fitRunLine(runLineParts(run, now), WIDGET_RUN_LINE, width);
  const parts: DetailPart[] = [];
  if (fitted.label) {
    parts.push({
      text: fitted.label,
      paint: (text) => theme.fg("toolTitle", theme.bold(text)),
    });
  }
  if (fitted.status) {
    parts.push({
      // The shared derivation supplies the word; the tone it would carry is
      // deliberately dropped here. Only running, finalizing and cancelling
      // reach this line, and none of the three is news.
      text: fitted.status,
      paint: (text) => theme.fg("muted", text),
    });
  }
  if (fitted.activity) {
    parts.push({
      text: fitted.activity,
      separator: ` ${theme.fg("dim", "·")} `,
      paint: (text) => theme.fg("muted", text),
    });
  }

  const line =
    paintParts(parts) +
    (fitted.duration === undefined
      ? ""
      : " ".repeat(fitted.gap) + theme.fg("dim", fitted.duration));
  return visibleWidth(line) <= width
    ? line
    : fitToWidth(line, width, { pad: true });
}

/** How many listed Runs are in each phase, in the shared display order. */
function phaseCounts(
  rows: readonly RunRowView[],
): readonly (readonly [RunPhase, number])[] {
  const counts = new Map<RunPhase, number>();
  for (const row of rows) {
    counts.set(row.phase, (counts.get(row.phase) ?? 0) + 1);
  }
  return RUN_PHASE_DISPLAY_ORDER.flatMap((phase) => {
    const count = counts.get(phase) ?? 0;
    return count > 0 ? [[phase, count] as const] : [];
  });
}

/** Summarise the listed Runs in prose, using the shared phase vocabulary. */
export function formatRowSummary(rows: readonly RunRowView[]): string {
  return phaseCounts(rows)
    .map(([phase, count]) => `${count} ${runPhaseVerb(phase)}`)
    .join(", ");
}

/**
 * A summary chip separates Run state from exceptional hand-off attention.
 * Chips contain only aggregate facts, so the host can compare them without
 * depending on hidden activity, identities, or accounting.
 */
interface SummaryChip {
  readonly text: string;
  readonly tone: Tone;
  readonly attention: boolean;
}

/**
 * The one tone the widget paints an aggregate count in.
 *
 * The shared phase tones say what a phase *means*, and every other surface
 * wants that. This one does not: an operator reads the widget out of the
 * corner of their eye all session, and a warning-toned `2 running` was colour
 * spent restating a word already on the line. Only a failed Run keeps its
 * semantic tone here, because it is the one count that asks to be acted on.
 *
 * A table rather than a predicate, for the same reason `status.ts` keeps one:
 * a sixth Run phase has to be given a tone here to compile, rather than
 * falling quietly into the muted majority.
 */
const WIDGET_PHASE_TONE: { readonly [P in RunPhase]: Tone } = {
  running: "muted",
  finalizing: "muted",
  completed: "muted",
  failed: "error",
  cancelled: "muted",
};

const HANDOFF_ATTENTION: Record<FailedHandoffStatus, string> = {
  exhausted: "notification failed",
  unannounceable: "no notification · result unavailable",
};

/**
 * All Run-dependent facts displayed in the aggregate header, in display order.
 * The host compares these chips to suppress redraws: for fixed width/theme,
 * equal chips MUST render equal headers. New displayed facts belong here,
 * never in a separate header read of activity, accounting, identity, or time.
 */
export function widgetSummary(
  rows: readonly RunRowView[],
): readonly SummaryChip[] {
  const cancelling = rows.filter(
    (row) => !isTerminalRunPhase(row.phase) && row.cancellation !== undefined,
  ).length;
  const chips: SummaryChip[] = phaseCounts(
    rows.filter(
      (row) => isTerminalRunPhase(row.phase) || row.cancellation === undefined,
    ),
  ).map(([phase, count]) => ({
    text: `${count} ${runPhaseVerb(phase)}`,
    tone: WIDGET_PHASE_TONE[phase],
    attention: false,
  }));
  if (cancelling > 0) {
    chips.unshift({
      text: `${cancelling} cancelling`,
      tone: "muted",
      attention: false,
    });
  }
  for (const [handoff, text] of Object.entries(HANDOFF_ATTENTION)) {
    const count = rows.filter(
      (row) => isTerminalRunPhase(row.phase) && row.handoff === handoff,
    ).length;
    if (count === 0) continue;
    chips.push({
      text: `${count} ${text}`,
      tone: "error",
      attention: true,
    });
  }
  return chips;
}

/**
 * The title line above the rows: the widget's name and one chip per phase.
 *
 * No rule and no border. The editor draws its own full-width border directly
 * beneath the widget, so a rule here was a second frame two lines above the
 * first. The line is set one cell in, where the rows start.
 *
 * A chip is its text with a space at each side, painted in the foreground and
 * nothing else. Inverse video made every count a solid block of its tone,
 * which in a high-contrast theme was the brightest thing on the screen for
 * work the operator had already delegated and stopped watching.
 *
 * Deliberately no spend. A token total that left out cache reads was neither
 * what the Runs processed nor what they cost, and a cost summed across
 * backends that report it at different moments — Pi per message, Claude per
 * turn — was a partial figure presented as a total. Each completion notice
 * carries its own Run's accounting, labelled for what it is.
 */
function formatHeader(
  chips: readonly SummaryChip[],
  theme: RenderableTheme,
  width: number,
): string {
  const painted = chips
    .map((chip) => theme.fg(chip.tone, ` ${chip.text} `))
    .join(" ");
  const title = ` ${theme.fg("accent", theme.bold("subagents"))}  ${painted}`;
  if (visibleWidth(title) <= width) return title;
  const attention = chips.filter((chip) => chip.attention);
  if (attention.length > 0) {
    // Deliberately switch only on overflow: the full title/chips are kept at
    // exact fit. Once they cannot fit, drop that framing and lead with plain
    // attention text, reserving ! even when its explanation cannot fit.
    // Ordinary success counts must not conceal delivery failure.
    if (width <= 0) return "";
    return (
      theme.fg("error", "!") +
      fitToWidth(
        ` ${[...attention, ...chips.filter((chip) => !chip.attention)].map((chip) => chip.text).join(", ")}`,
        width - 1,
      )
    );
  }
  return fitToWidth(title, width);
}

/** Aggregate state, with detail only for exactly one nonterminal Run. */
export function renderRunRows(
  rows: readonly RunRowView[],
  theme: RenderableTheme,
  width: number,
  now: number,
): readonly string[] {
  if (rows.length === 0) return [];

  const active = rows.filter((row) => !isTerminalRunPhase(row.phase));
  const shown = active.length === 1 ? active : [];
  // Rows are drawn one column in from each edge, so they are fitted two short.
  // Nothing pads the right column: with no background to carry to the edge,
  // the inset is the space the right-aligned elapsed stops one short of.
  const inset = WIDGET_RUN_LINE.inset ?? 0;
  const lines = [
    formatHeader(widgetSummary(rows), theme, width),
    ...shown.map((row) =>
      fitToWidth(
        ` ${formatRunRow(row, theme, Math.max(0, width - inset * 2), now)}`,
        width,
      ),
    ),
  ];
  return lines;
}
