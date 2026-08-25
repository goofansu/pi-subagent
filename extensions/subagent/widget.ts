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
} from "./presentation.ts";
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

export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** Column widths shared by every row, so the fields read as a table. */
export interface RunColumns {
  agent: number;
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
    cost: widest(runs.map((run) => formatCost(run.cost))),
  };
}

/**
 * Running runs first, then everything else, each group newest last.
 *
 * What is still happening is what the reader is watching; a settled run is
 * only here until its notification lands.
 */
export function orderRuns(runs: readonly RunView[]): RunView[] {
  const running = runs.filter((run) => run.status === "running");
  const settled = runs.filter((run) => run.status !== "running");
  return [...running, ...settled];
}

/** How much room an activity tail needs before it is worth starting. */
const MIN_ACTIVITY_WIDTH = 12;

/**
 * One run as a single line: agent, cost, status, and — while the run is still
 * going — what it is doing right now.
 *
 * Deliberately no run id and no model. The widget is read by the operator,
 * and a human names a run by its agent and what it is doing; ids live in the
 * tool results and notifications, where the model that acts on them reads them, and
 * the model an agent runs as is the profile's business. Cost is dropped when
 * the line will not fit. Status is the field a reader is actually watching,
 * so it must survive a narrow terminal — and it is last, which is exactly
 * where truncation bites.
 *
 * The activity tail is the first thing sacrificed: it takes whatever width is
 * left after the columns, and is skipped entirely when that is too little to
 * read. Before the child's first tool call the run's description stands in,
 * which is also what tells two runs of the same agent apart.
 */
export function formatRunLine(
  run: RunView,
  theme: WidgetTheme,
  width: number,
  columns: RunColumns = measureColumns([run]),
): string {
  const tone = runStatusTone(run.status);
  // Padded to a fixed cell rather than trusting the glyph, so a future glyph
  // that is not one column wide cannot shift its row against the others.
  const glyph = runStatusGlyph(run.status);
  const glyphCell = glyph + " ".repeat(Math.max(0, 2 - visibleWidth(glyph)));

  const fixed =
    theme.fg(tone, `${glyphCell} `) +
    theme.fg("toolTitle", theme.bold(run.agent.padEnd(columns.agent)));
  const status = theme.fg(tone, `  ${formatRunStatus(run)}`);
  const cost = theme.fg(
    "dim",
    `  ${formatCost(run.cost).padStart(columns.cost)}`,
  );

  for (const candidate of [fixed + cost + status, fixed + status]) {
    if (visibleWidth(candidate) <= width) {
      return candidate + formatActivityTail(run, theme, width, candidate);
    }
  }
  return truncateToWidth(fixed + status, width, "…", true);
}

/** The dim "what it is doing" tail, fitted to the width the columns left. */
function formatActivityTail(
  run: RunView,
  theme: WidgetTheme,
  width: number,
  line: string,
): string {
  if (run.status !== "running") return "";
  const doing = run.activity ?? run.description;
  if (!doing) return "";
  const remaining = width - visibleWidth(line);
  if (remaining < MIN_ACTIVITY_WIDTH) return "";
  return theme.fg("dim", truncateToWidth(`  · ${doing}`, remaining, "…"));
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
    ...shown.map((run) => ` ${formatRunLine(run, theme, width - 1, columns)}`),
  ];

  if (hidden > 0) {
    lines.push(` ${theme.fg("dim", `… and ${hidden} more`)}`);
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
 * Keep the widget in step with the registry. Returns an uninstall that
 * detaches the subscription and clears the widget from the host.
 *
 * The component reads the registry when it renders rather than closing over a
 * snapshot, so `setWidget` is only called when the widget appears or goes
 * away. Every other change is a redraw request, which avoids tearing down and
 * rebuilding the widget on each of a run's facts.
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
  const unsubscribe = runs.subscribe(update);

  // Uninstalling undoes what installing did: the subscription and the widget
  // itself. The interactive host happens to clear extension widgets on every
  // session change, but that is its courtesy, not this module's contract —
  // a host that does not would otherwise keep showing the last rows forever,
  // because a fresh install over an empty registry never clears the key.
  return () => {
    unsubscribe();
    if (!installed) return;
    installed = false;
    requestRender = null;
    try {
      host.setWidget(WIDGET_KEY, undefined);
    } catch {
      // A stale session's host throws on every method once replaced; the
      // widget it can no longer clear is being discarded with it anyway.
    }
  };
}
