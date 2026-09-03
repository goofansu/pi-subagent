/**
 * The Subagent-scoped reader: one stream, many Runs, one routing decision.
 *
 * This is ADR-0023's first exception made concrete. Pi subscribes per Run and
 * Claude starts a Query per Run, so for both of them "a late event cannot
 * reach a settled Run" is true because the event source is gone. Codex has one
 * process-wide stdout stream that outlives every Run and has to stay alive
 * between them — the server issues client-bound requests that stall it if
 * nobody answers — so the rule has to be enforced by *routing* instead.
 *
 * That makes the routing table the load-bearing part of the Codex adapter, and
 * it is deliberately tiny: at most one route, because a BackendAgent runs at
 * most one Run at a time, keyed on the turn id the Run's `turn/start` returned.
 * A frame whose turn id matches goes into that Run's intake through the
 * awaitable `emit`, so backpressure reaches back through the reader to stdout.
 * A frame for any other turn id, or for a turn nobody is listening to any
 * more, reaches **no Run at all** and is counted.
 *
 * The counter is the point. A routing bug here does not crash: it either
 * applies a stale frame to a live Run or drops a live frame. So the tests
 * assert it in both directions — a current Turn's frames arrive, a settled
 * Turn's frames are counted and applied nowhere — and neither assertion is
 * meaningful without the other.
 *
 * Frames with no turn id — the child's stderr, and a declared method whose
 * payload did not fit — go to the active Run if there is one, because they are
 * thread-level facts and the active Run is the only place a diagnostic can be
 * reported. With no active Run they are counted like any other frame that
 * reached nobody.
 */

import { Deferred, Effect, Exit, Queue } from "effect";
import type { CodexTallyCounters } from "./probe.ts";
import type { CodexFrame, CodexTransport } from "./transport.ts";

/** One Run's claim on the stream, for as long as its execution scope lives. */
export interface CodexRoute {
  /**
   * Whether this route is the frame's.
   *
   * A route claims every frame until its `turn/start` has answered, because a
   * server may write a Turn's first notifications before the response that
   * names the Turn. Only one route exists at a time, so claiming broadly costs
   * nothing and losing the opening frames of a Turn would cost the transcript.
   */
  readonly claims: (turnId: string | undefined) => boolean;
  /** Apply the frame. Awaitable, so the Run's intake can push back. */
  readonly deliver: (frame: CodexFrame) => Effect.Effect<void>;
}

export interface CodexRouter {
  /** Claim the stream for one Run. The previous claim, if any, is replaced. */
  readonly register: (route: CodexRoute) => void;
  /** Give up a claim. A later frame for that Turn reaches no Run. */
  readonly unregister: (route: CodexRoute) => void;
  /** Whether a Run is currently listening. Evidence for the tests. */
  readonly active: () => boolean;
}

/** The turn a frame belongs to, or nothing when it is thread-level. */
export function codexFrameTurnId(frame: CodexFrame): string | undefined {
  return frame.kind === "notification" ? frame.notification.turnId : undefined;
}

export interface CodexReader {
  readonly router: CodexRouter;
  /** The loop. Forked into the Subagent Scope, and owned by it. */
  readonly pump: Effect.Effect<void>;
  /**
   * Completed when the loop is no longer running, however it stopped.
   *
   * An execution waiting for the reader to reach its loss frame needs a bound
   * that is not a clock, and this is it: either the reader gets there or it
   * has stopped, and there is no third outcome to wait for.
   */
  readonly stopped: Deferred.Deferred<void>;
}

export function createCodexReader(
  transport: CodexTransport,
  tally: CodexTallyCounters,
): CodexReader {
  let route: CodexRoute | undefined;
  const stopped = Deferred.makeUnsafe<void>();

  const router: CodexRouter = {
    register: (next) => {
      route = next;
    },
    unregister: (previous) => {
      if (route === previous) route = undefined;
    },
    active: () => route !== undefined,
  };

  const pump = Effect.gen(function* () {
    for (;;) {
      const next = yield* Effect.exit(Queue.take(transport.frames));
      if (Exit.isFailure(next)) return;
      const frame = next.value;
      // Resume before delivering rather than after: delivery is where the
      // waiting happens, and a stream paused for the whole of it would stall
      // a server that has more to say about the very Run being waited on.
      transport.resumeIfDrained();
      const claimed = route;
      if (claimed === undefined || !claimed.claims(codexFrameTurnId(frame))) {
        tally.count("lateFrames");
        continue;
      }
      yield* claimed.deliver(frame);
    }
  }).pipe(Effect.ensuring(Effect.asVoid(Deferred.succeed(stopped, undefined))));

  return { router, pump, stopped };
}
