/**
 * A Session-owned browser: live overview, entry-only history. The viewport
 * includes category headings and two-line rows, with a dedicated Label line. It therefore scrolls rendered lines while keeping
 * selection attached to Subagent/Run IDs rather than treating every line as a
 * SelectList item.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Effect } from "effect";
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
  historyRow,
} from "../presentation/history.ts";
import { inspectionLines } from "../presentation/inspection.ts";
import { observeOverview } from "./overview-observation.ts";
import type { SessionHandle } from "./session-handle.ts";
import type { CompletionHandoffView } from "./widget.ts";

export async function openRunsUi(
  handle: SessionHandle,
  ctx: ExtensionCommandContext,
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
        "Run history browsing requires interactive TUI mode.",
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
        let details: readonly string[] = [];
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
        // rows, however many repository changes or age ticks arrived meanwhile.
        let pending = false;
        let now = 0;
        let stopOverview: (() => void) | undefined;
        let stopRead: (() => void) | undefined;
        let redraw: (() => void) | undefined = () => {
          if (closed || pending) return;
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
            if (requestedRunId) {
              const next = await reader.run(
                inspectRun(requestedRunId).pipe(
                  Effect.map((capture) => ({
                    lines: inspectionLines(
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
                (next, instant) => {
                  if (closed || version !== generation) return;
                  overview = next;
                  now = instant;
                  loading = false;
                  if (
                    !overview.some((row) => row.subagentId === selectedSubagent)
                  )
                    selectedSubagent = ordered()[0]?.subagentId;
                  redraw?.();
                },
                (instant) => {
                  if (closed || version !== generation) return;
                  now = instant;
                  if (
                    overview.some(
                      (row) => (row.current ?? row.latest).lastActivity,
                    )
                  )
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
          invalidate() {},
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
                : keys.matches(data, "tui.select.pageUp")
                  ? -pageSize
                  : keys.matches(data, "tui.select.pageDown")
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
                detailLines = details.flatMap((line) =>
                  wrapTextWithAnsi(line, Math.max(1, contentWidth)),
                );
                detailWidth = contentWidth;
              }
              detailOffset = Math.max(
                0,
                Math.min(
                  detailOffset,
                  Math.max(0, detailLines.length - bodyHeight),
                ),
              );
              const refresh = refreshable ? "R refresh · " : "";
              return browserPanel(
                viewport,
                details.length
                  ? `Run inspection · ${theme.fg(refreshable ? "warning" : "muted", `${refreshable ? "active" : "terminal"} snapshot`)}`
                  : "Run inspection",
                loading
                  ? [theme.fg("muted", "Capturing Run snapshot…")]
                  : error
                    ? [
                        theme.fg(
                          "error",
                          "Result unavailable. Escape to return to Run history.",
                        ),
                      ]
                    : detailLines.slice(
                        detailOffset,
                        detailOffset + bodyHeight,
                      ),
                browserFooter(
                  contentWidth,
                  loading || error
                    ? ["Esc back"]
                    : [
                        `↑/↓ lines · ←/→ page · ${refresh}Esc back`,
                        `↑↓ · ←→ · ${refresh}Esc back`,
                        `${refresh}Esc back`,
                        "Esc back",
                      ],
                  loading || error
                    ? ""
                    : range(detailOffset, detailLines.length),
                ),
                theme,
              );
            }
            pageSize = Math.max(1, Math.floor(bodyHeight / 2));
            const lines: string[] = [];
            let selectedLine = 0;
            const append = (
              run: RunSummary,
              selected: boolean,
              identity: string,
              phase?: string,
            ) => {
              if (selected) selectedLine = lines.length;
              // On narrow terminals spend indentation on the Label instead.
              const labelInset = width >= 32 ? "  " : "";
              const row = historyRow(
                run,
                Math.max(0, contentWidth - labelInset.length),
                identity,
                phase,
                openSubagentId ? undefined : now,
                theme,
              );
              lines.push(
                ...row.map((line, index) =>
                  selected
                    ? theme.bg(
                        "selectedBg",
                        padBrowserLine(
                          theme.fg(
                            "accent",
                            `${index === 0 ? "> " : labelInset}${line}`,
                          ),
                          contentWidth,
                        ),
                      )
                    : `${index === 0 ? "  " : labelInset}${line}`,
                ),
              );
            };
            if (loading) lines.push("Loading history…");
            else if (error)
              lines.push("History unavailable. Escape to go back or close.");
            else if (openSubagentId) {
              for (const run of runs)
                append(
                  run,
                  run.runId === selectedRuns.get(openSubagentId),
                  run.runId,
                );
              if (!runs.length) lines.push("No Runs available.");
            } else {
              const counts = new Map<string, number>();
              for (const row of overview)
                counts.set(
                  row.latest.profile,
                  (counts.get(row.latest.profile) ?? 0) + 1,
                );
              for (const category of HISTORY_CATEGORIES) {
                const rows = overview.filter(
                  (row) => historyCategory(row) === category,
                );
                if (!rows.length) continue;
                lines.push(
                  theme.fg(
                    category === "Active"
                      ? "warning"
                      : category === "Needs attention"
                        ? "error"
                        : "success",
                    theme.bold(category),
                  ),
                );
                for (const row of rows)
                  append(
                    row.current ?? row.latest,
                    row.subagentId === selectedSubagent,
                    (counts.get(row.latest.profile) ?? 0) > 1
                      ? row.subagentId.replace(/^subagent-/, "")
                      : "",
                    row.phase,
                  );
              }
              if (!overview.length)
                lines.push(
                  theme.fg("muted", "No Subagents in this Session."),
                  theme.fg(
                    "dim",
                    "Delegated work will appear here, including completed Runs.",
                  ),
                );
            }
            if (selectedLine < offset) offset = selectedLine;
            if (selectedLine + Math.min(2, bodyHeight) > offset + bodyHeight)
              offset = Math.max(
                0,
                selectedLine + Math.min(2, bodyHeight) - bodyHeight,
              );
            offset = Math.min(offset, Math.max(0, lines.length - bodyHeight));
            const populated =
              !loading &&
              !error &&
              (openSubagentId ? runs.length > 0 : overview.length > 0);
            const back = openSubagentId ? "Esc back" : "Esc close";
            const enter = openSubagentId ? "Enter inspect Run" : "Enter Runs";
            return browserPanel(
              viewport,
              openSubagentId
                ? `Run history · ${openSubagentId} · newest first`
                : "Session Subagents",
              lines.slice(offset, offset + bodyHeight),
              browserFooter(
                contentWidth,
                populated
                  ? [
                      `↑/↓ scroll · PgUp/PgDn · ${enter} · ${back}`,
                      `↑↓ · ${enter} · ${back}`,
                      `Enter open · ${back}`,
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
        overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
      },
    );
  } finally {
    closed = true;
    closeUi?.();
    session.dispose();
  }
}
