/**
 * A Session-owned browser: live overview, entry-only history. The viewport
 * uses aligned, single-line rows with selection attached to Subagent/Run IDs.
 * Public identifiers stay in inspection rather than displacing work labels.
 */
import os from "node:os";
import {
  type ExtensionContext,
  keyHint,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import {
  type BrowserScreen,
  type BrowserViewport,
  browserBody,
  browserFooter,
  browserPanel,
  browserScreen,
  DASHBOARD_TITLE,
  type DashboardIdentity,
  dashboardBanner,
  dashboardBannerFits,
  HISTORY_CATEGORIES,
  historyCategory,
  historyRows,
  type InspectionBlock,
  inspectionBlocks,
  type RenderableTheme,
  renderInspection,
} from "../presentation/index.ts";
import type {
  RunHistoryCapture,
  SessionObservationSource,
} from "./session-observation.ts";
import type { CompletionHandoffView } from "./widget.ts";

type PageStatus = "loading" | "ready" | "error";

/** Which of the browser's three screens a page is. */
type PageKind = "overview" | "history" | "inspection";

/**
 * Everything the browser knows about where it is: which page, what that page
 * lists, what is selected, where it is scrolled, and the screen it was last
 * sized against.
 *
 * One value, not one shape per page. Three shapes meant every render
 * re-assembled the same handful of facts — the rows, the selected identity,
 * the instant to age them against, the title, whether there was anything at
 * all — differently per kind, and it meant two page sizes written while
 * drawing and read while handling a key, so navigation depended on render
 * order. Fields a kind does not use are simply not read; a union is what put
 * the per-kind assembly back into the render function.
 *
 * The screen belongs here for the same reason, and so does the header it was
 * split for: the overview's identity banner is four rows the list does not
 * get, so its height is an input to the panel's geometry, and holding it here
 * is what lets one render measure the screen once instead of measuring it and
 * then sizing it again.
 */
interface DashboardPage {
  readonly kind: PageKind;
  readonly status: PageStatus;
  /** The Subagent whose Runs this page lists or inspects; the overview has none. */
  readonly subagentId: SubagentId | undefined;
  /** The Run this page inspects; only an inspection has one. */
  readonly runId: RunId | undefined;
  /** The overview's population, which the header counts by category. */
  readonly summaries: readonly SubagentSummary[];
  /** The Runs a list page draws, in the order it draws them. */
  readonly runs: readonly RunSummary[];
  /** The one instant those Runs' durations are read against. */
  readonly capturedAt: number;
  /** An inspection's frozen capture. */
  readonly blocks: readonly InspectionBlock[];
  /** Whether that capture is of an active Run, so `R` can take another. */
  readonly refreshable: boolean;
  /** The Subagent the overview has selected, kept while a deeper page is open. */
  readonly selectedSubagentId: SubagentId | undefined;
  /**
   * The Run each Subagent's history had selected. Re-entering a history
   * returns to the Run an operator left it on; a Run that has since gone is
   * replaced by the newest.
   */
  readonly selectedRuns: ReadonlyMap<SubagentId, RunId>;
  readonly offset: number;
  /** The painted header: the identity banner, or one accented title line. */
  readonly header: readonly string[];
  /** The screen this page was last sized against, header rows already taken. */
  readonly viewport: BrowserViewport;
  /**
   * The page's own body lines, and the content width they were painted for.
   *
   * A list's rows are cheap and follow the selection, so they are repainted
   * whenever the page is sized. An inspection's lines are neither, so they are
   * kept until that width or the capture changes — and they stay the captured
   * *content* through a refresh read, because a loading message counted as
   * body would clamp the scroll offset back to the top.
   */
  readonly lines: readonly string[];
  readonly linesWidth: number | undefined;
}

/** What a page is sized against before a render has told it its screen. */
const EMPTY_VIEWPORT = browserBody(browserScreen(0, 0));

const emptyPage = (): DashboardPage => ({
  kind: "overview",
  status: "loading",
  subagentId: undefined,
  runId: undefined,
  summaries: [],
  runs: [],
  capturedAt: 0,
  blocks: [],
  refreshable: false,
  selectedSubagentId: undefined,
  selectedRuns: new Map(),
  offset: 0,
  header: [],
  viewport: EMPTY_VIEWPORT,
  lines: [],
  linesWidth: undefined,
});

/** Sections first, and within a section the order the Subagents arrived. */
const ordered = (summaries: readonly SubagentSummary[]) =>
  HISTORY_CATEGORIES.flatMap((category) =>
    summaries.filter((row) => historyCategory(row) === category),
  );

/** The Run this page's history has selected, if it has one. */
const selectedRun = (page: DashboardPage): RunId | undefined =>
  page.subagentId === undefined
    ? undefined
    : page.selectedRuns.get(page.subagentId);

/** Remember which Run this page's history has selected. */
const selectingRun = (
  page: DashboardPage,
  runId: RunId | undefined,
): DashboardPage => {
  if (page.subagentId === undefined || runId === undefined) return page;
  const selectedRuns = new Map(page.selectedRuns);
  selectedRuns.set(page.subagentId, runId);
  return { ...page, selectedRuns };
};

/** The identity the current page's selection is attached to. */
const pageSelection = (page: DashboardPage): RunId | SubagentId | undefined =>
  page.kind === "history" ? selectedRun(page) : page.selectedSubagentId;

/** Which of a list page's rows that identity is on, or `-1` for none of them. */
const selectedIndex = (page: DashboardPage): number => {
  const selection = pageSelection(page);
  return page.runs.findIndex((run) =>
    page.kind === "history"
      ? run.runId === selection
      : run.subagentId === selection,
  );
};

/** How far one page-scroll key moves, on any of the three screens. */
const pageSize = (page: DashboardPage) => Math.max(1, page.viewport.bodyHeight);

/**
 * What every arrival at a page has in common: a read in flight, the top of
 * the scroll, nothing painted, and no capture retained. Leaving an inspection
 * releases its content rather than holding it behind the page in front.
 */
const arriving = (
  page: DashboardPage,
  kind: PageKind,
  named: Pick<DashboardPage, "subagentId" | "runId">,
): DashboardPage => ({
  ...page,
  ...named,
  kind,
  status: "loading",
  blocks: [],
  refreshable: false,
  offset: 0,
  lines: [],
  linesWidth: undefined,
});

/** A page lists the Runs it read, never Runs carried in from another page. */
const unlisted = (page: DashboardPage): DashboardPage => ({
  ...page,
  runs: [],
  capturedAt: 0,
});

/** Enter one Subagent's history from the overview, which lists no Runs of its own. */
const enteringHistory = (
  page: DashboardPage,
  subagentId: SubagentId,
): DashboardPage =>
  unlisted(arriving(page, "history", { subagentId, runId: undefined }));

/** Inspect one Run of the history this page is on. */
const enteringInspection = (page: DashboardPage, runId: RunId): DashboardPage =>
  arriving(page, "inspection", { subagentId: page.subagentId, runId });

/** Leave an inspection for the history that opened it, which still lists its Runs. */
const leavingInspection = (page: DashboardPage): DashboardPage =>
  arriving(page, "history", {
    subagentId: page.subagentId,
    runId: undefined,
  });

/** Leave a history for the overview, dropping the Runs it had listed. */
const leavingHistory = (page: DashboardPage): DashboardPage =>
  unlisted(
    arriving(page, "overview", { subagentId: undefined, runId: undefined }),
  );

/** A read is in flight: say so, and take a list back to its first row. */
const loadingPage = (page: DashboardPage): DashboardPage => ({
  ...page,
  status: "loading",
  offset: page.kind === "inspection" ? page.offset : 0,
});

/** The read did not answer: say so rather than drawing a stale list as current. */
const failedPage = (page: DashboardPage): DashboardPage => ({
  ...page,
  status: "error",
});

/**
 * Sample the instant the overview's Run durations are read against.
 *
 * Only the overview's, and only on publication or navigation: a history or an
 * inspection is a capture, and its ages are the capture's own.
 */
const sampledPage = (page: DashboardPage, instant: number): DashboardPage =>
  page.kind === "overview" ? { ...page, capturedAt: instant } : page;

/** Take the overview's population, keeping the selected Subagent if it is still there. */
const withSummaries = (
  page: DashboardPage,
  summaries: readonly SubagentSummary[],
): DashboardPage => {
  const runs = ordered(summaries).map((row) => row.current ?? row.latest);
  return {
    ...page,
    status: "ready",
    summaries,
    runs,
    selectedSubagentId: summaries.some(
      (row) => row.subagentId === page.selectedSubagentId,
    )
      ? page.selectedSubagentId
      : runs[0]?.subagentId,
  };
};

/** Take one Subagent's captured Runs, keeping the selected Run if it is still there. */
const withHistory = (
  page: DashboardPage,
  capture: RunHistoryCapture,
): DashboardPage => {
  const listed: DashboardPage = {
    ...page,
    runs: capture.runs,
    capturedAt: capture.capturedAt,
  };
  const selected = selectedRun(page);
  return capture.runs.some((run) => run.runId === selected)
    ? listed
    : selectingRun(listed, capture.runs[0]?.runId);
};

/** Take one Run's frozen capture; its lines are repainted before they are read. */
const withInspection = (
  page: DashboardPage,
  blocks: readonly InspectionBlock[],
  refreshable: boolean,
): DashboardPage => ({ ...page, blocks, refreshable, linesWidth: undefined });

/** Move a list page's selection by rows, or by a whole page of them. */
const movedPage = (page: DashboardPage, delta: number): DashboardPage => {
  const next =
    page.runs[
      Math.max(0, Math.min(page.runs.length - 1, selectedIndex(page) + delta))
    ];
  if (page.kind === "history")
    return next ? selectingRun(page, next.runId) : page;
  return { ...page, selectedSubagentId: next?.subagentId };
};

/** Scroll an inspection's lines, never past either end of them. */
const scrolledPage = (page: DashboardPage, delta: number): DashboardPage => ({
  ...page,
  offset: Math.max(
    0,
    Math.min(
      Math.max(0, page.lines.length - pageSize(page)),
      page.offset + delta,
    ),
  ),
});

/** The one-line title of a page the identity banner does not head. */
const pageTitle = (page: DashboardPage, theme: RenderableTheme): string => {
  if (page.kind === "inspection")
    return page.blocks.length
      ? `${DASHBOARD_TITLE} · run inspection · ${theme.fg(page.refreshable ? "warning" : "muted", `${page.refreshable ? "active" : "terminal"} snapshot`)}`
      : `${DASHBOARD_TITLE} · run inspection`;
  if (page.kind === "history")
    return `${DASHBOARD_TITLE} · run history${page.runs[0] ? ` · ${page.runs[0].profile}` : ""} · newest first`;
  return DASHBOARD_TITLE;
};

/**
 * The header this page wants, decided before its body is measured.
 *
 * The banner's own decision reads only what a header height cannot change, so
 * the rows it takes are known in time to be taken out once. Until the overview
 * has reported a population the counts are left out rather than shown as
 * zeroes.
 */
const pageHeader = (
  page: DashboardPage,
  screen: BrowserScreen,
  identity: DashboardIdentity,
  theme: RenderableTheme,
): readonly string[] =>
  page.kind === "overview" && dashboardBannerFits(screen)
    ? dashboardBanner(
        identity,
        page.status === "ready" ? page.summaries : undefined,
        screen.contentWidth,
        theme,
      )
    : [theme.fg("accent", pageTitle(page, theme))];

/** The page's complete body, painted for the content width it now has. */
const pageLines = (
  page: DashboardPage,
  theme: RenderableTheme,
): Pick<DashboardPage, "lines" | "linesWidth"> => {
  const width = page.viewport.contentWidth;
  if (page.kind === "inspection")
    return page.linesWidth === width
      ? { lines: page.lines, linesWidth: page.linesWidth }
      : {
          lines: renderInspection(page.blocks, width, theme),
          linesWidth: width,
        };
  if (page.status === "loading")
    return { lines: ["Loading history…"], linesWidth: width };
  if (page.status === "error")
    return {
      lines: ["History unavailable. Go back or close."],
      linesWidth: width,
    };
  const rows = historyRows(
    page.runs,
    pageSelection(page),
    width,
    theme,
    page.capturedAt,
  );
  if (rows.length > 0) return { lines: rows, linesWidth: width };
  return {
    lines:
      page.kind === "history"
        ? ["No runs available."]
        : [
            theme.fg("muted", "No subagents in this session."),
            theme.fg(
              "dim",
              "Delegated work will appear here, including completed runs.",
            ),
          ],
    linesWidth: width,
  };
};

/**
 * Keep the selected row on the screen, then keep the scroll inside the body.
 *
 * One clamp for every page: a list follows its selection, an inspection has no
 * selection to follow, and both end inside the same bounds.
 */
const scrolledIntoView = (page: DashboardPage): DashboardPage => {
  const { bodyHeight } = page.viewport;
  let offset = page.offset;
  if (page.kind !== "inspection") {
    const selectedLine = Math.max(0, selectedIndex(page));
    if (selectedLine < offset) offset = selectedLine;
    if (selectedLine + 1 > offset + bodyHeight)
      offset = Math.max(0, selectedLine + 1 - bodyHeight);
  }
  return {
    ...page,
    offset: Math.min(offset, Math.max(0, page.lines.length - bodyHeight)),
  };
};

/**
 * Fold the screen the host is drawing on into the page.
 *
 * Measure, settle the header, split the body once, paint, clamp. The header
 * comes before the split because its rows come out of the body, and it can
 * come before it because its own decision needs nothing the split produces.
 */
const sizedPage = (
  page: DashboardPage,
  width: number,
  terminalRows: number,
  identity: DashboardIdentity,
  theme: RenderableTheme,
): DashboardPage => {
  const screen = browserScreen(width, terminalRows);
  const header = pageHeader(page, screen, identity, theme);
  const measured: DashboardPage = {
    ...page,
    header,
    viewport: browserBody(screen, header.length),
  };
  return scrolledIntoView({ ...measured, ...pageLines(measured, theme) });
};

/** Draw the page. Every fact this reads is already on the value. */
const drawPage = (
  page: DashboardPage,
  movement: string,
  theme: RenderableTheme,
): string[] => {
  const { contentWidth, bodyHeight } = page.viewport;
  const total = page.lines.length;
  const range =
    total > bodyHeight && bodyHeight > 0
      ? `${page.offset + 1}-${Math.min(page.offset + bodyHeight, total)}/${total}`
      : "";
  const back = keyHint(
    "tui.select.cancel",
    page.kind === "overview" ? "close" : "back",
  );
  const pageHint = rawKeyHint("←/→", "page");
  const body = page.lines.slice(page.offset, page.offset + bodyHeight);
  if (page.kind === "inspection") {
    const refresh = page.refreshable ? `${rawKeyHint("r", "refresh")} · ` : "";
    return browserPanel(
      page.viewport,
      page.header,
      page.status === "loading"
        ? [theme.fg("muted", "Capturing run snapshot…")]
        : page.status === "error"
          ? [theme.fg("error", "Result unavailable. Go back to run history.")]
          : body,
      browserFooter(
        contentWidth,
        page.status !== "ready"
          ? [back]
          : [
              `${movement} · ${pageHint} · ${refresh}${back}`,
              `${pageHint} · ${refresh}${back}`,
              `${refresh}${back}`,
              back,
            ],
        page.status !== "ready" ? "" : range,
      ),
      theme,
    );
  }
  const enter = keyHint(
    "tui.select.confirm",
    page.kind === "history" ? "inspect" : "runs",
  );
  const populated = page.status === "ready" && page.runs.length > 0;
  return browserPanel(
    page.viewport,
    page.header,
    body,
    browserFooter(
      contentWidth,
      populated
        ? [
            `${movement} · ${pageHint} · ${enter} · ${back}`,
            `${movement} · ${enter} · ${back}`,
            `${enter} · ${back}`,
            back,
          ]
        : [back],
      populated ? range : "",
    ),
    theme,
  );
};

export async function openDashboardUi(
  handle: SessionObservationSource,
  ctx: ExtensionContext,
  handoff: Pick<CompletionHandoffView, "status">,
): Promise<void> {
  let closed = false;
  let closeUi: (() => void) | undefined;
  const session = handle.observe(() => {
    closed = true;
    closeUi?.();
  });
  if (!session) return;
  try {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "Subagent dashboard requires interactive TUI mode.",
        "info",
      );
      return;
    }
    // The working directory and the operator's home are the same for as long
    // as this browser is open, so the header reads them once. The Subagent
    // counts beside them are not: those come from the page.
    const identity: DashboardIdentity = { cwd: ctx.cwd, home: os.homedir() };
    await ctx.ui.custom<void>(
      (tui, theme, keys, done) => {
        let page = sampledPage(emptyPage(), session.currentInstant());
        let generation = 0;
        // A request remains pending until render acknowledges it, not until a
        // timer fires. Slow hosts therefore owe one frame reading the newest
        // rows, however many observed changes arrived meanwhile.
        let pending = false;
        let stopOverview: (() => void) | undefined;
        let stopRead: (() => void) | undefined;
        let redraw: (() => void) | undefined = () => {
          if (closed) return;
          // Sample on publication/navigation, not on a timer or incidental render.
          page = sampledPage(page, session.currentInstant());
          if (pending) return;
          pending = true;
          tui.requestRender();
        };
        let finish: (() => void) | undefined = () => done(undefined);

        const dispose = () => {
          closed = true;
          generation += 1;
          stopOverview?.();
          stopOverview = undefined;
          stopRead?.();
          stopRead = undefined;
          session.dispose();
          pending = false;
          page = emptyPage();
          redraw = undefined;
          finish = undefined;
          closeUi = undefined;
        };
        const close = () => {
          const complete = finish;
          dispose();
          complete?.();
        };
        closeUi = close;
        const movementHint = () =>
          rawKeyHint(
            [
              ...keys.getKeys("tui.select.up"),
              ...keys.getKeys("tui.select.down"),
            ].join("/"),
            "move",
          );
        const read = async () => {
          const version = ++generation;
          stopRead?.();
          // Entry/refresh reads belong to this navigation, not merely the UI.
          // Escape interrupts them immediately without touching Run execution.
          const reader = handle.observe(() => {});
          if (!reader) return;
          stopRead = reader.dispose;
          stopOverview?.();
          stopOverview = undefined;
          const requested = page;
          page = loadingPage(page);
          redraw?.();
          try {
            if (requested.kind === "overview") {
              stopOverview = session.watchSummaries(
                (next) => {
                  if (closed || version !== generation) return;
                  page = withSummaries(page, next);
                  redraw?.();
                },
                () => {
                  if (closed || version !== generation) return;
                  page = failedPage(page);
                  redraw?.();
                },
              );
              return;
            }
            // A deeper page reads the identity it names, and a page that names
            // none has nothing to read.
            if (requested.kind === "inspection" && requested.runId) {
              const capture = await reader.inspectRun(requested.runId);
              if (closed || version !== generation) return;
              if (capture)
                page = withInspection(
                  page,
                  inspectionBlocks(capture, handoff.status(requested.runId)),
                  capture.outcome === "active",
                );
            } else if (requested.kind === "history" && requested.subagentId) {
              const capture = await reader.captureHistory(requested.subagentId);
              if (closed || version !== generation) return;
              if (capture) page = withHistory(page, capture);
            }
          } catch {
            if (closed || version !== generation) return;
            page = failedPage(page);
          } finally {
            reader.dispose();
            if (stopRead === reader.dispose) stopRead = undefined;
          }
          page = page.status === "error" ? page : { ...page, status: "ready" };
          redraw?.();
        };
        if (closed) queueMicrotask(close);
        else void read();

        return {
          dispose,
          invalidate() {
            // A theme change repaints an inspection's kept lines. A list's are
            // repainted every time the page is sized anyway.
            if (page.kind === "inspection")
              page = { ...page, linesWidth: undefined };
          },
          handleInput(data) {
            if (closed) return;
            if (keys.matches(data, "tui.select.cancel")) {
              if (page.kind === "overview") close();
              else {
                page =
                  page.kind === "inspection"
                    ? leavingInspection(page)
                    : leavingHistory(page);
                void read();
              }
              return;
            }
            if (page.status !== "ready") return;
            if (page.kind === "inspection") {
              if (
                page.refreshable &&
                (matchesKey(data, "r") || matchesKey(data, "shift+r"))
              ) {
                void read();
                return;
              }
              const delta = keys.matches(data, "tui.select.up")
                ? -1
                : keys.matches(data, "tui.select.down")
                  ? 1
                  : matchesKey(data, "left")
                    ? -pageSize(page)
                    : matchesKey(data, "right")
                      ? pageSize(page)
                      : 0;
              if (delta) {
                page = scrolledPage(page, delta);
                redraw?.();
              }
              return;
            }
            if (keys.matches(data, "tui.select.confirm")) {
              if (page.kind === "overview" && page.selectedSubagentId) {
                page = enteringHistory(page, page.selectedSubagentId);
                void read();
              } else if (page.kind === "history") {
                const selected = selectedRun(page);
                const run = page.runs.find((row) => row.runId === selected);
                if (run) {
                  page = enteringInspection(page, run.runId);
                  void read();
                }
              }
              return;
            }
            const delta = keys.matches(data, "tui.select.up")
              ? -1
              : keys.matches(data, "tui.select.down")
                ? 1
                : keys.matches(data, "tui.select.pageUp") ||
                    matchesKey(data, "left")
                  ? -pageSize(page)
                  : keys.matches(data, "tui.select.pageDown") ||
                      matchesKey(data, "right")
                    ? pageSize(page)
                    : 0;
            if (!delta) return;
            page = movedPage(page, delta);
            redraw?.();
          },
          render(width) {
            if (closed) return [];
            pending = false;
            page = sizedPage(page, width, tui.terminal.rows, identity, theme);
            return drawPage(page, movementHint(), theme);
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          margin: 0,
          anchor: "center",
        },
      },
    );
  } finally {
    closed = true;
    closeUi?.();
    session.dispose();
  }
}
