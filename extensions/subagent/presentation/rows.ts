/**
 * Ambient widget: aggregate state and, for exactly one active Run, one detail line.
 *
 * A row reads, left to right, in the order of how much a person scanning a
 * fan-out needs each thing: *which specialist* (agent, then backend), *how is
 * it going* (the status word), *how much has it done* (turns),
 * *what it is for* (the label), and finally
 * *what it is doing right now* (the latest tool call). That order is also the
 * order the fields give way in on a narrow terminal, from the right. This
 * existing single-row layout is retained here; detailed comparison belongs in
 * `/subagent dashboard`, not in this ambient surface.
 *
 * ```
 *  subagents   1 running   1 completed
 *  explore  pi  running  3 turns  look around · grep: x
 * ```
 *
 * A live row has no spinner and no clock. Its turn count moves as the Run
 * works, and that is the sign of life a reader needs; a spinner and a
 * counting duration said the same thing louder and cost a redraw several
 * times a second. No glyph column either: the status word
 * already says which phase a row is in, and a mark in
 * front of the agent would repeat it.
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
 * a clock.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isTerminalRunPhase, type RunPhase } from "../domain/index.ts";
import {
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

/** Keep Profile names from consuming the rest of every row. */
export const MAX_AGENT_COLUMN_WIDTH = 16;

/** How much room a row's tail needs before it is worth starting. */
export const MIN_TAIL_WIDTH = 12;

/** The columns a row band leaves clear at each edge. */
export const ROW_INSET = 1;

/**
 * How much of the label must survive for the activity to be shown beside it.
 *
 * The label outranks the activity, so the activity is never shown *instead*
 * of it. But a short activity beside a shortened label is still worth more
 * than the label's last few words, as long as enough of the label is left to
 * recognise. Below this the activity goes and the label takes the room.
 */
export const MIN_LABEL_WIDTH = 24;

/**
 * How much of the activity must survive for it to be shown shortened.
 *
 * A shortened activity still says what kind of thing the Run is doing —
 * `bash: npm te…` — but below this it says nothing, so the label takes the room.
 */
export const MIN_ACTIVITY_WIDTH = 12;

/**
 * The active detail's column widths, preserving the existing width policy.
 *
 * `turns` measured at zero is not drawn, because the width it was fitted to
 * had no room for it. The other three are never zero: a row is its agent,
 * backend, and status.
 */
export interface RowColumns {
  readonly agent: number;
  readonly backend: number;
  readonly status: number;
  readonly turns: number;
}

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, visibleWidth(value)), 0);
}

/** The width of a row's fixed part under these columns, tail excluded. */
function fixedWidth(columns: RowColumns): number {
  return (
    columns.agent +
    ROW_DELIMITER.length +
    columns.backend +
    ROW_DELIMITER.length +
    columns.status +
    (columns.turns > 0 ? ROW_DELIMITER.length + columns.turns : 0)
  );
}

/**
 * Measure the shown active detail, then fit its columns to `width`.
 *
 * Only the turn count is optional in the retained single-row layout,
 * and it goes only when the fixed part itself will not fit; the
 * tail is fitted to whatever is left and is the first thing to shrink.
 */
export function measureColumns(
  rows: readonly RunRowView[],
  width: number = Number.POSITIVE_INFINITY,
): RowColumns {
  const cells = rows.map(rowCells);
  const columns: RowColumns = {
    agent: Math.min(MAX_AGENT_COLUMN_WIDTH, widest(cells.map((c) => c.agent))),
    backend: widest(cells.map((c) => c.backend)),
    status: widest(cells.map((c) => c.status)),
    turns: widest(cells.map((c) => c.turns)),
  };
  if (fixedWidth(columns) > width) return { ...columns, turns: 0 };
  return columns;
}

function padEnd(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/** The plain text of one row's cells, before padding and paint. */
interface RowCells {
  readonly tone: Tone;
  readonly agent: string;
  readonly backend: string;
  readonly status: string;
  readonly turns: string;
  /** What the row says after its columns, when it has anything to say. */
  readonly tail: RowTail | undefined;
}

/** A tail is a label and, on a running Run that has reported, an activity. */
interface RowTail {
  readonly label: string | undefined;
  readonly activity: string | undefined;
}

/** Cells of the sole active Run; terminal Runs never enter the detail path. */
function rowCells(row: RunRowView): RowCells {
  const tail: RowTail = {
    label: row.identity.description || undefined,
    activity: row.phase === "running" ? row.activity : undefined,
  };
  return {
    tone: runPhaseTone(row.phase),
    agent: truncateToWidth(row.identity.agent, MAX_AGENT_COLUMN_WIDTH, "…"),
    backend: row.identity.backendId,
    status:
      row.cancellation !== undefined ? "cancelling" : runPhaseVerb(row.phase),
    turns: formatTurns(row.usage.turns),
    tail: tail.label || tail.activity ? tail : undefined,
  };
}

/**
 * One active Run as a single line.
 *
 * The agent, backend, and status never give way: they are what a row *is*.
 * The turn count is drawn when `columns` kept it, and the tail takes
 * what is left. A row that still does not fit is cut, which only happens on a
 * terminal too narrow to read anyway.
 */
export function formatRunRow(
  row: RunRowView,
  theme: RenderableTheme,
  width: number,
  columns: RowColumns = measureColumns([row], width),
): string {
  const cells = rowCells(row);

  const agent = theme.fg(
    "toolTitle",
    theme.bold(padEnd(cells.agent, columns.agent)),
  );
  const backend = theme.fg("dim", padEnd(cells.backend, columns.backend));
  const status = theme.fg(cells.tone, padEnd(cells.status, columns.status));
  const turns = theme.fg("dim", padEnd(cells.turns, columns.turns));

  const parts = [agent, backend, status];
  if (columns.turns > 0) parts.push(turns);
  const line = parts.join(ROW_DELIMITER);
  if (visibleWidth(line) > width) {
    return truncateToWidth(line, width, "…", true);
  }
  return line + formatRowTail(cells.tail, theme, width - visibleWidth(line));
}

/**
 * The tail, fitted to the width the columns left.
 *
 * A live Run says what it is for and, once the backend has reported anything,
 * what it is doing right now: `label · activity`, the label quieter than the
 * activity and the activity in italics, so the part that moves looks like it.
 *
 * The label outranks the activity. When both will not fit whole, the label is
 * shortened to make room for the activity, as long as at least
 * {@link MIN_LABEL_WIDTH} of it survives; past that the activity is the one
 * shortened, to whatever is left beside that much label, as long as at least
 * {@link MIN_ACTIVITY_WIDTH} of it survives; below that the activity is
 * dropped and the label takes the room. The label is never dropped in favour
 * of the activity: a row that said only `read` would not say which Run was
 * reading. A row that is only finalizing shows its label alone.
 */
function formatRowTail(
  tail: RowTail | undefined,
  theme: RenderableTheme,
  room: number,
): string {
  if (tail === undefined) return "";
  const remaining = room - ROW_DELIMITER.length;
  if (remaining < MIN_TAIL_WIDTH) return "";

  const { label, activity } = tail;
  if (!label) {
    if (!activity) return "";
    return (
      ROW_DELIMITER +
      theme.fg("muted", theme.italic(truncateToWidth(activity, remaining, "…")))
    );
  }

  const separator = " · ";
  if (activity) {
    const labelMinimum = Math.min(MIN_LABEL_WIDTH, visibleWidth(label));
    const labelRoom =
      remaining - visibleWidth(separator) - visibleWidth(activity);
    if (labelRoom >= labelMinimum) {
      return (
        ROW_DELIMITER +
        theme.fg("dim", truncateToWidth(label, labelRoom, "…")) +
        theme.fg("dim", separator) +
        theme.fg("muted", theme.italic(activity))
      );
    }
    const activityRoom = remaining - visibleWidth(separator) - labelMinimum;
    if (activityRoom >= MIN_ACTIVITY_WIDTH) {
      return (
        ROW_DELIMITER +
        theme.fg("dim", truncateToWidth(label, labelMinimum, "…")) +
        theme.fg("dim", separator) +
        theme.fg(
          "muted",
          theme.italic(truncateToWidth(activity, activityRoom, "…")),
        )
      );
    }
  }
  return (
    ROW_DELIMITER + theme.fg("dim", truncateToWidth(label, remaining, "…"))
  );
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
): readonly string[] {
  if (rows.length === 0) return [];

  const active = rows.filter((row) => !isTerminalRunPhase(row.phase));
  const shown = active.length === 1 ? active : [];
  // Rows are drawn one column in from each edge, so they are fitted two short
  // and the band pads the right column, the way the left one is a space.
  const columns = measureColumns(shown, width - ROW_INSET * 2);
  const lines = [
    formatHeader(widgetSummary(rows), theme, width),
    ...shown.map((row) =>
      paintBand(
        truncateToWidth(
          ` ${formatRunRow(row, theme, Math.max(0, width - ROW_INSET * 2), columns)}`,
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
