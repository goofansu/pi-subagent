/**
 * The dashboard's identity header: the Pi mark, and beside it what an operator
 * has to know before reading a single row.
 *
 * ```
 *  ██████    Subagent dashboard
 *  ██  ██    ~/code/pi-subagent
 *  ████  ██  1 active · 0 needs attention · 3 completed
 *  ██    ██
 * ```
 *
 * Two facts beside the name and nothing else: which working directory its Runs
 * were started in, and how many Subagents are in each of the categories the
 * list below is grouped by. A dashboard opened in the wrong checkout looks
 * exactly like one opened in the right checkout until the working directory is
 * on the screen.
 *
 * The mark is the product logo's own 4×4 grid, one pixel to two terminal
 * columns and one row, because a cell is about twice as tall as it is wide and
 * that ratio is the one that comes out square. Whole blocks rather than half
 * blocks for the same reason the grid is 4×4 rather than resampled: the source
 * mark has no half pixels, so nothing drawn here has to guess at one.
 *
 * The header degrades rather than clipping. A long working directory keeps its
 * leaf rather than its root, a narrow screen names only the categories holding
 * something, and a screen too small for the mark to earn its columns is given
 * the plain title instead — {@link dashboardBannerFits} is that decision, made
 * by the caller from the measured screen before it splits the body, because
 * the header's height changes how many rows the list gets.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentSummary } from "../domain/history.ts";
import type { BrowserScreen } from "./browser-panel.ts";
import {
  HISTORY_CATEGORIES,
  type HistoryCategory,
  historyCategoryCounts,
} from "./history.ts";
import type { RenderableTheme } from "./rows.ts";
import { fitToWidth } from "./run-line.ts";

/** Every input here is plain, so the shared clip discards its own resets. */
const PLAIN = { plain: true } as const;

/** The browser's own name, on every one of its screens. */
export const DASHBOARD_TITLE = "Subagent dashboard";

/** The Pi mark: its 4×4 grid, two terminal columns per pixel. */
export const PI_MARK: readonly string[] = [
  "██████  ",
  "██  ██  ",
  "████  ██",
  "██    ██",
];

const MARK_WIDTH = 8;

/** The mark and the text it introduces are separated by two spaces. */
const MARK_GUTTER = "  ";

/** Below this the identity text is not worth the columns the mark costs. */
const MIN_IDENTITY_WIDTH = 24;

/** A header this tall leaves a screen shorter than this with no list to read. */
const MIN_BANNER_ROWS = 12;

/** What the header says about where this dashboard is running. */
export interface DashboardIdentity {
  readonly cwd: string;
  /** The operator's home, for the `~` every shell prompt writes. */
  readonly home?: string;
}

/** `~` for the operator's home, as every shell prompt writes it. */
export function abbreviateHome(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const root = home.endsWith("/") ? home.slice(0, -1) : home;
  if (root === "") return cwd;
  if (cwd === root) return "~";
  return cwd.startsWith(`${root}/`) ? `~${cwd.slice(root.length)}` : cwd;
}

/**
 * Clip a path to its leaf rather than its root.
 *
 * A working directory is recognised by where it ends, so a path too long for
 * the columns available drops leading segments and says so with an ellipsis.
 */
export function clipPath(path: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(path) <= width) return path;
  const segments = path.split("/");
  while (segments.length > 1) {
    segments.shift();
    const candidate = `…/${segments.join("/")}`;
    if (visibleWidth(candidate) <= width) return candidate;
  }
  return fitToWidth(path, width, PLAIN);
}

/**
 * The population of the list below, in the categories it is grouped by.
 *
 * Every category is named, zeroes included, because "0 needs attention" is
 * itself worth reading. A screen too narrow for all three names only the
 * categories holding something: a count clipped mid-word says less than a
 * shorter line that is complete.
 */
export function subagentCounts(
  subagents: readonly SubagentSummary[],
  width: number,
): string {
  const counts = historyCategoryCounts(subagents);
  const named = (categories: readonly HistoryCategory[]) =>
    categories
      .map((category) => `${counts[category]} ${category.toLowerCase()}`)
      .join(" · ");
  const every = named(HISTORY_CATEGORIES);
  if (visibleWidth(every) <= width) return every;
  const occupied = named(
    HISTORY_CATEGORIES.filter((category) => counts[category] > 0),
  );
  return occupied !== "" && visibleWidth(occupied) <= width
    ? occupied
    : fitToWidth(occupied === "" ? every : occupied, width, PLAIN);
}

/** Whether the screen has room for the mark without starving the list. */
export function dashboardBannerFits(viewport: BrowserScreen): boolean {
  return (
    viewport.spacious &&
    viewport.height >= MIN_BANNER_ROWS &&
    viewport.contentWidth >=
      MARK_WIDTH + MARK_GUTTER.length + MIN_IDENTITY_WIDTH
  );
}

/**
 * The painted header, one line per row of the mark.
 *
 * `subagents` is `undefined` while the overview has yet to report a
 * population, and the counts line is then left blank rather than filled with
 * zeroes: a header that said "0 active" over a list still loading would be
 * stating something it does not know.
 */
export function dashboardBanner(
  identity: DashboardIdentity,
  subagents: readonly SubagentSummary[] | undefined,
  width: number,
  theme: RenderableTheme,
): readonly string[] {
  const textWidth = Math.max(0, width - MARK_WIDTH - MARK_GUTTER.length);
  const details = [
    theme.fg("accent", fitToWidth(DASHBOARD_TITLE, textWidth, PLAIN)),
    theme.fg(
      "muted",
      clipPath(abbreviateHome(identity.cwd, identity.home), textWidth),
    ),
    subagents === undefined
      ? ""
      : theme.fg("muted", subagentCounts(subagents, textWidth)),
  ];
  return PI_MARK.map(
    (row, index) =>
      theme.fg("accent", row) + MARK_GUTTER + (details[index] ?? ""),
  );
}
