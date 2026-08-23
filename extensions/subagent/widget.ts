/**
 * The subagents widget: one line per run, pinned above the editor.
 *
 * A detached run finishes after the turn that started it, so the transcript
 * cannot show it — by the time the child says anything, its `agent_start` row
 * is already final and scrolled away. This widget is the only place live runs
 * are visible, which is why it is part of the feature rather than a decoration
 * on top of it.
 *
 * Widgets never receive keyboard input: pi routes keys to the editor, and the
 * widget maps are only ever read to render. So this is a display, and stopping
 * a run happens elsewhere.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatRunStatus,
  runStatusGlyph,
  runStatusTone,
} from "./formatting.ts";
import type { RunView, SubagentRuns } from "./runs.ts";
import type { ThemeForeground } from "./types.ts";

export const WIDGET_KEY = "subagent-runs";

/**
 * Rows shown before the widget starts summarising.
 *
 * Nothing caps how many runs the model may start, so the widget has to cap
 * itself: a fan-out of thirty would otherwise push the editor off the screen.
 */
export const MAX_WIDGET_ROWS = 8;

/** Past this, a long agent name gets its own ragged row rather than pushing
 * every other row's columns across the terminal. */
export const MAX_AGENT_COLUMN_WIDTH = 16;

export interface WidgetTheme {
  fg: ThemeForeground;
  bold(text: string): string;
}

/** Just the model id. The provider prefix is rarely the interesting part. */
export function formatModel(model: string | undefined): string {
  if (!model) return "—";
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * Turns taken, or nothing before the child has spoken.
 *
 * Since the line does not show what a run is doing, a rising turn count is the
 * signal that it is doing anything at all — which is why it outranks cost when
 * the terminal is too narrow for both.
 */
export function formatTurns(turns: number): string {
  if (turns <= 0) return "";
  return `${turns} turn${turns === 1 ? "" : "s"}`;
}

/** Column widths shared by every row, so the fields read as a table. */
export interface RunColumns {
  agent: number;
  model: number;
  turns: number;
  cost: number;
}

export function measureColumns(runs: readonly RunView[]): RunColumns {
  const widest = (values: string[]) =>
    values.reduce((max, value) => Math.max(max, value.length), 0);
  return {
    agent: Math.min(
      MAX_AGENT_COLUMN_WIDTH,
      widest(runs.map((run) => run.agent)),
    ),
    model: widest(runs.map((run) => formatModel(run.model))),
    turns: widest(runs.map((run) => formatTurns(run.turns))),
    cost: widest(runs.map((run) => formatCost(run.cost))),
  };
}

/**
 * Running runs first, then everything else, each group newest last.
 *
 * What is still happening is what the reader is watching; a settled run is
 * only here until its report lands.
 */
export function orderRuns(runs: readonly RunView[]): RunView[] {
  const running = runs.filter((run) => run.status === "running");
  const settled = runs.filter((run) => run.status !== "running");
  return [...running, ...settled];
}

/**
 * One run as a single line: id, agent, model, turns, cost, status.
 *
 * Model and cost are dropped, in that order, when the line will not fit.
 * Status is the field a reader is actually watching, so it must survive a
 * narrow terminal — and it is last, which is exactly where truncation bites.
 * Turns outlive cost for the same reason: they show the run is still moving.
 */
export function formatRunLine(
  run: RunView,
  theme: WidgetTheme,
  width: number,
  columns: RunColumns = measureColumns([run]),
): string {
  const tone = runStatusTone(run.status);
  // The glyphs are not all one column wide — "⏳" is two — so pad the cell
  // rather than the string, or every row below a spinner sits one off.
  const glyph = runStatusGlyph(run.status);
  const glyphCell = glyph + " ".repeat(Math.max(0, 2 - visibleWidth(glyph)));

  const fixed =
    theme.fg(tone, `${glyphCell} `) +
    theme.fg("dim", `${run.id} `) +
    theme.fg("toolTitle", theme.bold(run.agent.padEnd(columns.agent)));
  const status = theme.fg(tone, `  ${formatRunStatus(run)}`);
  const model = theme.fg(
    "muted",
    `  ${formatModel(run.model).padEnd(columns.model)}`,
  );
  const turns = theme.fg(
    "dim",
    `  ${formatTurns(run.turns).padStart(columns.turns)}`,
  );
  const cost = theme.fg(
    "dim",
    `  ${formatCost(run.cost).padStart(columns.cost)}`,
  );

  for (const candidate of [
    fixed + model + turns + cost + status,
    fixed + turns + cost + status,
    fixed + turns + status,
    fixed + status,
  ]) {
    if (visibleWidth(candidate) <= width) return candidate;
  }
  return truncateToWidth(fixed + status, width, "…", true);
}

/** The whole widget: a titled rule, the rows, and an overflow summary. */
export function renderRunLines(
  runs: readonly RunView[],
  theme: WidgetTheme,
  width: number,
  maxRows: number = MAX_WIDGET_ROWS,
): string[] {
  if (runs.length === 0) return [];

  const ordered = orderRuns(runs);
  const shown = ordered.slice(0, maxRows);
  const hidden = ordered.length - shown.length;
  // Measured across the visible rows, so the fields line up as a table rather
  // than stepping in and out with each agent name and model id.
  const columns = measureColumns(shown);

  const title = ` subagents (${runs.length}) `;
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
    ...shown.map((run) => `  ${formatRunLine(run, theme, width - 2, columns)}`),
  ];

  if (hidden > 0) {
    lines.push(`  ${theme.fg("dim", `… and ${hidden} more`)}`);
  }
  return lines;
}

/** The part of pi's TUI a widget can reach: asking to be redrawn. */
export interface WidgetTui {
  requestRender(): void;
}

export interface WidgetComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** The slice of pi's UI context this widget needs. */
export interface WidgetHost {
  setWidget(
    key: string,
    content:
      | ((tui: WidgetTui, theme: WidgetTheme) => WidgetComponent)
      | undefined,
  ): void;
}

/**
 * Keep the widget in step with the registry. Returns an unsubscribe.
 *
 * The component reads the registry when it renders rather than closing over a
 * snapshot, so `setWidget` is only called when the widget appears or goes
 * away. Every other change — including the one-second tick — is a redraw
 * request, which avoids tearing down and rebuilding the widget once a second
 * for the whole life of a run.
 */
export function installRunsWidget(
  host: WidgetHost,
  runs: SubagentRuns,
): () => void {
  let installed = false;
  let requestRender: (() => void) | null = null;

  const update = () => {
    const isEmpty = runs.list().length === 0;

    if (isEmpty) {
      if (!installed) return;
      installed = false;
      requestRender = null;
      host.setWidget(WIDGET_KEY, undefined);
      return;
    }

    if (installed) {
      requestRender?.();
      return;
    }

    installed = true;
    host.setWidget(WIDGET_KEY, (tui, theme) => {
      requestRender = () => tui.requestRender();
      return {
        render: (width: number) => renderRunLines(runs.list(), theme, width),
        invalidate: () => {},
      };
    });
  };

  update();
  return runs.subscribe(update);
}
