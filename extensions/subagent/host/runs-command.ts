/**
 * A Session-owned browser: live overview, entry-only history. The viewport
 * includes category headings and two-line rows, with a dedicated Label line. It therefore scrolls rendered lines while keeping
 * selection attached to Subagent/Run IDs rather than treating every line as a
 * SelectList item.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { runSummaries } from "../application/history.ts";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import {
  HISTORY_CATEGORIES,
  historyCategory,
  historyRow,
} from "../presentation/history.ts";
import { observeOverview } from "./overview-observation.ts";
import type { SessionHandle } from "./session-handle.ts";

export async function openRunsUi(
  handle: SessionHandle,
  ctx: ExtensionCommandContext,
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
          session.dispose();
          overview = [];
          runs = [];
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
          stopOverview?.();
          stopOverview = undefined;
          const requestedSubagentId = openSubagentId;
          loading = true;
          error = false;
          offset = 0;
          redraw?.();
          try {
            if (requestedSubagentId) {
              const next = await session.run(
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
              if (openSubagentId) {
                openSubagentId = undefined;
                runs = [];
                void read();
              } else close();
              return;
            }
            if (loading || error) return;
            if (keys.matches(data, "tui.select.confirm")) {
              if (!openSubagentId && selectedSubagent) {
                openSubagentId = selectedSubagent;
                void read();
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
            const height = Math.max(
              3,
              Math.floor((tui.terminal.rows || 24) * 0.8),
            );
            const bodyHeight = Math.max(1, height - 2);
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
              const row = historyRow(
                run,
                Math.max(0, width - 2),
                identity,
                phase,
                openSubagentId ? undefined : now,
              );
              lines.push(
                ...row.map((line, index) =>
                  selected
                    ? theme.fg("accent", `${index === 0 ? "> " : "  "}${line}`)
                    : `  ${line}`,
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
                lines.push(theme.bold(category));
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
              if (!overview.length) lines.push("No Subagents in this Session.");
            }
            if (selectedLine < offset) offset = selectedLine;
            if (selectedLine + 2 > offset + bodyHeight)
              offset = Math.max(0, selectedLine + 2 - bodyHeight);
            offset = Math.min(offset, Math.max(0, lines.length - bodyHeight));
            const hint = openSubagentId
              ? "↑/↓ scroll · Esc back"
              : "↑/↓ scroll · Enter Runs · Esc close";
            return [
              theme.bold(
                openSubagentId
                  ? `Run history · ${openSubagentId} · newest first`
                  : "Session Subagents",
              ),
              ...lines.slice(offset, offset + bodyHeight),
              `${hint} · ${Math.min(offset + 1, lines.length)}-${Math.min(offset + bodyHeight, lines.length)}/${lines.length}`,
            ].map((line) => truncateToWidth(line, Math.max(0, width), "…"));
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
