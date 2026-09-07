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
 * The active detail is painted as a pending tool-call band. Terminal Runs
 * contribute only counts to the widget, never individual rows.
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

import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isTerminalRunPhase, type RunPhase } from "../domain/index.ts";
import { MAX_RUN_LABEL_WIDTH } from "./labels.ts";
import {
  formatRunElapsed,
  RUN_PHASE_DISPLAY_ORDER,
  runPhaseTone,
  runPhaseVerb,
  type Tone,
} from "./status.ts";
import type { FailedHandoffStatus, RunRowView } from "./views.ts";

/** The theme surface every subagent renderer uses. */
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

/** The columns a row band leaves clear at each edge. */
export const ROW_INSET = 1;

interface DetailPart {
  readonly text: string;
  readonly paint: (text: string) => string;
  readonly separator?: string;
}

function partsWidth(parts: readonly DetailPart[]): number {
  return parts.reduce(
    (total, part, index) =>
      total +
      visibleWidth(part.text) +
      (index === 0 ? 0 : visibleWidth(part.separator ?? ROW_DELIMITER)),
    0,
  );
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

/** Inputs here are plain; discard truncator resets before applying our paint. */
function truncatePlainText(text: string, width: number): string {
  return stripTerminalSequences(truncateToWidth(text, width, "…"));
}

interface EssentialDetail {
  readonly label: string;
  readonly state?: string;
  readonly activity?: string;
  /** Elapsed stays hidden when reported activity was unusably narrow. */
  readonly optionalsAllowed: boolean;
}

/** Allocate only the essential plain text; painting and optional fields come later. */
function allocateEssentialDetail(
  row: RunRowView,
  width: number,
): EssentialDetail {
  if (width <= 0) return { label: "", optionalsAllowed: false };
  const label = truncatePlainText(
    row.identity.description,
    MAX_RUN_LABEL_WIDTH,
  );
  const state =
    row.cancellation !== undefined ? "cancelling" : runPhaseVerb(row.phase);
  const stateWidth = visibleWidth(state);
  const labelBesideState = width - stateWidth - ROW_DELIMITER.length;

  // Label has first priority until its prefix and the complete state fit.
  if (labelBesideState < 1) {
    return {
      label: truncatePlainText(label, width),
      optionalsAllowed: false,
    };
  }

  // Match history's placeholder without reviving retained tool activity.
  const currentActivity =
    row.phase === "running" && row.cancellation === undefined
      ? row.activity || "—"
      : "—";

  const activityMinimum = Math.min(
    MIN_ACTIVITY_WIDTH,
    visibleWidth(currentActivity),
  );
  const roomForLabelAndActivity = Math.max(
    0,
    width - stateWidth - ROW_DELIMITER.length - ACTIVITY_DELIMITER.length,
  );
  let labelWidth = visibleWidth(label);
  let activityWidth = visibleWidth(currentActivity);
  if (labelWidth + activityWidth > roomForLabelAndActivity) {
    labelWidth = Math.min(
      labelWidth,
      Math.max(
        Math.min(MIN_LABEL_WIDTH, labelWidth),
        roomForLabelAndActivity - activityMinimum,
      ),
    );
    activityWidth = Math.max(0, roomForLabelAndActivity - labelWidth);
  }
  if (activityWidth < activityMinimum) {
    return {
      label: truncatePlainText(label, labelBesideState),
      state,
      optionalsAllowed: false,
    };
  }
  return {
    label: truncatePlainText(label, labelWidth),
    state,
    activity: truncatePlainText(currentActivity, activityWidth),
    optionalsAllowed: true,
  };
}

/**
 * One active Run as a single width-aware line.
 *
 * Elapsed Run duration reserves the right edge with a flexible gap, provided
 * Label, state and useful current activity still fit. Finalization and cancellation
 * omit retained activity, but duration remains independent of activity.
 */
export function formatRunRow(
  row: RunRowView,
  theme: RenderableTheme,
  width: number,
  now: number,
): string {
  const elapsed = formatRunElapsed(row, now);
  const elapsedWidth = visibleWidth(elapsed);
  const reserved = allocateEssentialDetail(
    row,
    width - elapsedWidth - ROW_DELIMITER.length,
  );
  // Reserve duration before allocating activity, but do not replace useful
  // activity or the complete status with a clock on very narrow terminals.
  const showElapsed = Boolean(
    reserved.label && reserved.state && reserved.optionalsAllowed,
  );
  const essential = showElapsed
    ? reserved
    : allocateEssentialDetail(row, width);
  const parts: DetailPart[] = [];
  if (essential.label) {
    parts.push({
      text: essential.label,
      paint: (text) => theme.fg("toolTitle", theme.bold(text)),
    });
  }
  if (essential.state) {
    parts.push({
      text: essential.state,
      paint: (text) => theme.fg(runPhaseTone(row.phase), text),
    });
  }
  if (essential.activity) {
    parts.push({
      text: essential.activity,
      separator: ` ${theme.fg("dim", "·")} `,
      paint: (text) => theme.fg("muted", text),
    });
  }

  const line =
    paintParts(parts) +
    (showElapsed
      ? " ".repeat(width - partsWidth(parts) - elapsedWidth) +
        theme.fg("dim", elapsed)
      : "");
  return visibleWidth(line) <= width
    ? line
    : truncateToWidth(line, width, "…", true);
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
    tone: runPhaseTone(phase),
    attention: false,
  }));
  if (cancelling > 0) {
    chips.unshift({
      text: `${cancelling} cancelling`,
      tone: "warning",
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
 * No rule. The editor draws its own full-width border directly beneath the
 * widget, so a rule here was a second frame two lines above the first; the
 * bands the rows are painted as do the separating that the rule used to. The
 * line is set one cell in, where the rows start.
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
    .map((chip) => theme.inverse(theme.fg(chip.tone, ` ${chip.text} `)))
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
      truncateToWidth(
        ` ${[...attention, ...chips.filter((chip) => !chip.attention)].map((chip) => chip.text).join(", ")}`,
        width - 1,
        "…",
      )
    );
  }
  return truncateToWidth(title, width, "…");
}

/**
 * Paint one row as a band across the whole width, the way Pi paints a tool
 * call's box.
 *
 * The line is padded to `width` so the colour reaches the edge, and it is
 * painted segment by segment around any full reset the text carries — a
 * truncation leaves one behind — because a reset would otherwise switch the
 * background off for the rest of the line.
 */
function paintBand(
  line: string,
  background: string,
  theme: RenderableTheme,
  width: number,
): string {
  const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  return padded
    .split(FULL_RESET)
    .map((segment) => theme.bg(background, segment))
    .join(FULL_RESET);
}

/** The SGR sequence that clears every attribute, background included. */
const FULL_RESET = "\u001b[0m";

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
  // Rows are drawn one column in from each edge, so they are fitted two short
  // and the band pads the right column, the way the left one is a space.
  const lines = [
    formatHeader(widgetSummary(rows), theme, width),
    ...shown.map((row) =>
      paintBand(
        truncateToWidth(
          ` ${formatRunRow(row, theme, Math.max(0, width - ROW_INSET * 2), now)}`,
          width,
          "…",
        ),
        "toolPendingBg",
        theme,
        width,
      ),
    ),
  ];
  return lines;
}
