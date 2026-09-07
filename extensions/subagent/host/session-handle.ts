/**
 * The one process-level handle on the current Session's runtime.
 *
 * Pi registers an extension's tools, commands, and renderers **once per
 * process**, and then hands out a fresh Session — with a fresh working
 * directory, a fresh model registry, and a fresh UI context — on every
 * `session_start`. The two lifetimes do not line up, and this is where they
 * are reconciled: the registrations close over this handle, and each Session
 * refills it.
 *
 * So there is exactly one mutable variable in the v2 host, it holds at most
 * one managed runtime, and everything else the host does goes through it.
 * That is deliberate. v1 grew a session-lifecycle module holding five stable
 * references that each Session refilled separately, and the failure mode was
 * that they could disagree about which Session was current.
 *
 * Two rules the handle enforces rather than trusts:
 *
 * - **Binding disposes what was bound.** A Session switch cannot leave two
 *   runtimes alive, whatever order the host events arrive in, because the only
 *   way to install a runtime also removes the previous one.
 * - **Running without a runtime is an answer, not a throw.** A tool call can
 *   arrive between Sessions; the handler exists because registration is
 *   per-process, so it has to have something to say.
 */

import { Cause, type Effect, Exit, type ManagedRuntime } from "effect";
import type { SessionServices } from "../runtime/composition.ts";

/** The managed runtime one Session owns, with its host-side installs. */
export interface SessionBinding {
  readonly runtime: ManagedRuntime.ManagedRuntime<SessionServices, never>;
  /**
   * Undo the host-side installs this Session made.
   *
   * The widget and the push sink live in Pi's UI and message surfaces rather
   * than in the Session Scope, so closing the Scope cannot remove them. This
   * runs before disposal, so nothing is still pointing at a runtime that is
   * about to go.
   */
  readonly detach: () => void;
}

/** A Session-bound reader, invalidated before that Session starts disposal. */
export interface SessionObservation {
  readonly run: SessionHandle["run"];
  /** Release the Session callback on ordinary UI closure. */
  readonly dispose: () => void;
}

export interface SessionHandle {
  /** Lease a UI reader to this binding, never to a later Session. */
  readonly observe: (onRelease: () => void) => SessionObservation | undefined;
  /**
   * Install a Session's runtime, disposing whatever was installed before.
   *
   * Awaited, so a caller that binds twice cannot overlap two runtimes even if
   * the first disposal is slow.
   */
  readonly bind: (binding: SessionBinding) => Promise<void>;
  /** Detach the host-side installs and dispose the runtime. Idempotent. */
  readonly release: () => Promise<void>;
  /** Whether a Session runtime is currently live. */
  readonly isLive: () => boolean;
  /**
   * Run one Effect against the live runtime.
   *
   * `whenNotReady` is the value to answer with when there is no runtime. It is
   * a value rather than a thrown error because every caller is a Pi callback,
   * and a Pi callback that throws is a crash in the user's turn.
   */
  readonly run: <A>(
    work: Effect.Effect<A, never, SessionServices>,
    whenNotReady: A,
  ) => Promise<A>;
}

export function createSessionHandle(): SessionHandle {
  let live:
    | (SessionBinding & { readonly observers: Set<() => void> })
    | undefined;

  const release = async (): Promise<void> => {
    const going = live;
    live = undefined;
    if (!going) return;
    // UI leases close before runtime disposal can clear history or await cleanup.
    for (const close of [...going.observers]) close();
    going.observers.clear();
    try {
      going.detach();
    } catch {
      // A stale Session's UI context throws on every method once it has been
      // replaced. What it can no longer detach is being discarded with it.
    }
    // Disposing closes the Session Scope, which is the M2 shutdown: every
    // Subagent is closed, every active Run cancelled and awaited, and every
    // retained BackendAgent released, in reverse acquisition order.
    await going.runtime.dispose();
  };

  return {
    observe: (onRelease) => {
      let bound = live;
      if (!bound) return undefined;
      let releaseUi: (() => void) | undefined = onRelease;
      const reads = new Set<AbortController>();
      const dispose = () => {
        for (const read of reads) read.abort();
        reads.clear();
        bound?.observers.delete(close);
        bound = undefined;
        releaseUi = undefined;
      };
      const close = () => {
        const callback = releaseUi;
        dispose();
        try {
          callback?.();
        } catch {
          /* A replaced host may already be gone. */
        }
      };
      bound.observers.add(close);
      return {
        dispose,
        run: async (work, whenNotReady) => {
          const current = bound;
          if (!current || live !== current) return whenNotReady;
          const controller = new AbortController();
          reads.add(controller);
          try {
            const exit = await current.runtime.runPromiseExit(work, {
              signal: controller.signal,
            });
            if (bound !== current || live !== current) return whenNotReady;
            if (Exit.isSuccess(exit)) return exit.value;
            if (Cause.hasInterruptsOnly(exit.cause)) return whenNotReady;
            throw Cause.squash(exit.cause);
          } finally {
            reads.delete(controller);
          }
        },
      };
    },
    bind: async (binding) => {
      await release();
      live = { ...binding, observers: new Set() };
    },
    release,
    isLive: () => live !== undefined,
    run: async (work, whenNotReady) => {
      const current = live;
      if (!current) return whenNotReady;
      const exit = await current.runtime.runPromiseExit(work);
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) return whenNotReady;
      throw Cause.squash(exit.cause);
    },
  };
}
