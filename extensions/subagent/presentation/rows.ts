/**
 * Widget rows: one live Run as a single line of a small table.
 *
 * A row reads, left to right, in the order a person scanning a fan-out asks
 * their questions: *is it alive* (a spinner or a settled glyph), *which
 * specialist* (agent, then backend), *how is it going* (the status word and
 * how long it has been at it), *how much has it done* (turns), and finally
 * *what is it doing right now*. Every field starts in the same column on
 * every row, so a reader compares Runs by looking down rather than by reading
 * each line.
 *
 * ```
 * ─── subagents  2 running · 1 completed ───────────── 14.2k tokens · $0.04 ───
 *  ⠹ explore      pi      running     12.4s  3 turns  look around · grep: x
 *  ⠹ reviewer     claude  running      8.2s  1 turn   read the diff
 *  ✓ implementer  claude  completed   1m 2s  4 turns
 * ```
 *
 * Each row is painted as a band across the width in the background Pi gives
 * its own tool calls — pending while the Run is live, success or error once it
 * has settled — so a fan-out reads as what it is: tool calls the parent made.
 *
 * Deliberately no tool count and no context gauge: both were tried, and
 * neither told an operator anything they acted on. The row is for the two
 * decisions a reader makes from it — wait, or cancel — and the label, the
 * activity, and the clock are what those turn on.
 *
 * Deliberately no Run id and no model. The widget is read by the operator, and
 * a human names a Run by its agent and what it is doing; ids live in tool
 * results and notifications, where the model that acts on them reads them.
 * The one exception is a row that will never leave on its own (W-2), whose
 * tail names the id because the id is what gets rid of it.
 *
 * This module formats. It does not decide which Runs exist, when the widget
 * appears, or when it redraws — those are host concerns, and a presentation
 * module that knew them would be holding lifecycle state. It reads no clock of
 * its own either: `now` is handed in, so the same instant draws the same rows,
 * spinner frame and all.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isTerminalRunPhase, type RunPhase } from "../domain/index.ts";
import { completionViewOfSnapshot } from "./completion-view.ts";
import {
  formatDuration,
  formatTurns,
  RUN_PHASE_DISPLAY_ORDER,
  runPhaseBackground,
  runPhaseGlyph,
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
const MIN_TAIL_WIDTH = 12;

/**
 * How much room the widget tries to leave the tail before it draws an
 * optional column.
 *
 * The tail is what a Run is doing, which on a narrow terminal is worth more
 * than how many tools it has called. So the optional columns are not simply
 * drawn when they fit: they are drawn when they fit *and* leave the tail at
 * least this much, and otherwise give way in order until it has that.
 */
export const TAIL_BUDGET = 24;

/**
 * The spinner a live Run leads with, and how long each frame is shown.
 *
 * Pi's own frames, so a Run that is working looks like the agent that is
 * working above it. The frame is a function of the instant a row is drawn at,
 * so every running row spins in step and a golden test can pin a frame by
 * pinning `now`. The host redraws the widget once per interval while any Run
 * is live; that is what makes the spinner spin and the duration count.
 */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
export const SPINNER_INTERVAL_MS = 200;

export function spinnerFrame(now: number): string {
  const tick = Math.floor(Math.max(0, now) / SPINNER_INTERVAL_MS);
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

/**
 * Widths shared by every visible row so each field starts in one column.
 *
 * An optional column measured at zero is not drawn, because the width it was
 * fitted to had no room for it. The first three are never zero: a row is its
 * glyph, agent, backend, and status.
 */
export interface RowColumns {
  readonly agent: number;
  readonly backend: number;
  readonly status: number;
  readonly duration: number;
  readonly turns: number;
}

/** The optional columns, in the order they give way. */
const OPTIONAL_COLUMNS = ["turns", "duration"] as const;

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, visibleWidth(value)), 0);
}

/** The width of a row's fixed part under these columns, tail excluded. */
function fixedWidth(columns: RowColumns): number {
  const optional = OPTIONAL_COLUMNS.reduce(
    (sum, column) =>
      columns[column] > 0 ? sum + ROW_DELIMITER.length + columns[column] : sum,
    0,
  );
  return (
    2 + // the glyph and its space
    columns.agent +
    ROW_DELIMITER.length +
    columns.backend +
    ROW_DELIMITER.length +
    columns.status +
    optional
  );
}

/**
 * Measure the shown rows, then fit them to `width`.
 *
 * Fitting is a widget-level decision rather than a row-level one so that
 * every row drops the same columns: a table in which one row shows a tool
 * count and the next does not is not a table. Optional columns give way in a
 * fixed order until the tail has {@link TAIL_BUDGET} — or, when no shown row
 * has a tail, until the fixed part simply fits.
 */
export function measureColumns(
  rows: readonly RunRowView[],
  now: number,
  width: number = Number.POSITIVE_INFINITY,
): RowColumns {
  const cells = rows.map((row) => rowCells(row, now));
  let columns: RowColumns = {
    agent: Math.min(MAX_AGENT_COLUMN_WIDTH, widest(cells.map((c) => c.agent))),
    backend: widest(cells.map((c) => c.backend)),
    status: widest(cells.map((c) => c.status)),
    duration: widest(cells.map((c) => c.duration)),
    turns: widest(cells.map((c) => c.turns)),
  };
  // A tail is set off by a delimiter, so its budget is measured after one.
  const wanted = cells.some((c) => c.tail !== undefined)
    ? ROW_DELIMITER.length + TAIL_BUDGET
    : 0;
  for (const column of OPTIONAL_COLUMNS) {
    if (width - fixedWidth(columns) >= wanted) break;
    columns = { ...columns, [column]: 0 };
  }
  return columns;
}

function padEnd(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function padStart(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
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
  readonly glyph: string;
  readonly tone: Tone;
  readonly agent: string;
  readonly backend: string;
  readonly status: string;
  readonly duration: string;
  /** Whether the duration is still counting, which changes how it is painted. */
  readonly live: boolean;
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
 * that is what stops a row and a card printing two durations for one Run. A
 * live Run has no completion to describe, so it reads its phase and the
 * elapsed time against `now`, which is what makes the figure count while the
 * host keeps redrawing.
 *
 * Two rows say something the phase alone does not. A running Run whose
 * cancellation has been recorded says `cancelling`, because the reader who
 * asked for that is watching for it to take. And a settled Run whose notice
 * will never arrive (W-2) leads with `!` in the error colour, because nothing
 * is coming for it and a row that will never leave on its own has to stand
 * out from the ones that will.
 */
function rowCells(row: RunRowView, now: number): RowCells {
  const completion = completionViewOfSnapshot(row, now);
  const phase: RunPhase = completion?.status ?? row.phase;
  const cancelling =
    !isTerminalRunPhase(phase) && row.cancellation !== undefined;
  const exhausted = row.handoff === "exhausted";

  const glyph = exhausted
    ? "!"
    : phase === "running"
      ? spinnerFrame(now)
      : runPhaseGlyph(phase);
  const tone: Tone = exhausted ? "error" : runPhaseTone(phase);
  const status = cancelling ? "cancelling" : runPhaseVerb(phase);
  const live = !isTerminalRunPhase(phase);

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
    glyph,
    tone,
    agent: truncateToWidth(row.identity.agent, MAX_AGENT_COLUMN_WIDTH, "…"),
    backend: row.identity.backendId,
    status,
    duration: formatDuration(
      completion?.durationMillis ?? elapsedMillis(row, now),
    ),
    live,
    turns: formatTurns(row.usage.turns),
    tail:
      tail && (tail.label || tail.activity || tail.failure) ? tail : undefined,
  };
}

/**
 * One Run as a single line.
 *
 * The glyph, agent, backend, and status word never give way: they are what a
 * row *is*. The optional columns are whichever ones `columns` kept — see
 * {@link measureColumns} for the order they go in — and the tail takes what
 * is left. A row that still does not fit is cut, which only happens on a
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

  const glyph = theme.fg(cells.tone, cells.glyph);
  const agent = theme.fg(
    "toolTitle",
    theme.bold(padEnd(cells.agent, columns.agent)),
  );
  const backend = theme.fg("dim", padEnd(cells.backend, columns.backend));
  const status = theme.fg(cells.tone, padEnd(cells.status, columns.status));
  const duration = theme.fg(
    cells.live ? "text" : "dim",
    padStart(cells.duration, columns.duration),
  );
  const turns = theme.fg("dim", padEnd(cells.turns, columns.turns));

  const lead = `${glyph} ${[agent, backend, status].join(ROW_DELIMITER)}`;
  const optional = [
    columns.duration > 0 ? duration : undefined,
    columns.turns > 0 ? turns : undefined,
  ].filter((part): part is string => part !== undefined);
  const line = [lead, ...optional].join(ROW_DELIMITER);
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
 * activity and the activity in italics, so the part that moves looks like it. When both will not fit, the activity wins, because the label is
 * the part the reader already knows. A row that is only finalizing shows its
 * label alone, which is what tells two Runs of one agent apart while they
 * clean up.
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
  const separator = " · ";
  if (
    activity &&
    label &&
    visibleWidth(label) + visibleWidth(separator) + visibleWidth(activity) <=
      remaining
  ) {
    return (
      ROW_DELIMITER +
      theme.fg("dim", label + separator) +
      theme.fg("muted", theme.italic(activity))
    );
  }
  const primary = activity ?? label;
  if (!primary) return "";
  const fitted = truncateToWidth(primary, remaining, "…");
  return (
    ROW_DELIMITER +
    (activity
      ? theme.fg("muted", theme.italic(fitted))
      : theme.fg("dim", fitted))
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
 * The same summary for the header, each count painted in its phase's colour
 * so the rule says at a glance whether anything has gone wrong.
 */
function formatPaintedSummary(
  rows: readonly RunRowView[],
  theme: RenderableTheme,
): string {
  return phaseCounts(rows)
    .map(([phase, count]) =>
      theme.fg(runPhaseTone(phase), `${count} ${runPhaseVerb(phase)}`),
    )
    .join(theme.fg("dim", " · "));
}

/**
 * The titled rule above the rows: the widget's name and its Runs counted by
 * phase, then the rule to the edge.
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
  const rule = (cells: number): string =>
    theme.fg("borderMuted", "─".repeat(Math.max(0, cells)));
  const left = `${rule(3)} ${theme.fg("accent", theme.bold("subagents"))}  ${formatPaintedSummary(rows, theme)} `;
  const fill = width - visibleWidth(left);
  if (fill >= 0) return left + rule(fill);
  return truncateToWidth(left, width, "…", true);
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

/** The whole widget: a titled rule, the rows as bands, and an overflow summary. */
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
  // Rows are drawn one column in from the rule, so they are fitted one short.
  const columns = measureColumns(shown, now, width - 1);
  const lines = [
    formatHeader(rows, theme, width),
    ...shown.map((row) =>
      paintBand(
        ` ${formatRunRow(row, theme, width - 1, now, columns)}`,
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
