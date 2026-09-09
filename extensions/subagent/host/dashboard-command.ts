/**
 * A Session-owned dashboard: live overview, entry-only history.
 *
 * What is left here is transport. The page an operator is on, what their keys
 * mean on it, and every line the panel draws belong to the pure reducer in
 * presentation; this opens Pi's custom UI surface, reports what a keystroke
 * matched in the operator's bindings, performs the asynchronous reads a step
 * asks for, and guards which of them may still land.
 */
import os from "node:os";
import {
  type ExtensionContext,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  type DashboardIdentity,
  type DashboardKey,
  type DashboardPageChrome,
  type DashboardPageEvent,
  emptyDashboardPage,
  reduceDashboardPage,
} from "../presentation/index.ts";
import type { SessionObservationSource } from "./session-observation.ts";
import type { CompletionHandoffView } from "./widget.ts";

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
    // as this dashboard is open, so the header reads them once. The Subagent
    // counts beside them are not: those come from the page.
    const identity: DashboardIdentity = { cwd: ctx.cwd, home: os.homedir() };
    await ctx.ui.custom<void>(
      (tui, theme, keys, done) => {
        const chrome = (): DashboardPageChrome => ({
          identity,
          theme,
          moveKeys: [
            ...keys.getKeys("tui.select.up"),
            ...keys.getKeys("tui.select.down"),
          ],
          renderKeyHint: keyHint,
        });
        let page = emptyDashboardPage(session.currentInstant());
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
          page = reduceDashboardPage(
            page,
            { kind: "sampled", instant: session.currentInstant() },
            chrome(),
          ).page;
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
          page = emptyDashboardPage();
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
        /**
         * Take one step, and do the one thing it leaves behind.
         *
         * Reading, closing and drawing are this module's three mechanisms;
         * which of them a step calls for is the reducer's decision, not one
         * taken again here.
         */
        const step = (event: DashboardPageEvent): readonly string[] => {
          const next = reduceDashboardPage(page, event, chrome());
          page = next.page;
          if (next.ask === "read") void read();
          else if (next.ask === "close") close();
          else if (next.ask === "draw") redraw?.();
          return next.lines;
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
          const requested = page;
          step({ kind: "reading" });
          try {
            if (requested.kind === "overview") {
              stopOverview = session.watchSummaries(
                (summaries) => {
                  if (closed || version !== generation) return;
                  step({ kind: "summaries", summaries });
                },
                () => {
                  if (closed || version !== generation) return;
                  step({ kind: "failed" });
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
                step({
                  kind: "inspection",
                  capture,
                  handoff: handoff.status(requested.runId),
                });
            } else if (requested.kind === "history" && requested.subagentId) {
              const capture = await reader.captureHistory(requested.subagentId);
              if (closed || version !== generation) return;
              if (capture) step({ kind: "history", capture });
            }
          } catch {
            if (closed || version !== generation) return;
            step({ kind: "failed" });
          } finally {
            reader.dispose();
            if (stopRead === reader.dispose) stopRead = undefined;
          }
          step({ kind: "ready" });
        };
        if (closed) queueMicrotask(close);
        else void read();

        /**
         * Every meaning the operator's bindings give one keystroke.
         *
         * All of them, not the first: an operator may bind a selection key to
         * an arrow the dashboard already answers, and which of the two a page
         * acts on is the page's decision rather than one taken here. The host
         * reports what was pressed; the reducer decides what it does.
         */
        const dashboardKeys = (data: string): readonly DashboardKey[] => {
          const pressed: DashboardKey[] = [];
          if (keys.matches(data, "tui.select.cancel")) pressed.push("cancel");
          if (keys.matches(data, "tui.select.confirm")) pressed.push("confirm");
          if (keys.matches(data, "tui.select.up")) pressed.push("up");
          if (keys.matches(data, "tui.select.down")) pressed.push("down");
          if (keys.matches(data, "tui.select.pageUp")) pressed.push("pageUp");
          if (keys.matches(data, "tui.select.pageDown"))
            pressed.push("pageDown");
          if (matchesKey(data, "left")) pressed.push("left");
          if (matchesKey(data, "right")) pressed.push("right");
          if (matchesKey(data, "g")) pressed.push("beginning");
          if (matchesKey(data, "shift+g")) pressed.push("lastScreenful");
          if (matchesKey(data, "r") || matchesKey(data, "shift+r"))
            pressed.push("refresh");
          if (matchesKey(data, "t") || matchesKey(data, "shift+t"))
            pressed.push("toggleTranscript");
          return pressed;
        };

        return {
          dispose,
          invalidate() {
            step({ kind: "themed" });
          },
          handleInput(data) {
            if (closed) return;
            const pressed = dashboardKeys(data);
            if (pressed.length) step({ kind: "key", pressed });
          },
          handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
            if (
              closed ||
              page.kind !== "inspection" ||
              event.type !== "wheel" ||
              !event.wheelDelta
            )
              return undefined;
            step({ kind: "scroll", delta: event.wheelDelta });
            return { handled: true };
          },
          render(width) {
            if (closed) return [];
            pending = false;
            return [
              ...step({
                kind: "screen",
                width,
                terminalRows: tui.terminal.rows,
              }),
            ];
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
