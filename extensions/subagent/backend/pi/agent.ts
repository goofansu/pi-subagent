/**
 * The retained Pi BackendAgent: one native session, for one Subagent's life.
 *
 * Two decisions shape this file, and both are deliberate departures from v1.
 *
 * **The session is constructed eagerly, at `open`.** v1 built it lazily on the
 * first Run, so a Profile pinning a model the Session could not reach produced
 * a *failed Run* and a completion Notification for work that never happened.
 * ADR-0030 gave `open` a typed failure channel exactly so that case can be a
 * rejection instead: `backend unavailable`, no Run, no Notification. Opening
 * is cheap and provider-free — the M0 spike measured it at two or three
 * milliseconds — so nothing is paid for the difference.
 *
 * **Closure is enforced by this adapter's own flag.** The spike found that a
 * disposed Pi session still accepts `prompt()` without throwing. The SDK does
 * not defend itself, so a closed BackendAgent that trusted it would happily
 * start work on a session that no longer exists. The flag is checked before
 * every execution and before every native call, and the test that proves it is
 * named so it cannot be mistaken for a redundant one.
 *
 * What is deliberately *not* here is v1's pending-cleanup bookkeeping. v1
 * tracked a native cleanup that outlived its bound because v1 had no bounded
 * escalation to fall back on. M2 does: a finalizer that overruns the cleanup
 * budget causes the core to close this BackendAgent and mark the conversation
 * lost, which is the monotonic outcome ADR-0021 asks for and needs no state
 * here at all.
 */

import { Deferred, Effect, type Scope } from "effect";
import {
  type Profile,
  redactedDiagnostic,
  type SubagentContext,
} from "../../domain/index.ts";
import type {
  BackendAgent,
  BackendCapabilities,
  BackendOpenFailure,
  ExecutionIO,
  ResumeAdmission,
  RunInput,
  TerminalBundle,
} from "../contract.ts";
import { runPiExecution } from "./execution.ts";
import { createPiSessionOptions } from "./options.ts";
import type { PiProbeCounters } from "./probe.ts";
import { resolvePiModel } from "./profile.ts";
import type {
  PiSession,
  PiSessionFactory,
  PiSessionOptionsFactory,
} from "./session.ts";

/**
 * Pi does all three.
 *
 * A retained session takes another prompt, native steering is a method on it,
 * and its terminal event carries the whole message list — so no conformance
 * scenario is skipped for Pi, which is what makes the suite's pass meaningful.
 */
export const PI_CAPABILITIES: BackendCapabilities = {
  resume: true,
  steer: true,
  terminalTranscriptSnapshot: true,
};

/** How long a child's extensions have to hear about the shutdown. */
export const CHILD_SHUTDOWN_BUDGET_MILLIS = 1_000;

export interface PiOpenOptions {
  /** How a native session is made. A test injects its stand-in here. */
  readonly sessionFactory?: PiSessionFactory;
  /** How the options are built, so a test need not touch the filesystem. */
  readonly sessionOptionsFactory?: PiSessionOptionsFactory;
  readonly agentDir?: string;
}

/**
 * Tell a child's extensions the session is over, then release the handle.
 *
 * The emit is bounded because a child's extension can hang in its own
 * shutdown, and the one thing a parent must not do is hang with it. The bound
 * is `Effect.timeout` against the runtime clock rather than a timer, so a test
 * can advance it; a timer is the one kind of waiting no clock can replace, and
 * the v2 lane forbids it outright. Disposal happens either way: the extensions
 * were given their chance.
 */
function disposeSession(
  session: PiSession,
  probe: PiProbeCounters,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    probe.acquired("pendingCleanups");
    yield* Effect.exit(
      Effect.timeout(
        Effect.promise(() => emitChildShutdown(session)),
        CHILD_SHUTDOWN_BUDGET_MILLIS,
      ),
    );
    releaseSession(session, probe);
  });
}

/**
 * Tell a child's extensions the session is over. Never rejects.
 *
 * One expression rather than two, because the two disposal paths differ only
 * in what they do with the promise: an ordinary close bounds it and waits, and
 * a failed open fires it and does not.
 */
function emitChildShutdown(session: PiSession): Promise<void> {
  return Promise.resolve()
    .then(() =>
      session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      }),
    )
    .then(
      () => undefined,
      () => undefined,
    );
}

/**
 * Release a session without waiting for its child to acknowledge anything.
 *
 * The two callers are the failed and the abandoned open, where there is no
 * Run to protect and no caller left to report to. The shutdown event is still
 * sent, because a child that bound its extensions should hear that the session
 * is over — but it is not waited for, so a child that hangs cannot hold up a
 * rejection the caller is already owed.
 */
function releaseSession(session: PiSession, probe: PiProbeCounters): void {
  try {
    session.dispose();
  } catch {
    // Cleanup cannot alter an already-settled Run.
  }
  probe.released("pendingCleanups");
  probe.released("openSessions");
}

function discardSession(session: PiSession, probe: PiProbeCounters): void {
  probe.acquired("pendingCleanups");
  void emitChildShutdown(session);
  releaseSession(session, probe);
}

function createPiBackendAgent(
  session: PiSession,
  probe: PiProbeCounters,
): BackendAgent {
  let closed = false;
  let closing: Deferred.Deferred<void> | undefined;

  const admitResume = (): ResumeAdmission =>
    closed ? "conversation lost" : "admitted";

  const execute = (
    input: RunInput,
    io: ExecutionIO,
  ): Effect.Effect<TerminalBundle, never, Scope.Scope> =>
    runPiExecution({ session, isClosed: () => closed, probe }, input, io);

  return {
    capabilities: PI_CAPABILITIES,
    admitResume,
    execute,
    close: () =>
      // `Effect.suspend` so the check and the claim happen in one synchronous
      // step: two concurrent closes must not both decide they are the first,
      // or a child would hear about the shutdown twice and the session would
      // be disposed twice. The second close waits on the first rather than
      // returning early, so a caller that closes and then reads the probe
      // sees a released handle.
      Effect.suspend(() => {
        closed = true;
        if (closing !== undefined) return Deferred.await(closing);
        const finished = Deferred.makeUnsafe<void>();
        closing = finished;
        return disposeSession(session, probe).pipe(
          Effect.ensuring(Effect.asVoid(Deferred.succeed(finished, undefined))),
        );
      }),
  };
}

/** What building a session produced, so a failure carries no provider text. */
type Construction =
  | { readonly outcome: "built"; readonly session: PiSession }
  | { readonly outcome: "failed" }
  | { readonly outcome: "abandoned" };

/**
 * Open a BackendAgent into the caller's Scope.
 *
 * Everything that can go wrong here produces the same public answer — one
 * redacted `backend-failure` diagnostic — because a failed open is usually the
 * provider's own error string, and that string is the one thing about a failed
 * open guaranteed to be free-form and untrustworthy.
 *
 * The finalizer is registered **before** the session is built, which is what
 * makes the open budget honest. The caller races this against its budget and
 * interrupts on expiry; a session that lands after the interruption finds the
 * finalizer has already marked the open abandoned, and disposes itself rather
 * than becoming a handle nothing holds and nothing can close.
 */
export function openPiBackendAgent(
  profile: Profile,
  subagent: SubagentContext,
  probe: PiProbeCounters,
  options: PiOpenOptions,
  defaultSessionFactory: PiSessionFactory,
): Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const holder: {
      abandoned: boolean;
      disposed: boolean;
      session?: PiSession;
      agent?: BackendAgent;
    } = { abandoned: false, disposed: false };

    /** Release the session exactly once, whichever side gets there first. */
    const discard = (): void => {
      const session = holder.session;
      if (session === undefined || holder.disposed) return;
      holder.disposed = true;
      discardSession(session, probe);
    };

    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* () {
        holder.abandoned = true;
        const agent = holder.agent;
        // The agent's own close is the idempotent one, and it is what emits
        // the child's shutdown event. Only an open that never got that far
        // falls back to discarding the session directly.
        if (agent !== undefined) {
          yield* agent.close();
          return;
        }
        discard();
      }),
    );

    const sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    const choice = resolvePiModel(profile, subagent);
    const optionsFactory: PiSessionOptionsFactory =
      options.sessionOptionsFactory ??
      (() =>
        createPiSessionOptions({
          profile,
          subagent,
          ...(choice.model === undefined ? {} : { model: choice.model }),
          ...(choice.thinking === undefined
            ? {}
            : { thinking: choice.thinking }),
          ...(options.agentDir === undefined
            ? {}
            : { agentDir: options.agentDir }),
        }));

    const built = yield* Effect.promise<Construction>(async () => {
      try {
        const sessionOptions = await optionsFactory();
        const session = (await sessionFactory(sessionOptions)).session;
        probe.acquired("openSessions");
        holder.session = session;
        // The budget may have expired while the factory was running. The
        // session that landed anyway is disposed here rather than left as a
        // handle nothing holds and nothing can close.
        if (holder.abandoned) {
          discard();
          return { outcome: "abandoned" };
        }
        await session.bindExtensions({ mode: "print" });
        if (holder.abandoned) {
          discard();
          return { outcome: "abandoned" };
        }
        return { outcome: "built", session };
      } catch {
        // The provider's own text stops here. See the module comment.
        discard();
        return { outcome: "failed" };
      }
    });

    if (built.outcome !== "built") {
      return yield* Effect.fail<BackendOpenFailure>({
        diagnostic: redactedDiagnostic("backend-failure"),
      });
    }

    const agent = createPiBackendAgent(built.session, probe);
    holder.agent = agent;
    return agent;
  });
}
