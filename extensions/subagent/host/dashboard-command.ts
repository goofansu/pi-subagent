/**
 * A Session-owned browser: live overview, entry-only history. The viewport
 * uses aligned, single-line rows with selection attached to Subagent/Run IDs.
 * Public identifiers stay in inspection rather than displacing work labels.
 */
import {
  type ExtensionContext,
  keyHint,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import {
  browserFooter,
  browserPanel,
  browserViewport,
} from "../presentation/browser-panel.ts";
import {
  HISTORY_CATEGORIES,
  historyCategory,
  historyRows,
} from "../presentation/history.ts";
import {
  type InspectionBlock,
  inspectionBlocks,
  renderInspection,
} from "../presentation/inspection.ts";
import type {
  RunHistoryCapture,
  SessionObservationSource,
} from "./session-observation.ts";
import type { CompletionHandoffView } from "./widget.ts";

type PageStatus = "loading" | "ready" | "error";

interface OverviewPage {
  readonly kind: "overview";
  status: PageStatus;
  summaries: readonly SubagentSummary[];
  selectedSubagentId: SubagentId | undefined;
  offset: number;
}

interface HistoryPage {
  readonly kind: "history";
  status: PageStatus;
  readonly subagentId: SubagentId;
  capture: RunHistoryCapture;
  selectedRunId: RunId | undefined;
  offset: number;
}

interface InspectionPage {
  readonly kind: "inspection";
  status: PageStatus;
  readonly subagentId: SubagentId;
  readonly runId: RunId;
  blocks: readonly InspectionBlock[];
  lines: readonly string[];
  renderedWidth: number | undefined;
  refreshable: boolean;
  offset: number;
}

type DashboardPage = OverviewPage | HistoryPage | InspectionPage;

const emptyHistoryCapture = (): RunHistoryCapture => ({
  runs: [],
  capturedAt: 0,
});

const createOverviewPage = (): OverviewPage => ({
  kind: "overview",
  status: "loading",
  summaries: [],
  selectedSubagentId: undefined,
  offset: 0,
});

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
    await ctx.ui.custom<void>(
      (tui, theme, keys, done) => {
        const historyPages = new Map<SubagentId, HistoryPage>();
        let overviewPage = createOverviewPage();
        let page: DashboardPage = overviewPage;
        let detailPageSize = 1;
        let pageSize = 1;
        let generation = 0;
        // A request remains pending until render acknowledges it, not until a
        // timer fires. Slow hosts therefore owe one frame reading the newest
        // rows, however many observed changes arrived meanwhile.
        let pending = false;
        let now = session.currentInstant();
        let stopOverview: (() => void) | undefined;
        let stopRead: (() => void) | undefined;
        let redraw: (() => void) | undefined = () => {
          if (closed) return;
          // Sample on publication/navigation, not on a timer or incidental render.
          now = session.currentInstant();
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
          historyPages.clear();
          overviewPage = createOverviewPage();
          page = overviewPage;
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
        const ordered = (summaries: readonly SubagentSummary[]) =>
          HISTORY_CATEGORIES.flatMap((category) =>
            summaries.filter((row) => historyCategory(row) === category),
          );
        const movementHint = () =>
          rawKeyHint(
            [
              ...keys.getKeys("tui.select.up"),
              ...keys.getKeys("tui.select.down"),
            ].join("/"),
            "move",
          );
        const historyPage = (subagentId: SubagentId): HistoryPage => {
          const retained = historyPages.get(subagentId);
          if (retained) {
            retained.status = "loading";
            retained.offset = 0;
            return retained;
          }
          const created: HistoryPage = {
            kind: "history",
            status: "loading",
            subagentId,
            capture: emptyHistoryCapture(),
            selectedRunId: undefined,
            offset: 0,
          };
          historyPages.set(subagentId, created);
          return created;
        };
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
          const requestedPage = page;
          requestedPage.status = "loading";
          if (requestedPage.kind !== "inspection") requestedPage.offset = 0;
          redraw?.();
          try {
            if (requestedPage.kind === "inspection") {
              const capture = await reader.inspectRun(requestedPage.runId);
              if (closed || version !== generation) return;
              if (capture) {
                requestedPage.blocks = inspectionBlocks(
                  capture,
                  handoff.status(requestedPage.runId),
                );
                requestedPage.refreshable = capture.outcome === "active";
                requestedPage.renderedWidth = undefined;
              }
            } else if (requestedPage.kind === "history") {
              const capture = await reader.captureHistory(
                requestedPage.subagentId,
              );
              if (closed || version !== generation) return;
              if (capture) {
                requestedPage.capture = capture;
                if (
                  !capture.runs.some(
                    (run) => run.runId === requestedPage.selectedRunId,
                  ) &&
                  capture.runs[0]
                ) {
                  requestedPage.selectedRunId = capture.runs[0].runId;
                }
              }
            } else {
              stopOverview = session.watchSummaries(
                (next) => {
                  if (closed || version !== generation) return;
                  requestedPage.summaries = next;
                  requestedPage.status = "ready";
                  if (
                    !next.some(
                      (row) =>
                        row.subagentId === requestedPage.selectedSubagentId,
                    )
                  )
                    requestedPage.selectedSubagentId =
                      ordered(next)[0]?.subagentId;
                  overviewPage = requestedPage;
                  redraw?.();
                },
                () => {
                  if (closed || version !== generation) return;
                  requestedPage.status = "error";
                  redraw?.();
                },
              );
              return;
            }
          } catch {
            if (closed || version !== generation) return;
            requestedPage.status = "error";
          } finally {
            reader.dispose();
            if (stopRead === reader.dispose) stopRead = undefined;
          }
          requestedPage.status =
            requestedPage.status === "error" ? "error" : "ready";
          redraw?.();
        };
        if (closed) queueMicrotask(close);
        else void read();

        return {
          dispose,
          invalidate() {
            if (page.kind === "inspection") page.renderedWidth = undefined;
          },
          handleInput(data) {
            if (closed) return;
            if (keys.matches(data, "tui.select.cancel")) {
              if (page.kind === "inspection") {
                page = historyPage(page.subagentId);
                void read();
              } else if (page.kind === "history") {
                page.capture = emptyHistoryCapture();
                page = overviewPage;
                void read();
              } else close();
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
                    ? -detailPageSize
                    : matchesKey(data, "right")
                      ? detailPageSize
                      : 0;
              if (delta) {
                page.offset = Math.max(
                  0,
                  Math.min(
                    Math.max(0, page.lines.length - detailPageSize),
                    page.offset + delta,
                  ),
                );
                redraw?.();
              }
              return;
            }
            if (keys.matches(data, "tui.select.confirm")) {
              if (page.kind === "overview" && page.selectedSubagentId) {
                page = historyPage(page.selectedSubagentId);
                void read();
              } else if (page.kind === "history") {
                const selected = page.selectedRunId;
                const run = page.capture.runs.find(
                  (row) => row.runId === selected,
                );
                if (run) {
                  page = {
                    kind: "inspection",
                    status: "loading",
                    subagentId: page.subagentId,
                    runId: run.runId,
                    blocks: [],
                    lines: [],
                    renderedWidth: undefined,
                    refreshable: false,
                    offset: 0,
                  };
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
                  ? -pageSize
                  : keys.matches(data, "tui.select.pageDown") ||
                      matchesKey(data, "right")
                    ? pageSize
                    : 0;
            if (!delta) return;
            if (page.kind === "history") {
              const selected = page.selectedRunId;
              const index = page.capture.runs.findIndex(
                (run) => run.runId === selected,
              );
              const next =
                page.capture.runs[
                  Math.max(
                    0,
                    Math.min(page.capture.runs.length - 1, index + delta),
                  )
                ];
              if (next) page.selectedRunId = next.runId;
            } else if (page.kind === "overview") {
              const overview = page;
              const rows = ordered(overview.summaries);
              const index = rows.findIndex(
                (row) => row.subagentId === overview.selectedSubagentId,
              );
              overview.selectedSubagentId =
                rows[
                  Math.max(0, Math.min(rows.length - 1, index + delta))
                ]?.subagentId;
            }
            redraw?.();
          },
          render(width) {
            if (closed) return [];
            pending = false;
            const viewport = browserViewport(width, tui.terminal.rows);
            const { contentWidth, bodyHeight } = viewport;
            const range = (start: number, total: number) =>
              total > bodyHeight && bodyHeight > 0
                ? `${start + 1}-${Math.min(start + bodyHeight, total)}/${total}`
                : "";
            if (page.kind === "inspection") {
              detailPageSize = Math.max(1, bodyHeight);
              if (page.renderedWidth !== contentWidth) {
                page.lines = renderInspection(page.blocks, contentWidth, theme);
                page.renderedWidth = contentWidth;
              }
              page.offset = Math.max(
                0,
                Math.min(
                  page.offset,
                  Math.max(0, page.lines.length - bodyHeight),
                ),
              );
              const refresh = page.refreshable
                ? `${rawKeyHint("r", "refresh")} · `
                : "";
              const back = keyHint("tui.select.cancel", "back");
              const scroll = movementHint();
              const pageHint = rawKeyHint("←/→", "page");
              return browserPanel(
                viewport,
                page.blocks.length
                  ? `Subagent dashboard · run inspection · ${theme.fg(page.refreshable ? "warning" : "muted", `${page.refreshable ? "active" : "terminal"} snapshot`)}`
                  : "Subagent dashboard · run inspection",
                page.status === "loading"
                  ? [theme.fg("muted", "Capturing run snapshot…")]
                  : page.status === "error"
                    ? [
                        theme.fg(
                          "error",
                          "Result unavailable. Go back to run history.",
                        ),
                      ]
                    : page.lines.slice(page.offset, page.offset + bodyHeight),
                browserFooter(
                  contentWidth,
                  page.status !== "ready"
                    ? [back]
                    : [
                        `${scroll} · ${pageHint} · ${refresh}${back}`,
                        `${pageHint} · ${refresh}${back}`,
                        `${refresh}${back}`,
                        back,
                      ],
                  page.status !== "ready"
                    ? ""
                    : range(page.offset, page.lines.length),
                ),
                theme,
              );
            }
            pageSize = Math.max(1, bodyHeight);
            const listPage = page;
            const isHistory = listPage.kind === "history";
            const enter = keyHint(
              "tui.select.confirm",
              isHistory ? "inspect" : "runs",
            );
            let listedRuns: readonly RunSummary[];
            let selectedIdentity: RunId | SubagentId | undefined;
            let capturedAt: number;
            let title: string;
            let hasEntries: boolean;
            if (listPage.kind === "history") {
              listedRuns = listPage.capture.runs;
              selectedIdentity = listPage.selectedRunId;
              capturedAt = listPage.capture.capturedAt;
              title = `Subagent dashboard · run history${listedRuns[0] ? ` · ${listedRuns[0].profile}` : ""} · newest first`;
              hasEntries = listedRuns.length > 0;
            } else {
              listedRuns = ordered(listPage.summaries).map(
                (row) => row.current ?? row.latest,
              );
              selectedIdentity = listPage.selectedSubagentId;
              capturedAt = now;
              title = "Subagent dashboard";
              hasEntries = listPage.summaries.length > 0;
            }
            const lines =
              listPage.status === "loading"
                ? ["Loading history…"]
                : listPage.status === "error"
                  ? ["History unavailable. Go back or close."]
                  : historyRows(
                      listedRuns,
                      selectedIdentity,
                      contentWidth,
                      theme,
                      capturedAt,
                    );
            if (listPage.status === "ready" && lines.length === 0) {
              if (isHistory) lines.push("No runs available.");
              else
                lines.push(
                  theme.fg("muted", "No subagents in this session."),
                  theme.fg(
                    "dim",
                    "Delegated work will appear here, including completed runs.",
                  ),
                );
            }
            const selectedLine = Math.max(
              0,
              listedRuns.findIndex((run) =>
                isHistory
                  ? run.runId === selectedIdentity
                  : run.subagentId === selectedIdentity,
              ),
            );
            if (selectedLine < listPage.offset) listPage.offset = selectedLine;
            if (selectedLine + 1 > listPage.offset + bodyHeight)
              listPage.offset = Math.max(0, selectedLine + 1 - bodyHeight);
            listPage.offset = Math.min(
              listPage.offset,
              Math.max(0, lines.length - bodyHeight),
            );
            const populated = listPage.status === "ready" && hasEntries;
            const back = keyHint(
              "tui.select.cancel",
              isHistory ? "back" : "close",
            );
            const scroll = movementHint();
            const pageHint = rawKeyHint("←/→", "page");
            return browserPanel(
              viewport,
              title,
              lines.slice(listPage.offset, listPage.offset + bodyHeight),
              browserFooter(
                contentWidth,
                populated
                  ? [
                      `${scroll} · ${pageHint} · ${enter} · ${back}`,
                      `${scroll} · ${enter} · ${back}`,
                      `${enter} · ${back}`,
                      back,
                    ]
                  : [back],
                populated ? range(listPage.offset, lines.length) : "",
              ),
              theme,
            );
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
