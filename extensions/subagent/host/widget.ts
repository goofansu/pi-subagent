/**
 * The adaptive widget, pinned above the editor: one active Run gets detail;
 * zero or multiple active Runs get only aggregate state.
 *
 * A Run finishes after the turn that started it, so the transcript cannot show
 * it — by the time the Subagent says anything, its `agent_start` row is
 * already final and scrolled away. This widget provides ambient visibility;
 * `/subagent dashboard` provides individual Runs and history.
 *
 * It is **observation-only**. It follows the Session's published Runs through
 * the application module's observation seam, folds nothing, and holds no
 * lifecycle state: the one thing it remembers is the latest index it was
 * handed, and that is a cache rather than state, because throwing it away and
 * re-reading would produce the same rows.
 *
 * ## Coalescing is the seam's rule, and this is the widget's share of it
 *
 * The published *snapshot* is conflated — a row holds one activity value,
 * replaced rather than appended, so a hundred progress updates grow the index
 * by nothing. The change *stream* is not: every publication is delivered, with
 * the index as it is at that moment, so a slow subscriber is never handed a
 * stale value but is still handed one delivery per change.
 *
 * So the subscriber here keeps only the latest index in a variable and asks
 * the host to render **at most once per change batch**, through the seam's
 * pending-refresh latch: a render is asked for, and further changes arriving
 * before the host draws re-arm nothing. Rendering reads the variable. A
 * backend reporting activity a thousand times a second therefore costs a
 * thousand cheap writes and as many renders as the terminal can actually draw,
 * rather than a thousand renders queued behind each other. The dashboard's
 * feed throttles its summary query with the same latch, which is why the two
 * surfaces cannot drift apart in how they throttle. In aggregate mode,
 * unchanged presentation counts request no redraw even after a frame has been
 * drawn. Source updates are still cached, so returning to single-Run detail
 * shows its newest activity.
 *
 * ## Appearing and disappearing
 *
 * `setWidget` is called when the widget appears and when it goes away, and
 * never in between: the component reads the reference when it renders rather
 * than closing over a snapshot, so a change is a redraw request rather than a
 * teardown and rebuild.
 *
 * A Run's visibility lasts from `agent_start` until its **completion hand-off is
 * resolved** — its notice landed, or the parent was handed its Result by
 * `agent_result` or by a wait — and not until the Run settles. A Run shorter than the turn
 * that started it settles before anybody has looked at the widget, so a row
 * that went at settlement would be a row nobody ever read. A parent that
 * fetched the Result at once, on the other hand, has done everything the
 * notice exists to make it do, so its row goes without waiting for a landing.
 *
 * The hand-off is the push sink's fact, so the widget is handed a read model
 * for it — one question and one subscription — and reads it without ever
 * writing it. It asks `status` and gets one of four answers, and *resolved*
 * deliberately does not say whether it was a landing or a retrieval: a row
 * that stays and a row that goes is the whole of what this component decides,
 * and one that knew more would eventually act on more.
 *
 * The two failed answers, `exhausted` and `unannounceable`, contribute separate
 * attention counts, not failed Run outcomes. The widget says what happened
 * without acting on delivery or consuming any Result.
 *
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { Effect, type Scope } from "effect";
import {
  followPublishedRuns,
  type ObservationServices,
  pendingRefresh,
  type RunIndex,
  type RunSnapshot,
} from "../application/observation.ts";
import { isTerminalRunPhase, type RunId } from "../domain/index.ts";
import {
  type HandoffStatus,
  handoffEndedBadly,
  type RenderableTheme,
  type RunRowView,
  renderRunRows,
  widgetSummary,
} from "../presentation/index.ts";

/** The widget key this extension owns in Pi's widget map. */
export const WIDGET_KEY = "subagent-runs";

/** The slice of Pi's UI context the widget needs. */
export interface WidgetHost {
  setWidget(
    key: string,
    content: ((tui: TUI, theme: RenderableTheme) => Component) | undefined,
    options?: unknown,
  ): void;
}

/**
 * What the widget shows, in index order: every Run that is not terminal, plus
 * every terminal Run whose hand-off is not resolved.
 *
 * An exhausted or unannounceable hand-off keeps its row and is marked, because
 * nothing is coming for it and a row that will never leave on its own has to
 * say why.
 */
export function widgetRows(
  index: RunIndex,
  status: (runId: RunId) => HandoffStatus,
): readonly RunRowView[] {
  return [...index.values()].flatMap((snapshot: RunSnapshot) => {
    if (!isTerminalRunPhase(snapshot.phase)) return [snapshot];
    const handoff = status(snapshot.identity.runId);
    if (handoff === "resolved") return [];
    // Presentation-only, and set from a host fact the widget already reads —
    // the snapshot is untouched, which is what keeps the repository out of
    // notification state (freeze F9).
    return handoffEndedBadly(handoff) ? [{ ...snapshot, handoff }] : [snapshot];
  });
}

/**
 * The hand-off the widget reads, which the Session push sink supplies.
 *
 * Named here rather than importing the sink's own type, because the widget
 * needs one question and one subscription and the sink is a whole delivery
 * surface. This is the boundary: a widget that could name the sink could push
 * a notification.
 *
 * One read model rather than a predicate per state, and that is the shape the
 * exhausted row paid for: `hasLanded` and `onLanding` would have become
 * `hasExhausted`, and then `wasRePushed`, and then `attempts`, each reasonable
 * beside the row that wanted it.
 */
export interface CompletionHandoffView {
  /** How far this Run's completion hand-off has got. */
  readonly status: (runId: RunId) => HandoffStatus;
  /** Called when any of that changes. Returns an unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What a test counts to measure coalescing. */
export interface WidgetActivity {
  /** How many index changes the subscriber observed. */
  readonly changes: number;
  /** How many renders the subscriber asked the host for. */
  readonly renderRequests: number;
}

export interface ActiveWidget {
  /** The rows the widget would draw right now. */
  readonly rows: () => readonly RunRowView[];
  readonly activity: () => WidgetActivity;
}

/**
 * Start the widget for one Session, in the Session Scope.
 *
 * Returns a handle a test reads. The uninstall is the Scope's job: the
 * subscription and the widget itself go when the Session Scope closes, which
 * is the same close that disposes the runtime.
 *
 * The requirement is the seam's whole union rather than the one service the
 * follow actually needs, because naming that service here is exactly the edge
 * the boundary rule removes — and asking for more than it uses costs a caller
 * that already holds every one of them nothing.
 */
export function installActiveWidget(
  host: WidgetHost,
  handoff: CompletionHandoffView,
  now: () => number,
): Effect.Effect<ActiveWidget, never, ObservationServices | Scope.Scope> {
  return Effect.gen(function* () {
    /**
     * The latest index and the rows it produced, as plain variables.
     *
     * Not a `Ref`: this is a cache of things the repository and the sink
     * already own, read only from the render callback, which is Pi's thread of
     * control rather than a fiber. A `Ref` would make reading it an Effect the
     * renderer had to run, which is machinery in the one place that should
     * have none.
     *
     * The index is kept beside the rows because a hand-off resolving changes
     * which rows the *same* index produces, and recomputing from the index is
     * what keeps this a cache: throwing both away and re-reading gives the
     * same answer.
     */
    let index: RunIndex = new Map();
    let latest: readonly RunRowView[] = [];
    let sampledAt = 0;
    let aggregateKey: string | undefined;
    let changes = 0;
    let renderRequests = 0;

    let installed = false;
    let requestRender: (() => void) | undefined;
    /**
     * The draw this widget has asked for and not yet been given.
     *
     * The coalescing rule itself is the observation seam's, and this is the
     * whole of the widget's share in it: a change arriving before the host has
     * drawn updates the cache and asks for nothing, because the draw that has
     * not happened yet will read the newer value anyway. The dashboard's feed
     * throttles its summary query with the same latch, which is what makes
     * "the two surfaces coalesce alike" a fact rather than a coincidence.
     */
    const draw = pendingRefresh(() => {
      renderRequests += 1;
      requestRender?.();
    });

    const render = (theme: RenderableTheme, width: number): string[] => {
      draw.done();
      // Incidental renders, resizes and hand-off updates reuse the last Run
      // publication's clock sample. Only Run events advance elapsed duration.
      return [...renderRunRows(latest, theme, width, sampledAt)];
    };

    const resetInstallState = (): void => {
      installed = false;
      requestRender = undefined;
      draw.done();
    };

    const uninstall = (): void => {
      if (!installed) return;
      resetInstallState();
      try {
        host.setWidget(WIDGET_KEY, undefined);
      } catch {
        // A stale Session's host throws on every method once it has been
        // replaced. The widget it can no longer clear is going with it.
      }
    };

    const install = (): void => {
      installed = true;
      try {
        host.setWidget(WIDGET_KEY, (tui, theme) => {
          requestRender = () => tui.requestRender();
          return {
            render: (width: number) => render(theme, width),
            invalidate: () => {},
          };
        });
      } catch {
        // As with uninstall, a stale Session's host can throw. Leave the
        // subscriber alive and the flag honest so its next update retries.
        resetInstallState();
      }
    };

    /** Reconcile the host with what the latest index says. */
    const reconcile = (
      rows: readonly RunRowView[],
      unchanged: boolean,
    ): void => {
      if (rows.length === 0) {
        uninstall();
        return;
      }
      if (!installed) {
        install();
        return;
      }
      if (!unchanged) draw.request();
    };

    /** Re-read both sources and put the host in step with them. */
    const refresh = (): void => {
      latest = widgetRows(index, handoff.status);
      const activeCount = latest.filter(
        (row) => !isTerminalRunPhase(row.phase),
      ).length;
      // widgetSummary is the complete Run-dependent header input. Equal chips
      // mean equal aggregate frames at a fixed width/theme; host-driven renders
      // still recompute their layout and paint. Single detail is never suppressed.
      const nextKey =
        activeCount === 1 ? undefined : JSON.stringify(widgetSummary(latest));
      const unchanged = nextKey !== undefined && nextKey === aggregateKey;
      aggregateKey = nextKey;
      // Always accept source changes, even when none of their detail is drawn.
      // Installation reconciliation runs even for equal summaries, so a failed
      // host install can retry on the next observed update.
      reconcile(latest, unchanged);
    };

    // The uninstall is registered before the subscription starts, so a Session
    // Scope that closes mid-change still clears the widget.
    yield* Effect.addFinalizer(() => Effect.sync(uninstall));

    // A landing, a retrieval and an exhaustion are host events rather than
    // index changes, so they arrive here rather than on the stream. The
    // unsubscribe is a finalizer for the same reason the uninstall is: the
    // listener must not outlive the Session whose rows it redraws.
    const stopWatchingHandoffs = handoff.subscribe(refresh);
    yield* Effect.addFinalizer(() => Effect.sync(stopWatchingHandoffs));

    yield* followPublishedRuns((published: RunIndex) => {
      changes += 1;
      index = published;
      sampledAt = now();
      refresh();
    });

    return {
      rows: () => latest,
      activity: () => ({ changes, renderRequests }),
    };
  });
}
