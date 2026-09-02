/**
 * The active widget: one row per live Run, pinned above the editor.
 *
 * A Run finishes after the turn that started it, so the transcript cannot show
 * it — by the time the Subagent says anything, its `agent_start` row is
 * already final and scrolled away. This widget is the only place live Runs are
 * visible, which makes it part of the feature rather than a decoration on it.
 *
 * It is **observation-only**. It reads the repository's published index, folds
 * nothing, and holds no lifecycle state: the one thing it remembers is the
 * latest index it was handed, and that is a cache rather than state, because
 * throwing it away and re-reading would produce the same rows.
 *
 * ## Coalescing is the consumer's job
 *
 * The M2 exit gate left this decision to its first real consumer, and this is
 * it. The published *snapshot* is conflated — a row holds one activity value,
 * replaced rather than appended, so a hundred progress updates grow the index
 * by nothing. The change *stream* is not: `SubscriptionRef.changes` delivers
 * one element per change however far behind a subscriber is, and the
 * repository's `subscribe` reads the current index at each delivery, so a slow
 * subscriber is never handed a stale value but is still handed one element per
 * change.
 *
 * So the subscriber here keeps only the latest index in a reference and asks
 * the host to render **at most once per change batch**: a render request is
 * armed, and further changes arriving before the host renders re-arm nothing.
 * Rendering reads the reference. A backend reporting activity a thousand times
 * a second therefore costs a thousand cheap reference writes and as many
 * renders as the terminal can actually draw, rather than a thousand renders
 * queued behind each other.
 *
 * ## Appearing and disappearing
 *
 * `setWidget` is called when the widget appears and when it goes away, and
 * never in between: the component reads the reference when it renders rather
 * than closing over a snapshot, so a change is a redraw request rather than a
 * teardown and rebuild. A terminal Run leaves the widget at publication, which
 * is a deliberate difference from v1 — v1 kept a settled row until its
 * notification landed, and the row's job here is to show what is *live*.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { Effect, type Scope, Stream } from "effect";
import { isTerminalRunPhase } from "../domain/index.ts";
import {
  type RenderableTheme,
  type RunRowView,
  renderRunRows,
} from "../presentation/index.ts";
import type { RunIndex, RunSnapshot } from "../runtime/repository.ts";
import { RunRepository } from "../runtime/repository.ts";

/** The widget key this extension owns in Pi's widget map. */
export const WIDGET_KEY = "subagent-v2-runs";

/** The slice of Pi's UI context the widget needs. */
export interface WidgetHost {
  setWidget(
    key: string,
    content: ((tui: TUI, theme: RenderableTheme) => Component) | undefined,
    options?: unknown,
  ): void;
}

/** What the widget shows: the Runs that are not terminal, in index order. */
export function liveRows(index: RunIndex): readonly RunRowView[] {
  return [...index.values()].filter(
    (snapshot: RunSnapshot) => !isTerminalRunPhase(snapshot.phase),
  );
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
 * `now` is a function rather than a clock read inside the renderer, because a
 * golden test needs the same rows twice and the row text carries a duration.
 */
export function installActiveWidget(
  host: WidgetHost,
  now: () => number,
): Effect.Effect<ActiveWidget, never, RunRepository | Scope.Scope> {
  return Effect.gen(function* () {
    const repository = yield* RunRepository;
    /**
     * The latest rows, as a plain variable.
     *
     * Not a `Ref`: this is a cache of something the repository already owns,
     * read only from the render callback, which is Pi's thread of control
     * rather than a fiber. A `Ref` would make reading it an Effect the
     * renderer had to run, which is machinery in the one place that should
     * have none.
     */
    let latest: readonly RunRowView[] = [];
    let changes = 0;
    let renderRequests = 0;

    let installed = false;
    let requestRender: (() => void) | undefined;
    /**
     * Whether a render has been asked for and not yet performed.
     *
     * This one boolean is the whole coalescing mechanism: while it is set, a
     * further change updates the reference and asks for nothing, because a
     * render that has not happened yet will read the newer value anyway.
     */
    let renderPending = false;

    const render = (theme: RenderableTheme, width: number): string[] => {
      renderPending = false;
      return [...renderRunRows(latest, theme, width, now())];
    };

    const uninstall = (): void => {
      if (!installed) return;
      installed = false;
      requestRender = undefined;
      renderPending = false;
      try {
        host.setWidget(WIDGET_KEY, undefined);
      } catch {
        // A stale Session's host throws on every method once it has been
        // replaced. The widget it can no longer clear is going with it.
      }
    };

    const install = (): void => {
      installed = true;
      host.setWidget(WIDGET_KEY, (tui, theme) => {
        requestRender = () => tui.requestRender();
        return {
          render: (width: number) => render(theme, width),
          invalidate: () => {},
        };
      });
    };

    /** Reconcile the host with what the latest index says. */
    const reconcile = (rows: readonly RunRowView[]): void => {
      if (rows.length === 0) {
        uninstall();
        return;
      }
      if (!installed) {
        install();
        return;
      }
      if (renderPending) return;
      renderPending = true;
      renderRequests += 1;
      requestRender?.();
    };

    // The uninstall is registered before the subscription starts, so a Session
    // Scope that closes mid-change still clears the widget.
    yield* Effect.addFinalizer(() => Effect.sync(uninstall));

    const changesStream = yield* repository.subscribe();
    yield* Effect.forkScoped(
      Stream.runForEach(changesStream, (index: RunIndex) =>
        Effect.sync(() => {
          changes += 1;
          latest = liveRows(index);
          reconcile(latest);
        }),
      ),
    );

    return {
      rows: () => latest,
      activity: () => ({ changes, renderRequests }),
    };
  });
}
