/**
 * The dashboard's navigation: one page value and one reducer over it.
 *
 * A page is where the dashboard is — which of the three screens it is on, what
 * that screen lists, what is selected, where it is scrolled, and the terminal
 * it was last sized against. One event moves it: a key the host has already
 * resolved against the operator's bindings, the screen a render is drawing on,
 * or a read that has arrived. A step names the next page, the lines it draws
 * to, and the one thing the host is left to do.
 *
 * A reducer over a value, never an object that mutates. Presentation folds no
 * events and holds no lifecycle state: a view offset is not Run state, and a
 * module that kept one between calls would be presentation that had started
 * owning lifecycle, which is how v1's dispatcher came to own presentation
 * state. Everything here is a pure function of the page, the event, and the
 * chrome it is painted with — the operator's keymap included, which is why the
 * selection keys and the hint renderer that resolves a binding are handed in
 * rather than reached for.
 *
 * What stays at the host is transport: the custom UI surface, the asynchronous
 * reads, and the generation guard deciding whether a late one may still land.
 */

import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  RunHistoryCapture,
  RunSummary,
  SubagentSummary,
} from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import {
  DASHBOARD_TITLE,
  type DashboardIdentity,
  dashboardBanner,
  dashboardBannerFits,
} from "./banner.ts";
import {
  type DashboardScreen,
  type DashboardViewport,
  dashboardBody,
  dashboardFooter,
  dashboardPanel,
  dashboardScreen,
} from "./dashboard-panel.ts";
import {
  HISTORY_CATEGORIES,
  historyCategory,
  historyRows,
  overviewRows,
} from "./history.ts";
import {
  type InspectionBlock,
  inspectionBlocks,
  renderInspection,
} from "./inspection.ts";
import type { KeyHintRenderer } from "./renderers.ts";
import type { RenderableTheme } from "./rows.ts";
import type { HandoffStatus } from "./views.ts";

/** Whether the read this page is showing is in flight, answered, or lost. */
export type DashboardPageStatus = "loading" | "ready" | "error";

/** Which of the dashboard's three screens a page is. */
export type DashboardPageKind = "overview" | "history" | "inspection";

/**
 * Everything the dashboard knows about where it is: which page, what that page
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
export interface DashboardPage {
  readonly kind: DashboardPageKind;
  readonly status: DashboardPageStatus;
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
  /** Whether large text parts in the transcript are shown in full. */
  readonly transcriptExpanded: boolean;
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
  readonly viewport: DashboardViewport;
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

/**
 * What one keystroke means, named for the page rather than for the keyboard.
 *
 * The host resolves the operator's bindings, because a keymap is a Session
 * service and this module may not hold one. `pageUp` and `pageDown` are those
 * configured bindings; `left`, `right`, the boundary jumps, and `refresh` are
 * meanings the dashboard answers itself whatever the bindings are.
 *
 * A keystroke can mean several of these at once — an operator who binds
 * `tui.select.pageUp` to the left arrow has pressed both — so a key event
 * carries every meaning it matched and each page picks the one it acts on. An
 * inspection scrolls on the arrows and does not page on the bindings; a list
 * does both. Deciding that here rather than at the host is what keeps a
 * rebinding from silently taking a movement away from one page.
 */
export type DashboardKey =
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "left"
  | "right"
  | "beginning"
  | "lastScreenful"
  | "confirm"
  | "cancel"
  | "refresh"
  | "toggleTranscript";

/**
 * What moves a page.
 *
 * A key, the screen a render is drawing on, or a read — one going out, one
 * arriving, one that did not answer. Nothing here is a mechanism: the host
 * decides *when* to read and this decides what the page becomes when it does.
 */
export type DashboardPageEvent =
  /** The terminal a render is drawing on, before its header is chosen. */
  | {
      readonly kind: "screen";
      readonly width: number;
      readonly terminalRows: number;
    }
  /** One keystroke, as every meaning the operator's bindings gave it. */
  | { readonly kind: "key"; readonly pressed: readonly DashboardKey[] }
  /** Scroll inspection by Pi's normalized logical-line delta. */
  | { readonly kind: "scroll"; readonly delta: number }
  /** The instant the overview's Run durations are read against. */
  | { readonly kind: "sampled"; readonly instant: number }
  /** A read for this page went out. */
  | { readonly kind: "reading" }
  /** The overview's population changed. */
  | {
      readonly kind: "summaries";
      readonly summaries: readonly SubagentSummary[];
    }
  /** One Subagent's Run history arrived. */
  | { readonly kind: "history"; readonly capture: RunHistoryCapture }
  /** One Run's inspection capture arrived. */
  | {
      readonly kind: "inspection";
      readonly capture: RunInspection;
      readonly handoff: HandoffStatus;
    }
  /** The read did not answer. */
  | { readonly kind: "failed" }
  /** The read is over, and did not fail. */
  | { readonly kind: "ready" }
  /** The theme changed under a page that keeps its painted lines. */
  | { readonly kind: "themed" };

/**
 * What the page is painted with that is not the page.
 *
 * The working directory the banner names, the operator's theme, their
 * selection keys, and how a configured action's hint is spelled. All four are
 * the host's to supply and none is state: they are read on the way through and
 * never kept.
 */
export interface DashboardPageChrome {
  readonly identity: DashboardIdentity;
  readonly theme: RenderableTheme;
  /** The operator's configured selection keys, as the movement hint names them. */
  readonly moveKeys: readonly string[];
  /**
   * How the footer spells a configured action — the way back, the way in.
   *
   * Injected exactly as the notice renderers inject it, and for the same
   * reason: Pi's helper resolves the binding from the process keymap, and a
   * footer that reached for it directly could not be stated by a test without
   * standing one up.
   */
  readonly renderKeyHint: KeyHintRenderer;
}

/**
 * The one thing a step leaves for the host: transport, never navigation.
 *
 * `read` means this page wants the asynchronous read its kind implies, `close`
 * that the dashboard is done, `draw` that what is on screen is stale. The host
 * owns all three mechanisms and none of the decisions.
 */
export type DashboardPageAsk = "nothing" | "draw" | "read" | "close";

/**
 * A step: the page the event leads to, the screen it draws to, and what is
 * left for the host.
 *
 * The screen is painted for the event that carries one, because a page is
 * drawn against the terminal it is drawn on and no other event names that.
 * Every other event asks the host for a render and is painted then, so
 * painting here as well would paint the same page twice for every publication
 * a burst brings.
 */
export interface DashboardPageStep {
  readonly page: DashboardPage;
  readonly lines: readonly string[];
  readonly ask: DashboardPageAsk;
}

/** What a page is sized against before a render has told it its screen. */
const EMPTY_VIEWPORT = dashboardBody(dashboardScreen(0, 0));

/**
 * A dashboard that has just opened: the overview, with its read in flight.
 *
 * The instant is the overview's own, sampled at the moment the dashboard opened,
 * because the ages it will draw are relative to it.
 */
export function emptyDashboardPage(capturedAt = 0): DashboardPage {
  return {
    kind: "overview",
    status: "loading",
    subagentId: undefined,
    runId: undefined,
    summaries: [],
    runs: [],
    capturedAt,
    blocks: [],
    refreshable: false,
    transcriptExpanded: false,
    selectedSubagentId: undefined,
    selectedRuns: new Map(),
    offset: 0,
    header: [],
    viewport: EMPTY_VIEWPORT,
    lines: [],
    linesWidth: undefined,
  };
}

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

/**
 * The one clamp: keep a position inside a run of them, from zero to `last`.
 *
 * Every movement on every page ends here — a selection inside its rows, a
 * scroll inside its lines — so three page kinds cannot bound themselves three
 * ways, which is what let one of them scroll a line past its own content.
 */
const within = (value: number, last: number) =>
  Math.max(0, Math.min(last, value));

/**
 * The furthest down this page can be scrolled.
 *
 * As far as leaves the last line on the screen, and no further. A page whose
 * content is shorter than its body does not scroll at all, which is what the
 * lower bound says. A body of no rows at all bounds nothing, deliberately:
 * there is no last line to leave on a screen that draws none, and the next
 * screen tall enough to draw one clamps against it.
 */
const clampedOffset = (page: DashboardPage, offset: number): number =>
  within(offset, page.lines.length - page.viewport.bodyHeight);

/** How far one page-scroll key moves, on any of the three screens. */
const pageSize = (page: DashboardPage) => Math.max(1, page.viewport.bodyHeight);

/**
 * What every arrival at a page has in common: a read in flight, the top of
 * the scroll, nothing painted, and no capture retained. Leaving an inspection
 * releases its content rather than holding it behind the page in front.
 */
const arriving = (
  page: DashboardPage,
  kind: DashboardPageKind,
  named: Pick<DashboardPage, "subagentId" | "runId">,
): DashboardPage => ({
  ...page,
  ...named,
  kind,
  status: "loading",
  blocks: [],
  refreshable: false,
  transcriptExpanded: false,
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
  capture: RunInspection,
  handoff: HandoffStatus,
): DashboardPage => ({
  ...page,
  blocks: inspectionBlocks(capture, handoff),
  refreshable: capture.outcome === "active",
  linesWidth: undefined,
});

/** Move a list page's selection by rows, or by a whole page of them. */
const movedPage = (page: DashboardPage, delta: number): DashboardPage => {
  const next =
    page.runs[within(selectedIndex(page) + delta, page.runs.length - 1)];
  if (page.kind === "history")
    return next ? selectingRun(page, next.runId) : page;
  return { ...page, selectedSubagentId: next?.subagentId };
};

/** Scroll an inspection's lines, never past either end of them. */
const scrolledPage = (page: DashboardPage, delta: number): DashboardPage => ({
  ...page,
  offset: clampedOffset(page, page.offset + delta),
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
 * One case, whichever page it is: the overview's four-row identity banner and
 * the one accented title line a history or an inspection gets are both header
 * lines, and their count is the height the body is split against. The banner's
 * own decision reads only what a header height cannot change, so the rows it
 * takes are known in time to be taken out once. Until the overview has
 * reported a population the counts are left out rather than shown as zeroes.
 */
const pageHeader = (
  page: DashboardPage,
  screen: DashboardScreen,
  chrome: DashboardPageChrome,
): readonly string[] =>
  page.kind === "overview" && dashboardBannerFits(screen)
    ? dashboardBanner(
        chrome.identity,
        page.status === "ready" ? page.summaries : undefined,
        screen.contentWidth,
        chrome.theme,
      )
    : [chrome.theme.fg("accent", pageTitle(page, chrome.theme))];

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
          lines: renderInspection(
            page.blocks,
            width,
            theme,
            page.transcriptExpanded,
          ),
          linesWidth: width,
        };
  if (page.status === "loading")
    return { lines: ["Loading history…"], linesWidth: width };
  if (page.status === "error")
    return {
      lines: ["History unavailable. Go back or close."],
      linesWidth: width,
    };
  const rows = (page.kind === "history" ? historyRows : overviewRows)(
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
 * A list follows its selection, an inspection has no selection to follow, and
 * both end in the same clamp.
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
  return { ...page, offset: clampedOffset(page, offset) };
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
  chrome: DashboardPageChrome,
): DashboardPage => {
  const screen = dashboardScreen(width, terminalRows);
  const header = pageHeader(page, screen, chrome);
  const measured: DashboardPage = {
    ...page,
    header,
    viewport: dashboardBody(screen, header.length),
  };
  return scrolledIntoView({
    ...measured,
    ...pageLines(measured, chrome.theme),
  });
};

/** One hint in the footer, and the rung it is given up at. */
interface FooterHint {
  readonly text: string;
  /** The rung this hint is dropped at; rung 0 offers every hint. */
  readonly droppedAt: number;
}

/**
 * The footer's ladder: the same hints, given up one rung at a time.
 *
 * The hints are listed in the order they are shown and each names the rung it
 * is given up at, because those two orders are not the same — a list gives up
 * its page keys before its movement keys, an inspection the other way round.
 * The last rung is the back hint alone, which is never given up: a way out an
 * operator cannot see is a way out they cannot take.
 */
const footerLadder = (
  hints: readonly FooterHint[],
  back: string,
): readonly string[] =>
  Array.from(
    { length: Math.max(0, ...hints.map((hint) => hint.droppedAt)) + 1 },
    (_, rung) =>
      [
        ...hints
          .filter((hint) => hint.droppedAt > rung)
          .map((hint) => hint.text),
        back,
      ].join(" · "),
  );

/** Inspection keeps every applicable action before its optional position. */
const inspectionFooter = (
  width: number,
  hints: readonly string[],
  range: string,
): string => {
  const complete = hints[0];
  if (complete && range) {
    const withRange = `${complete} · ${range}`;
    if (visibleWidth(withRange) <= width) return withRange;
  }
  return dashboardFooter(width, hints);
};

/** Draw the page. Every fact this reads is already on the value. */
const drawPage = (
  page: DashboardPage,
  chrome: DashboardPageChrome,
): readonly string[] => {
  const { theme } = chrome;
  const { contentWidth, bodyHeight } = page.viewport;
  const total = page.lines.length;
  const range =
    total > bodyHeight && bodyHeight > 0
      ? `${page.offset + 1}-${Math.min(page.offset + bodyHeight, total)}/${total}`
      : "";
  const back = chrome.renderKeyHint(
    "tui.select.cancel",
    page.kind === "overview" ? "close" : "back",
  );
  const movement = rawKeyHint(chrome.moveKeys.join("/"), "move");
  const pageHint = rawKeyHint("←/→", "page");
  const body = page.lines.slice(page.offset, page.offset + bodyHeight);
  if (page.kind === "inspection") {
    const ready = page.status === "ready";
    const hasTranscript = page.blocks.some(
      (block) => block.kind === "heading" && block.text === "Transcript:",
    );
    return dashboardPanel(
      page.viewport,
      page.header,
      page.status === "loading"
        ? [theme.fg("muted", "Capturing run snapshot…")]
        : page.status === "error"
          ? [theme.fg("error", "Result unavailable. Go back to run history.")]
          : body,
      ready
        ? inspectionFooter(
            contentWidth,
            footerLadder(
              [
                {
                  text: rawKeyHint(chrome.moveKeys.join("/"), "scroll"),
                  droppedAt: 1,
                },
                { text: pageHint, droppedAt: 2 },
                { text: rawKeyHint("g/G", "jump"), droppedAt: 3 },
                ...(hasTranscript
                  ? [
                      {
                        text: rawKeyHint(
                          "t",
                          page.transcriptExpanded ? "compact" : "expand",
                        ),
                        droppedAt: 4,
                      },
                    ]
                  : []),
                ...(page.refreshable
                  ? [{ text: rawKeyHint("r", "refresh"), droppedAt: 5 }]
                  : []),
              ],
              back,
            ),
            range,
          )
        : back,
      theme,
    );
  }
  const enter = chrome.renderKeyHint(
    "tui.select.confirm",
    page.kind === "history" ? "inspect" : "runs",
  );
  const populated = page.status === "ready" && page.runs.length > 0;
  return dashboardPanel(
    page.viewport,
    page.header,
    body,
    dashboardFooter(
      contentWidth,
      populated
        ? footerLadder(
            [
              { text: movement, droppedAt: 2 },
              { text: pageHint, droppedAt: 1 },
              { text: enter, droppedAt: 3 },
            ],
            back,
          )
        : [back],
      populated ? range : "",
    ),
    theme,
  );
};

/**
 * How far a keystroke scrolls an inspection: one line, or a screen of them.
 *
 * The arrows, and only the arrows: an inspection has no selection, so the
 * bindings that move one are not what it pages on.
 */
const scrollDelta = (
  page: DashboardPage,
  pressed: readonly DashboardKey[],
): number =>
  pressed.includes("up")
    ? -1
    : pressed.includes("down")
      ? 1
      : pressed.includes("left")
        ? -pageSize(page)
        : pressed.includes("right")
          ? pageSize(page)
          : 0;

/** How far a keystroke moves a list's selection: one row, or a page of them. */
const moveDelta = (
  page: DashboardPage,
  pressed: readonly DashboardKey[],
): number =>
  pressed.includes("up")
    ? -1
    : pressed.includes("down")
      ? 1
      : pressed.includes("pageUp") || pressed.includes("left")
        ? -pageSize(page)
        : pressed.includes("pageDown") || pressed.includes("right")
          ? pageSize(page)
          : 0;

/** The page a keystroke leads to, and what the host owes it. */
const keyed = (
  page: DashboardPage,
  pressed: readonly DashboardKey[],
): Omit<DashboardPageStep, "lines"> => {
  if (pressed.includes("cancel")) {
    if (page.kind === "overview") return { page, ask: "close" };
    return {
      page:
        page.kind === "inspection"
          ? leavingInspection(page)
          : leavingHistory(page),
      ask: "read",
    };
  }
  // A page that is still reading answers nothing but the way out of it.
  if (page.status !== "ready") return { page, ask: "nothing" };
  if (page.kind === "inspection") {
    if (page.refreshable && pressed.includes("refresh"))
      return { page, ask: "read" };
    if (pressed.includes("toggleTranscript"))
      return {
        page: {
          ...page,
          transcriptExpanded: !page.transcriptExpanded,
          linesWidth: undefined,
        },
        ask: "draw",
      };
    if (pressed.includes("beginning"))
      return { page: scrolledPage(page, -page.lines.length), ask: "draw" };
    if (pressed.includes("lastScreenful"))
      return { page: scrolledPage(page, page.lines.length), ask: "draw" };
    const delta = scrollDelta(page, pressed);
    return delta
      ? { page: scrolledPage(page, delta), ask: "draw" }
      : { page, ask: "nothing" };
  }
  if (pressed.includes("confirm")) {
    if (page.kind === "overview" && page.selectedSubagentId)
      return {
        page: enteringHistory(page, page.selectedSubagentId),
        ask: "read",
      };
    if (page.kind === "history") {
      const selected = selectedRun(page);
      const run = page.runs.find((row) => row.runId === selected);
      if (run)
        return { page: enteringInspection(page, run.runId), ask: "read" };
    }
    return { page, ask: "nothing" };
  }
  const delta = moveDelta(page, pressed);
  return delta
    ? { page: movedPage(page, delta), ask: "draw" }
    : { page, ask: "nothing" };
};

/** The page an event leads to, before it is drawn. */
const stepped = (
  page: DashboardPage,
  event: DashboardPageEvent,
  chrome: DashboardPageChrome,
): Omit<DashboardPageStep, "lines"> => {
  switch (event.kind) {
    case "screen":
      return {
        page: sizedPage(page, event.width, event.terminalRows, chrome),
        ask: "nothing",
      };
    case "key":
      return keyed(page, event.pressed);
    case "scroll":
      return page.kind === "inspection" && event.delta !== 0
        ? { page: scrolledPage(page, event.delta), ask: "draw" }
        : { page, ask: "nothing" };
    // Sampling is what a redraw does on its way out, so asking for one here
    // would ask for the draw that asked for the sample.
    case "sampled":
      return { page: sampledPage(page, event.instant), ask: "nothing" };
    case "reading":
      return { page: loadingPage(page), ask: "draw" };
    case "summaries":
      return { page: withSummaries(page, event.summaries), ask: "draw" };
    case "history":
      return { page: withHistory(page, event.capture), ask: "nothing" };
    case "inspection":
      return {
        page: withInspection(page, event.capture, event.handoff),
        ask: "nothing",
      };
    case "failed":
      return { page: failedPage(page), ask: "draw" };
    case "ready":
      return {
        page: page.status === "error" ? page : { ...page, status: "ready" },
        ask: "draw",
      };
    // A theme change repaints an inspection's kept lines. A list's are
    // repainted every time the page is sized anyway.
    case "themed":
      return {
        page:
          page.kind === "inspection"
            ? { ...page, linesWidth: undefined }
            : page,
        ask: "nothing",
      };
  }
};

/**
 * One event, one page, one step.
 *
 * The whole of the dashboard's navigation is here: which screen an operator is
 * on, what their keys mean on it, where the selection and the scroll end up,
 * how tall the header is, and what the panel around it says.
 */
export function reduceDashboardPage(
  page: DashboardPage,
  event: DashboardPageEvent,
  chrome: DashboardPageChrome,
): DashboardPageStep {
  const step = stepped(page, event, chrome);
  return {
    ...step,
    lines: event.kind === "screen" ? drawPage(step.page, chrome) : [],
  };
}
