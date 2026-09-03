/**
 * The retained Claude BackendAgent: one conversation identity, one Subagent.
 *
 * This is the file ADR-0023's first exception is about. Every other backend
 * has something to *construct* when its Subagent opens — a session, a process
 * — and Claude has nothing: the SDK's only entry point is `query()`, and
 * calling it starts an execution. A conversation identity first exists on the
 * init or result frame of the first Run.
 *
 * So opening is a purely local act. It loads the SDK's query function under
 * the open budget, and returns a BackendAgent holding **no identity at all**.
 * The identity arrives as a side effect of the first Run, and until it does
 * `admitResume` answers `conversation lost` — which is why the contract has
 * exactly three resume answers and not a fourth. "Never opened in the provider
 * sense" and "the conversation is gone" are the same fact to a caller: there is
 * nothing to resume, and asking would cost provider quota to learn it.
 *
 * Loss is **monotonic**. Close, a failed attachment, and an identity mismatch
 * each move the BackendAgent to lost, and nothing moves it back. A resumable
 * BackendAgent that could recover would be one whose next Run silently started
 * a fresh conversation, and a Run answering from an empty context is worse than
 * a Run that says it could not attach.
 *
 * What is deliberately *not* here is a session close call, because the SDK has
 * none. Closing a Claude BackendAgent means aborting whatever Query is live and
 * dropping the identity string — both local acts, and the spike confirmed that
 * a cancelled Query does not destroy the conversation it was attached to.
 */

import { Effect, type Scope } from "effect";
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
import { type ClaudeConversation, runClaudeExecution } from "./execution.ts";
import { createClaudeOptions } from "./options.ts";
import type { ClaudeProbeCounters } from "./probe.ts";
import { resolveClaudeModel } from "./profile.ts";
import {
  type ClaudeQuery,
  type ClaudeQueryLoader,
  loadClaudeQuery,
} from "./query.ts";

/**
 * Claude does two of the three.
 *
 * Resume is a single opaque identity string, and steering is a message pushed
 * into the Run's own input stream. A **terminal transcript snapshot is not
 * available**: the frames *were* the transcript, they have already been
 * reported, and there is no authoritative message list to read at the end of a
 * Query. Declaring `false` is what makes the shared suite skip its
 * transcript-healing scenarios visibly rather than have the adapter invent a
 * snapshot to pass them with.
 */
export const CLAUDE_CAPABILITIES: BackendCapabilities = {
  resume: true,
  steer: true,
  terminalTranscriptSnapshot: false,
};

export interface ClaudeOpenOptions {
  /** How the SDK's query function is obtained. A test injects its stand-in. */
  readonly loadQuery?: ClaudeQueryLoader;
  /** The process environment a child inherits. Supplied by a test. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Where a BackendAgent is in its conversation's life. */
type IdentityState =
  /** No Run has produced an identity yet. Nothing to resume. */
  | { readonly state: "unopened" }
  /** An identity is retained and a later Run may attach to it. */
  | { readonly state: "opened"; readonly identity: string }
  /** Closed, or an attachment failed. Nothing moves back. */
  | { readonly state: "lost" };

export function createClaudeBackendAgent(
  query: ClaudeQuery,
  profile: Profile,
  subagent: SubagentContext,
  probe: ClaudeProbeCounters,
  options: ClaudeOpenOptions,
): BackendAgent {
  const choice = resolveClaudeModel(profile);
  let identity: IdentityState = { state: "unopened" };
  let closed = false;
  const closeListeners = new Set<() => void>();

  const conversation: ClaudeConversation = {
    retained: () =>
      identity.state === "opened" ? identity.identity : undefined,
    retain: (acquired) => {
      // First writer wins for the Subagent's life: every later frame of every
      // later Run is checked against it rather than allowed to replace it.
      if (identity.state !== "unopened") return;
      identity = { state: "opened", identity: acquired };
      probe.acquired("retainedIdentities");
    },
    lose: () => {
      if (identity.state === "opened") probe.released("retainedIdentities");
      identity = { state: "lost" };
    },
    isClosed: () => closed,
    onClose: (listener) => {
      if (closed) {
        listener();
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };

  const admitResume = (): ResumeAdmission =>
    identity.state === "opened" ? "admitted" : "conversation lost";

  const execute = (
    input: RunInput,
    io: ExecutionIO,
  ): Effect.Effect<TerminalBundle, never, Scope.Scope> =>
    runClaudeExecution(
      {
        query,
        conversation,
        probe,
        buildOptions: (run) =>
          createClaudeOptions({
            profile,
            subagent,
            ...(choice.model === undefined ? {} : { model: choice.model }),
            ...(choice.effort === undefined ? {} : { effort: choice.effort }),
            ...(options.env === undefined ? {} : { env: options.env }),
            abort: run.abort,
            ...(run.resume === undefined ? {} : { resume: run.resume }),
            stderr: run.stderr,
          }),
      },
      input,
      io,
    );

  return {
    capabilities: CLAUDE_CAPABILITIES,
    admitResume,
    execute,
    // Idempotent by construction: the flag is set first, so a second close
    // finds every listener already run and the identity already dropped. There
    // is no SDK call to make twice, because the SDK has none to make.
    close: () =>
      Effect.sync(() => {
        if (closed) return;
        closed = true;
        for (const listener of [...closeListeners]) {
          closeListeners.delete(listener);
          try {
            listener();
          } catch {
            // Cleanup cannot alter an already-settled Run.
          }
        }
        conversation.lose();
      }),
  };
}

/**
 * Open a BackendAgent into the caller's Scope.
 *
 * The only thing that can go wrong is the SDK not loading, and it produces the
 * same public answer as every other open failure: one redacted
 * `backend-failure` diagnostic, which the caller turns into `backend
 * unavailable`. Nothing provider-authored crosses, because a failed dynamic
 * import's message is the one thing about a failed open guaranteed to be
 * free-form.
 *
 * The finalizer is registered **before** the SDK is loaded, which is what
 * makes the open budget honest: the caller races this against its budget and
 * interrupts on expiry, and a loader that lands after the interruption finds
 * the open already abandoned. There is nothing to release in that case — a
 * loaded module is not a resource — so the finalizer's only job is the
 * BackendAgent's own close.
 */
export function openClaudeBackendAgent(
  profile: Profile,
  subagent: SubagentContext,
  probe: ClaudeProbeCounters,
  options: ClaudeOpenOptions,
): Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const holder: { agent?: BackendAgent } = {};

    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* () {
        const agent = holder.agent;
        if (agent !== undefined) yield* agent.close();
      }),
    );

    const loader = options.loadQuery ?? loadClaudeQuery;
    const loaded = yield* Effect.promise(
      async (): Promise<
        | { readonly outcome: "loaded"; readonly query: ClaudeQuery }
        | { readonly outcome: "failed" }
      > => {
        try {
          return { outcome: "loaded", query: await loader() };
        } catch {
          // The provider's own text stops here. See the function comment.
          return { outcome: "failed" };
        }
      },
    );

    if (loaded.outcome !== "loaded") {
      return yield* Effect.fail<BackendOpenFailure>({
        diagnostic: redactedDiagnostic("backend-failure"),
      });
    }

    const agent = createClaudeBackendAgent(
      loaded.query,
      profile,
      subagent,
      probe,
      options,
    );
    holder.agent = agent;
    return agent;
  });
}
