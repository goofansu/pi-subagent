/**
 * Ambient widget: aggregate state and, for exactly one active Run, one detail line.
 *
 * A single active Run reads in priority order: *which Profile*, *what state*,
 * and *what useful activity*. When the current activity has its retained
 * semantic timestamp, its age follows; existing turn accounting and backend
 * come later. The Label is supplementary and uses space left
 * after them, so orientation never replaces all useful activity.
 *
 * ```
 *  subagents   1 running   1 completed
 *  explore  running  grep: x  3 turns  pi  look around
 * ```
 *
 * A live row has no spinner or ticking clock. Its optional age is the time
 * since the displayed semantic summary changed, sampled only when the host
 * renders. No glyph column either: the state word already says which phase the
 * Run is in, and a mark before the Profile would repeat it.
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
 * a clock; the host supplies the render instant as plain presentation input.
 */

import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isTerminalRunPhase, type RunPhase } from "../domain/index.ts";
import {
  formatDuration,
  formatTurns,
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

/** Every fixed component in a row is separated by the same amount of space. */
export const ROW_DELIMITER = "  ";

/** Keep Profile names from consuming state and activity. */
export const MAX_PROFILE_WIDTH = 16;

/** A recognisable Profile prefix retained before shortening activity. */
const MIN_PROFILE_WIDTH = 7;

/** A shortened activity remains useful at this width (`bash: …`, for example). */
const MIN_ACTIVITY_WIDTH = 12;

/** A supplementary Label is not shown as an unrecognisable fragment. */
const MIN_LABEL_WIDTH = 8;

/** The columns a row band leaves clear at each edge. */
export const ROW_INSET = 1;

interface DetailPart {
  readonly text: string;
  readonly paint: (text: string) => string;
}

function partsWidth(parts: readonly DetailPart[]): number {
  if (parts.length === 0) return 0;
  return (
    parts.reduce((total, part) => total + visibleWidth(part.text), 0) +
    ROW_DELIMITER.length * (parts.length - 1)
  );
}

function paintParts(parts: readonly DetailPart[]): string {
  return parts.map((part) => part.paint(part.text)).join(ROW_DELIMITER);
}

/** Inputs here are plain; discard truncator resets before applying our paint. */
function truncatePlainText(text: string, width: number): string {
  return stripTerminalSequences(truncateToWidth(text, width, "…"));
}

interface EssentialDetail {
  readonly profile: string;
  readonly state?: string;
  readonly activity?: string;
  /** Lower-priority fields stay gone when reported activity was unusably narrow. */
  readonly optionalsAllowed: boolean;
}

/** Allocate only the essential plain text; painting and optional fields come later. */
function allocateEssentialDetail(
  row: RunRowView,
  width: number,
): EssentialDetail {
  if (width <= 0) return { profile: "", optionalsAllowed: false };
  const profile = truncatePlainText(row.identity.agent, MAX_PROFILE_WIDTH);
  const state =
    row.cancellation !== undefined ? "cancelling" : runPhaseVerb(row.phase);
  const stateWidth = visibleWidth(state);
  const profileBesideState = width - stateWidth - ROW_DELIMITER.length;

  // Profile has first priority. Until a prefix and the complete state can both
  // fit, show only that prefix rather than an empty cell plus a delimiter.
  if (profileBesideState < 1) {
    return {
      profile: truncatePlainText(profile, width),
      optionalsAllowed: false,
    };
  }

  const currentActivity =
    row.phase === "running" && row.cancellation === undefined
      ? row.activity
      : undefined;
  if (currentActivity === undefined) {
    return {
      profile: truncatePlainText(profile, profileBesideState),
      state,
      optionalsAllowed: true,
    };
  }

  const activityMinimum = Math.min(
    MIN_ACTIVITY_WIDTH,
    visibleWidth(currentActivity),
  );
  const roomForProfileAndActivity = Math.max(
    0,
    width - stateWidth - ROW_DELIMITER.length * 2,
  );
  let profileWidth = visibleWidth(profile);
  let activityWidth = visibleWidth(currentActivity);
  if (profileWidth + activityWidth > roomForProfileAndActivity) {
    profileWidth = Math.min(
      profileWidth,
      Math.max(
        Math.min(MIN_PROFILE_WIDTH, profileWidth),
        roomForProfileAndActivity - activityMinimum,
      ),
    );
    activityWidth = Math.max(0, roomForProfileAndActivity - profileWidth);
  }
  if (activityWidth < activityMinimum) {
    return {
      profile: truncatePlainText(profile, profileBesideState),
      state,
      optionalsAllowed: false,
    };
  }
  return {
    profile: truncatePlainText(profile, profileWidth),
    state,
    activity: truncatePlainText(currentActivity, activityWidth),
    optionalsAllowed: true,
  };
}

/**
 * One active Run as a single width-aware line.
 *
 * Profile, state, and honest current activity are allocated first. A long
 * Profile is capped and can shrink further to preserve useful activity. The
 * matching semantic age follows activity, before turns and backend; Label uses
 * only the final remainder. Finalization and cancellation omit retained
 * activity and age because they no longer describe something executing now.
 */
export function formatRunRow(
  row: RunRowView,
  theme: RenderableTheme,
  width: number,
  now: number,
): string {
  const essential = allocateEssentialDetail(row, width);
  const parts: DetailPart[] = [];
  if (essential.profile) {
    parts.push({
      text: essential.profile,
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
      paint: (text) => theme.fg("muted", theme.italic(text)),
    });
  }

  const appendWhole = (part: DetailPart): boolean => {
    const candidate = [...parts, part];
    if (partsWidth(candidate) > width) return false;
    parts.push(part);
    return true;
  };
  // Pair age only with the current semantic summary it describes. A retained
  // summary after clear/finalization is history, not evidence that its tool is
  // still executing. If a real age cannot fit, lower-priority metadata does
  // not jump ahead of it.
  const retainedActivity = row.lastActivity;
  const activityAge =
    essential.activity !== undefined &&
    retainedActivity !== undefined &&
    row.activity === retainedActivity.summary
      ? `${formatDuration(now - retainedActivity.changedAt)} ago`
      : undefined;
  const ageShown =
    activityAge === undefined ||
    appendWhole({
      text: activityAge,
      paint: (text) => theme.fg("dim", text),
    });
  const accountingShown =
    essential.optionalsAllowed &&
    ageShown &&
    appendWhole({
      text: formatTurns(row.usage.turns),
      paint: (text) => theme.fg("dim", text),
    });
  const backendShown =
    accountingShown &&
    appendWhole({
      text: row.identity.backendId,
      paint: (text) => theme.fg("dim", text),
    });

  const label = row.identity.description;
  const labelRoom = width - partsWidth(parts) - ROW_DELIMITER.length;
  if (backendShown && label && labelRoom >= MIN_LABEL_WIDTH) {
    parts.push({
      text: truncatePlainText(label, labelRoom),
      paint: (text) => theme.fg("dim", text),
    });
  }

  const line = paintParts(parts);
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
