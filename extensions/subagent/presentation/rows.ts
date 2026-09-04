/**
 * Widget rows: one live Run as a single line.
 *
 * Ported from v1's widget, formatting and all, because the compatibility
 * matrix fixes the row's exact text: `explore  pi  3 turns  running · …`. The
 * column measuring, the delimiter, the agent-column cap, the order that
 * fields give way in, and the activity tail are v1's decisions, and the
 * golden tests below hold them to the matrix.
 *
 * Deliberately no Run id and no model. The widget is read by the operator, and
 * a human names a Run by its agent and what it is doing; ids live in tool
 * results and notifications, where the model that acts on them reads them.
 *
 * This module formats. It does not decide which Runs exist, when the widget
 * appears, or when it redraws — those are host concerns, and a presentation
 * module that knew them would be holding lifecycle state.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunPhase } from "../domain/index.ts";
import {
  formatRunPhase,
  formatTurns,
  RUN_PHASE_DISPLAY_ORDER,
  runPhaseTone,
  runPhaseVerb,
} from "./status.ts";
import { elapsedMillis, type RunRowView } from "./views.ts";

/** The theme surface every subagent renderer uses. */
export interface RenderableTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
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

/** How much room an activity tail needs before it is worth starting. */
const MIN_ACTIVITY_WIDTH = 12;

/** Widths shared by every visible row so each field starts in one column. */
export interface RowColumns {
  readonly agent: number;
  readonly backend: number;
  readonly turns: number;
}

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, visibleWidth(value)), 0);
}

export function measureColumns(rows: readonly RunRowView[]): RowColumns {
  return {
    agent: Math.min(
      MAX_AGENT_COLUMN_WIDTH,
      widest(rows.map((row) => row.identity.agent)),
    ),
    backend: widest(rows.map((row) => row.identity.backendId)),
    turns: widest(rows.map((row) => formatTurns(row.usage.turns))),
  };
}

function padEndToWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/**
 * Running Runs first, then finalizing ones, each group newest last.
 *
 * What is still happening is what the reader is watching. A finalizing Run has
 * stopped talking and is only cleaning up, so it sinks below the ones that are
 * still working.
 */
export function orderRows(rows: readonly RunRowView[]): readonly RunRowView[] {
  const running = rows.filter((row) => row.phase === "running");
  const other = rows.filter((row) => row.phase !== "running");
  return [...running, ...other];
}

/**
 * One Run as a single line: agent, backend, turns, status, and — while the Run
 * is still going — what it is doing right now.
 *
 * Turn accounting is dropped when the line will not fit; the status never is.
 * The activity tail is the first thing sacrificed: it takes whatever width is
 * left after the fixed components and is skipped entirely when that is too
 * little to read. Before the backend's first activity report the Run's own
 * description stands in, which is also what tells two Runs of one agent apart.
 */
export function formatRunRow(
  row: RunRowView,
  theme: RenderableTheme,
  width: number,
  now: number,
  columns: RowColumns = measureColumns([row]),
): string {
  const tone = runPhaseTone(row.phase);
  const agentName = truncateToWidth(
    row.identity.agent,
    MAX_AGENT_COLUMN_WIDTH,
    "…",
  );
  const agent = theme.fg(
    "toolTitle",
    theme.bold(padEndToWidth(agentName, columns.agent)),
  );
  const backend = theme.fg(
    "dim",
    padEndToWidth(row.identity.backendId, columns.backend),
  );
  const status = theme.fg(tone, formatRowStatus(row, now));
  const turns = theme.fg(
    "dim",
    padEndToWidth(formatTurns(row.usage.turns), columns.turns),
  );

  for (const components of [
    [agent, backend, turns, status],
    [agent, backend, status],
  ]) {
    const candidate = components.join(ROW_DELIMITER);
    if (visibleWidth(candidate) <= width) {
      return candidate + formatRowTail(row, theme, width, candidate);
    }
  }
  return truncateToWidth(
    [agent, backend, status].join(ROW_DELIMITER),
    width,
    "…",
    true,
  );
}

/**
 * The status a row shows, which for one state is not the phase's own phrase.
 *
 * A settled Run whose completion notice exhausted its retry budget will never
 * leave the widget on its own — nothing is coming — so its row says why in the
 * place a reader is already looking. That is ledger row W-2, and it is the one
 * thing the widget knows that the Run does not: the phase is `completed` and
 * the hand-off is what failed.
 *
 * The duration gives way here rather than the explanation, because a row that
 * is stuck is being read for the reason it is stuck. Every other row is
 * unchanged (W-1).
 */
function formatRowStatus(row: RunRowView, now: number): string {
  if (row.handoff === "exhausted") {
    return `${runPhaseVerb(row.terminalStatus ?? row.phase)} · notification failed`;
  }
  return formatRunPhase({
    phase: row.phase,
    elapsedMillis: elapsedMillis(row, now),
  });
}

/**
 * The dim tail, fitted to the width the columns left.
 *
 * Two rows have one: a running Run says what it is doing, and an exhausted
 * hand-off says which Run it was and that the answer is there anyway — the
 * two facts a reader needs to type `agent_result` and be rid of the row.
 * Everything else has nothing to add and adds nothing.
 */
function formatRowTail(
  row: RunRowView,
  theme: RenderableTheme,
  width: number,
  line: string,
): string {
  const tail =
    row.handoff === "exhausted"
      ? `${row.identity.runId} · result available`
      : row.phase === "running"
        ? (row.activity ?? row.identity.description)
        : "";
  if (!tail) return "";
  const remaining = width - visibleWidth(line);
  if (remaining < MIN_ACTIVITY_WIDTH) return "";
  return theme.fg("dim", truncateToWidth(` · ${tail}`, remaining, "…"));
}

/** Summarise the listed Runs using the shared phase vocabulary. */
export function formatRowSummary(rows: readonly RunRowView[]): string {
  const counts = new Map<RunPhase, number>();
  for (const row of rows) {
    counts.set(row.phase, (counts.get(row.phase) ?? 0) + 1);
  }
  return RUN_PHASE_DISPLAY_ORDER.flatMap((phase) => {
    const count = counts.get(phase) ?? 0;
    return count > 0 ? [`${count} ${runPhaseVerb(phase)}`] : [];
  }).join(", ");
}

/** The whole widget: a titled rule, the rows, and an overflow summary. */
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
  const columns = measureColumns(shown);
  const title = ` subagents (${formatRowSummary(rows)}) `;
  const fill = Math.max(0, width - 3 - visibleWidth(title));
  const lines = [
    truncateToWidth(
      theme.fg("borderMuted", "───") +
        theme.fg("accent", title) +
        theme.fg("borderMuted", "─".repeat(fill)),
      width,
      "…",
      true,
    ),
    ...shown.map(
      (row) => ` ${formatRunRow(row, theme, width - 1, now, columns)}`,
    ),
  ];
  if (hidden > 0) {
    lines.push(` ${theme.fg("dim", `… and ${hidden} more`)}`);
  }
  return lines;
}
