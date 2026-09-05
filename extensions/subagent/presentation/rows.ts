/**
 * Widget rows: one live Run as a single line of a small table.
 *
 * A row reads, left to right, in the order of how much a person scanning a
 * fan-out needs each thing: *which specialist* (agent, then backend), *how is
 * it going* (the status word, with the time it took once it has settled),
 * *how much has it done* (turns), *what it is for* (the label), and finally
 * *what it is doing right now* (the latest tool call). That order is also the
 * order the fields give way in on a narrow terminal, from the right. Every
 * field starts in the same column on every row, so a reader compares Runs by
 * looking down rather than by reading each line.
 *
 * ```
 *  subagents   2 running   1 completed
 *  explore      pi      running             3 turns  look around · grep: x
 *  reviewer     claude  running             1 turn   read the diff
 *  implementer  claude  completed in 1m 2s
 * ```
 *
 * A live row has no spinner and no clock. Its turn count moves as the Run
 * works, and that is the sign of life a reader needs; a spinner and a
 * counting duration said the same thing louder and cost a redraw several
 * times a second. A settled row says what the Run took, because that figure
 * has stopped and is worth reading, and drops its turn count, because that
 * one has stopped meaning anything. No glyph column either: the status word
 * and the band's colour already say which phase a row is in, and a mark in
 * front of the agent said it a third time.
 *
 * Each row is painted as a band across the width in the background Pi gives
 * its own tool calls — pending while the Run is live, success or error once it
 * has settled — so a fan-out reads as what it is: tool calls the parent made.
 *
 * Deliberately no Run id and no model. The widget is read by the operator, and
 * a human names a Run by its agent and what it is doing; ids live in tool
 * results and notifications, where the model that acts on them reads them.
 * The one exception is a row that will never leave on its own (W-2), whose
 * tail names the id because the id is what gets rid of it. Deliberately no
 * tool count and no context gauge either: both were tried, and neither told
 * an operator anything they acted on.
 *
 * This module formats. It does not decide which Runs exist, when the widget
 * appears, or when it redraws — those are host concerns, and a presentation
 * module that knew them would be holding lifecycle state. It reads no clock of
 * its own: `now` is handed in, and only a settled row's figure depends on
 * time at all.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isTerminalRunPhase, type RunPhase } from "../domain/index.ts";
import { completionViewOfSnapshot } from "./completion-view.ts";
import {
  formatRunPhase,
  formatTurns,
  RUN_PHASE_DISPLAY_ORDER,
  runPhaseBackground,
  runPhaseTone,
  runPhaseVerb,
  type Tone,
} from "./status.ts";
import { elapsedMillis, type RunRowView } from "./views.ts";

/** The theme surface every subagent renderer uses. */
export interface RenderableTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  inverse(text: string): string;
}

/**
 * Rows shown before the widget starts summarising.
 *
 * Nothing caps how many Runs a model may start beyond the Session's own
 * capacity, so the widget caps itself: a fan-out that filled the editor off
 * the screen would be worse than one that said how many it was not showing.
 */
export const MAX_WIDGET_ROWS = 8;

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
 * Widths shared by every visible row so each field starts in one column.
 *
 * `status` is measured over the *live* rows only. A settled row's status is a
 * phrase — `completed in 12.4s` — and a column sized to it would push every
 * live row's turn count a dozen cells right of its status word. A settled row
 * has nothing after its status but, on a stuck row, an explanation, so its
 * phrase overflows the column instead and nothing else has to move.
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
 * Measure the shown rows, then fit them to `width`.
 *
 * Fitting is a widget-level decision rather than a row-level one so that
 * every row drops the same columns: a table in which one row shows a turn
 * count and the next does not is not a table. Only the turn count is
 * optional, and it goes only when the fixed part itself will not fit; the
 * tail is fitted to whatever is left and is the first thing to shrink.
 */
export function measureColumns(
  rows: readonly RunRowView[],
  now: number,
  width: number = Number.POSITIVE_INFINITY,
): RowColumns {
  const cells = rows.map((row) => rowCells(row, now));
  const live = cells.filter((c) => c.live);
  const columns: RowColumns = {
    agent: Math.min(MAX_AGENT_COLUMN_WIDTH, widest(cells.map((c) => c.agent))),
    backend: widest(cells.map((c) => c.backend)),
    status: widest((live.length > 0 ? live : cells).map((c) => c.status)),
    turns: widest(cells.map((c) => c.turns)),
  };
  if (fixedWidth(columns) > width) return { ...columns, turns: 0 };
  return columns;
}

function padEnd(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/**
 * Running Runs first, then everything else, each group newest last.
 *
 * What is still happening is what the reader is watching. A finalizing Run has
 * stopped talking and is only cleaning up, and a settled one is waiting for
 * its notice to land, so both sink below the ones that are still working.
 */
export function orderRows(rows: readonly RunRowView[]): readonly RunRowView[] {
  const running = rows.filter((row) => row.phase === "running");
  const other = rows.filter((row) => row.phase !== "running");
  return [...running, ...other];
}

/** The plain text of one row's cells, before padding and paint. */
interface RowCells {
  readonly tone: Tone;
  /** Whether the Run is still going, which decides what the row carries. */
  readonly live: boolean;
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
  /** Painted as a failure rather than as orientation (W-2). */
  readonly failure: string | undefined;
}

/**
 * What a row says in each cell.
 *
 * A settled row reads its status and its duration through the completion
 * view, which is the same value the result card and the notice header read;
 * that is what stops a row and a card printing two durations for one Run. Its
 * status is the phase's full phrase — `completed in 12.4s` — because the
 * figure has stopped moving and is worth reading. A live Run's status is the
 * phase's one word: its turn count is its sign of life.
 *
 * Two rows say something the phase alone does not. A running Run whose
 * cancellation has been recorded says `cancelling`, because the reader who
 * asked for that is watching for it to take. And a settled Run whose notice
 * will never arrive (W-2) is painted in the error colour whatever its phase,
 * because nothing is coming for it and a row that will never leave on its own
 * has to stand out from the ones that will.
 */
function rowCells(row: RunRowView, now: number): RowCells {
  const completion = completionViewOfSnapshot(row, now);
  const phase: RunPhase = completion?.status ?? row.phase;
  const live = !isTerminalRunPhase(phase);
  const cancelling = live && row.cancellation !== undefined;
  const exhausted = row.handoff === "exhausted";

  const tone: Tone = exhausted ? "error" : runPhaseTone(phase);
  const status = live
    ? cancelling
      ? "cancelling"
      : runPhaseVerb(phase)
    : formatRunPhase({
        phase,
        elapsedMillis: completion?.durationMillis ?? elapsedMillis(row, now),
      });

  const tail: RowTail | undefined = exhausted
    ? {
        label: undefined,
        activity: undefined,
        failure: `notification failed · ${row.identity.runId} · result available`,
      }
    : live
      ? {
          label: row.identity.description || undefined,
          activity: phase === "running" ? row.activity : undefined,
          failure: undefined,
        }
      : undefined;

  return {
    tone,
    live,
    agent: truncateToWidth(row.identity.agent, MAX_AGENT_COLUMN_WIDTH, "…"),
    backend: row.identity.backendId,
    status,
    // A settled Run's turn count is history: what it did is in its Result,
    // and the row is only waiting to leave. The count is a live row's sign of
    // life, and means nothing once nothing is moving.
    turns: live ? formatTurns(row.usage.turns) : "",
    tail:
      tail && (tail.label || tail.activity || tail.failure) ? tail : undefined,
  };
}

/**
 * One Run as a single line.
 *
 * The agent, backend, and status never give way: they are what a row *is*. The turn count is drawn when `columns` kept it, and the tail takes
 * what is left. A row that still does not fit is cut, which only happens on a
 * terminal too narrow to read anyway.
 */
export function formatRunRow(
  row: RunRowView,
  theme: RenderableTheme,
  width: number,
  now: number,
  columns: RowColumns = measureColumns([row], now, width),
): string {
  const cells = rowCells(row, now);

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
 *
 * An exhausted hand-off (W-2) has a different tail: which Run it was and that
 * the answer is there anyway — the two facts a reader needs to type
 * `agent_result` and be rid of the row. It is painted in the error colour
 * because it is the one tail that reports a failure.
 *
 * Every other settled row has nothing to add and adds nothing.
 */
function formatRowTail(
  tail: RowTail | undefined,
  theme: RenderableTheme,
  room: number,
): string {
  if (tail === undefined) return "";
  const remaining = room - ROW_DELIMITER.length;
  if (remaining < MIN_TAIL_WIDTH) return "";

  if (tail.failure !== undefined) {
    return (
      ROW_DELIMITER +
      theme.fg("error", truncateToWidth(tail.failure, remaining, "…"))
    );
  }

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
        theme.fg("dim", truncateToWidth(label, labelRoom, "…") + separator) +
        theme.fg("muted", theme.italic(activity))
      );
    }
    const activityRoom = remaining - visibleWidth(separator) - labelMinimum;
    if (activityRoom >= MIN_ACTIVITY_WIDTH) {
      return (
        ROW_DELIMITER +
        theme.fg("dim", truncateToWidth(label, labelMinimum, "…") + separator) +
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
 * The same summary for the header, one chip per phase.
 *
 * A chip is the count and the verb, padded by a cell each side, painted in
 * the phase's colour and then inverted: the colour becomes the chip's
 * background and the text takes the terminal's own, so `2 running` reads as
 * a warning-coloured tag and `1 failed` as an error-coloured one. Chips are
 * set a cell apart, and their backgrounds are what separates them.
 */
function formatPhaseChips(
  rows: readonly RunRowView[],
  theme: RenderableTheme,
): string {
  return phaseCounts(rows)
    .map(([phase, count]) =>
      theme.inverse(
        theme.fg(runPhaseTone(phase), ` ${count} ${runPhaseVerb(phase)} `),
      ),
    )
    .join(" ");
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
  rows: readonly RunRowView[],
  theme: RenderableTheme,
  width: number,
): string {
  const title = ` ${theme.fg("accent", theme.bold("subagents"))}  ${formatPhaseChips(rows, theme)}`;
  if (visibleWidth(title) <= width) return title;
  return truncateToWidth(title, width, "…");
}

/**
 * The theme background a row is painted on.
 *
 * The phase's own, except for a settled Run whose notice will never arrive:
 * the Run may have completed, but the row is on screen because something
 * failed, and it is painted as the failure it is reporting.
 */
export function rowBackground(row: RunRowView): string {
  if (row.handoff === "exhausted") return "toolErrorBg";
  return runPhaseBackground(row.phase);
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

/** The whole widget: a title line, the rows as bands, and an overflow summary. */
export function renderRunRows(
  rows: readonly RunRowView[],
  theme: RenderableTheme,
  width: number,
  now: number,
  maxRows: number = MAX_WIDGET_ROWS,
): readonly string[] {
  if (rows.length === 0) return [];

  const ordered = orderRows(rows);
  const shown = ordered.slice(0, maxRows);
  const hidden = ordered.length - shown.length;
  // Rows are drawn one column in from each edge, so they are fitted two short
  // and the band pads the right column, the way the left one is a space.
  const columns = measureColumns(shown, now, width - ROW_INSET * 2);
  const lines = [
    formatHeader(rows, theme, width),
    ...shown.map((row) =>
      paintBand(
        ` ${formatRunRow(row, theme, width - ROW_INSET * 2, now, columns)}`,
        rowBackground(row),
        theme,
        width,
      ),
    ),
  ];
  if (hidden > 0) {
    lines.push(`   ${theme.fg("dim", `… and ${hidden} more`)}`);
  }
  return lines;
}
