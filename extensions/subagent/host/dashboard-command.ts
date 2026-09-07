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
import { Clock, Effect } from "effect";
import { inspectRun, runSummaries } from "../application/history.ts";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import {
  browserFooter,
  browserPanel,
  browserViewport,
  padBrowserLine,
} from "../presentation/browser-panel.ts";
import {
  HISTORY_CATEGORIES,
  historyCategory,
  historyColumnWidths,
  historyRow,
} from "../presentation/history.ts";
import {
  type InspectionBlock,
  inspectionBlocks,
  renderInspection,
} from "../presentation/inspection.ts";
import { observeOverview } from "./overview-observation.ts";
import type { SessionHandle } from "./session-handle.ts";
import type { CompletionHandoffView } from "./widget.ts";

export async function openDashboardUi(
  handle: SessionHandle,
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
        let overview: readonly SubagentSummary[] = [];
        let runs: readonly RunSummary[] = [];
        let selectedSubagent: SubagentId | undefined;
        let openSubagentId: SubagentId | undefined;
        let inspectedRunId: RunId | undefined;
        let refreshable = false;
        let details: readonly InspectionBlock[] = [];
        let detailLines: readonly string[] = [];
        let detailWidth: number | undefined;
        let detailOffset = 0;
        let detailPageSize = 1;
        const selectedRuns = new Map<SubagentId, RunId>();
        let loading = true;
        let error = false;
        let generation = 0;
        let offset = 0;
        let pageSize = 1;
        // A request remains pending until render acknowledges it, not until a
        // timer fires. Slow hosts therefore owe one frame reading the newest
        // rows, however many repository changes arrived meanwhile.
        let pending = false;
        let clock: Clock.Clock | undefined;
        let now = 0;
        let historyCapturedAt = 0;
        let stopOverview: (() => void) | undefined;
        let stopRead: (() => void) | undefined;
        let redraw: (() => void) | undefined = () => {
          if (closed) return;
          // Sample on publication/navigation, not on a timer or incidental render.
          now = clock?.currentTimeMillisUnsafe() ?? now;
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
          refreshable = false;
          pending = false;
          clock = undefined;
          overview = [];
          runs = [];
          details = [];
          detailLines = [];
          inspectedRunId = undefined;
          selectedRuns.clear();
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
        const ordered = () =>
          HISTORY_CATEGORIES.flatMap((category) =>
            overview.filter((row) => historyCategory(row) === category),
          );
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
          const requestedSubagentId = openSubagentId;
          const requestedRunId = inspectedRunId;
          loading = true;
          error = false;
          offset = 0;
          redraw?.();
          try {
            if (!clock) {
              const nextClock = await reader.run(Clock.Clock, undefined);
              if (closed || version !== generation) return;
              clock = nextClock;
            }
            if (requestedRunId) {
              const next = await reader.run(
                inspectRun(requestedRunId).pipe(
                  Effect.map((capture) => ({
                    lines: inspectionBlocks(
                      capture,
                      handoff.status(requestedRunId),
                    ),
                    refreshable: capture.outcome === "active",
                  })),
                ),
                { lines: [], refreshable: false },
              );
              if (closed || version !== generation) return;
              details = next.lines;
              refreshable = next.refreshable;
              detailWidth = undefined;
            } else if (requestedSubagentId) {
              const next = await reader.run(
                runSummaries(requestedSubagentId),
                [],
              );
              if (closed || version !== generation) return;
              runs = next;
              historyCapturedAt = clock?.currentTimeMillisUnsafe() ?? now;
              if (
                !runs.some(
                  (run) => run.runId === selectedRuns.get(requestedSubagentId),
                ) &&
                runs[0]
              ) {
                selectedRuns.set(requestedSubagentId, runs[0].runId);
              }
            } else {
              stopOverview = observeOverview(
                session,
                (next) => {
                  if (closed || version !== generation) return;
                  overview = next;
                  loading = false;
                  if (
                    !overview.some((row) => row.subagentId === selectedSubagent)
                  )
                    selectedSubagent = ordered()[0]?.subagentId;
                  redraw?.();
                },
                () => {
                  if (closed || version !== generation) return;
                  error = true;
                  loading = false;
                  redraw?.();
                },
              );
              return;
            }
          } catch {
            if (closed || version !== generation) return;
            error = true;
          } finally {
            reader.dispose();
            if (stopRead === reader.dispose) stopRead = undefined;
          }
          loading = false;
          redraw?.();
        };
        if (closed) queueMicrotask(close);
        else void read();

        return {
          dispose,
          invalidate() {
            detailWidth = undefined;
          },
          handleInput(data) {
            if (closed) return;
            if (keys.matches(data, "tui.select.cancel")) {
              if (inspectedRunId) {
                inspectedRunId = undefined;
                refreshable = false;
                details = [];
                detailLines = [];
                void read();
              } else if (openSubagentId) {
                openSubagentId = undefined;
                runs = [];
                void read();
              } else close();
              return;
            }
            if (loading || error) return;
            if (inspectedRunId) {
              if (
                refreshable &&
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
                detailOffset = Math.max(
                  0,
                  Math.min(
                    Math.max(0, detailLines.length - detailPageSize),
                    detailOffset + delta,
                  ),
                );
                redraw?.();
              }
              return;
            }
            if (keys.matches(data, "tui.select.confirm")) {
              if (!openSubagentId && selectedSubagent) {
                openSubagentId = selectedSubagent;
                void read();
              } else if (openSubagentId) {
                const selected = selectedRuns.get(openSubagentId);
                const run = runs.find((row) => row.runId === selected);
                if (run) {
                  refreshable = false;
                  inspectedRunId = run.runId;
                  detailOffset = 0;
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
            if (openSubagentId) {
              const selected = selectedRuns.get(openSubagentId);
              const index = runs.findIndex((run) => run.runId === selected);
              const next =
                runs[Math.max(0, Math.min(runs.length - 1, index + delta))];
              if (next) selectedRuns.set(openSubagentId, next.runId);
            } else {
              const rows = ordered();
              const index = rows.findIndex(
                (row) => row.subagentId === selectedSubagent,
              );
              selectedSubagent =
                rows[Math.max(0, Math.min(rows.length - 1, index + delta))]
                  ?.subagentId;
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
            if (inspectedRunId) {
              detailPageSize = Math.max(1, bodyHeight);
              if (detailWidth !== contentWidth) {
                detailLines = renderInspection(details, contentWidth, theme);
                detailWidth = contentWidth;
              }
              detailOffset = Math.max(
                0,
                Math.min(
                  detailOffset,
                  Math.max(0, detailLines.length - bodyHeight),
                ),
              );
              const refresh = refreshable
                ? `${rawKeyHint("r", "refresh")} · `
                : "";
              const back = keyHint("tui.select.cancel", "back");
              const scroll = movementHint();
              const page = rawKeyHint("←/→", "page");
              return browserPanel(
                viewport,
                details.length
                  ? `Subagent dashboard · run inspection · ${theme.fg(refreshable ? "warning" : "muted", `${refreshable ? "active" : "terminal"} snapshot`)}`
                  : "Subagent dashboard · run inspection",
                loading
                  ? [theme.fg("muted", "Capturing run snapshot…")]
                  : error
                    ? [
                        theme.fg(
                          "error",
                          "Result unavailable. Go back to run history.",
                        ),
                      ]
                    : detailLines.slice(
                        detailOffset,
                        detailOffset + bodyHeight,
                      ),
                browserFooter(
                  contentWidth,
                  loading || error
                    ? [back]
                    : [
                        `${scroll} · ${page} · ${refresh}${back}`,
                        `${page} · ${refresh}${back}`,
                        `${refresh}${back}`,
                        back,
                      ],
                  loading || error
                    ? ""
                    : range(detailOffset, detailLines.length),
                ),
                theme,
              );
            }
            pageSize = Math.max(1, bodyHeight);
            const enter = keyHint(
              "tui.select.confirm",
              openSubagentId ? "inspect" : "runs",
            );
            const lines: string[] = [];
            const listedRuns = openSubagentId
              ? runs
              : ordered().map((row) => row.current ?? row.latest);
            const preferredColumns = historyColumnWidths(listedRuns);
            let selectedLine = 0;
            const append = (run: RunSummary, selected: boolean) => {
              if (selected) selectedLine = lines.length;
              const row = historyRow(
                run,
                contentWidth,
                theme,
                selected,
                openSubagentId ? historyCapturedAt : now,
                preferredColumns,
              );
              lines.push(
                selected
                  ? theme.bg("selectedBg", padBrowserLine(row, contentWidth))
                  : row,
              );
            };
            if (loading) lines.push("Loading history…");
            else if (error)
              lines.push("History unavailable. Go back or close.");
            else if (openSubagentId) {
              for (const run of listedRuns)
                append(run, run.runId === selectedRuns.get(openSubagentId));
              if (!runs.length) lines.push("No runs available.");
            } else {
              for (const run of listedRuns)
                append(run, run.subagentId === selectedSubagent);
              if (!overview.length)
                lines.push(
                  theme.fg("muted", "No subagents in this session."),
                  theme.fg(
                    "dim",
                    "Delegated work will appear here, including completed runs.",
                  ),
                );
            }
            if (selectedLine < offset) offset = selectedLine;
            if (selectedLine + 1 > offset + bodyHeight)
              offset = Math.max(0, selectedLine + 1 - bodyHeight);
            offset = Math.min(offset, Math.max(0, lines.length - bodyHeight));
            const populated =
              !loading &&
              !error &&
              (openSubagentId ? runs.length > 0 : overview.length > 0);
            const back = keyHint(
              "tui.select.cancel",
              openSubagentId ? "back" : "close",
            );
            const scroll = movementHint();
            const page = rawKeyHint("←/→", "page");
            return browserPanel(
              viewport,
              openSubagentId
                ? `Subagent dashboard · run history${runs[0] ? ` · ${runs[0].profile}` : ""} · newest first`
                : "Subagent dashboard",
              lines.slice(offset, offset + bodyHeight),
              browserFooter(
                contentWidth,
                populated
                  ? [
                      `${scroll} · ${page} · ${enter} · ${back}`,
                      `${scroll} · ${enter} · ${back}`,
                      `${enter} · ${back}`,
                      back,
                    ]
                  : [back],
                populated ? range(offset, lines.length) : "",
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
