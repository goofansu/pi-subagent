/**
 * The retained Codex BackendAgent: one App Server process, one ephemeral root.
 *
 * Of the three backends this is the one whose provider shape matches the
 * ownership model exactly, and the M0 spike said so: nothing in the protocol
 * ties the process or the root thread's lifetime to a Turn, so both are
 * retained entirely at the client's discretion. A Subagent Scope owning a
 * process and a thread, with each Run owning one Turn, is what the protocol
 * already assumes.
 *
 * So `open` is the one place with real provider I/O in it, and it does four
 * things in order under the caller's open budget: spawn the child, `initialize`,
 * send the `initialized` notification, and start the ephemeral root thread with
 * the never-approve, full-access posture ADR-0009 fixed. A failure at any step
 * kills the child and answers `backend unavailable` with one redacted
 * diagnostic and no Run — because an open that failed has produced no Run to
 * report through, and inventing one is what ADR-0030 exists to avoid.
 *
 * The **reader fiber is forked here**, into the Subagent Scope, and that is
 * ADR-0023's first exception. It has to outlive every Run: the server issues
 * client-bound requests between Turns and stalls if nobody answers them, so
 * there is no version of this where the stream is read per Run.
 *
 * Loss is **monotonic**, and for Codex it is real rather than theoretical.
 * Process exit, a request that outlived its bound, a frame past the framing
 * bound, and close each move the BackendAgent to lost, and nothing moves it
 * back. There is no `thread/resume` and no stored rollout — ADR-0021 chose the
 * retained ephemeral thread deliberately — so a conversation whose process has
 * died is gone, and a resumable BackendAgent that pretended otherwise would be
 * one whose next Run silently answered from an empty context.
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
import { runCodexExecution } from "./execution.ts";
import type { CodexProbeCounters, CodexTallyCounters } from "./probe.ts";
import {
  type CodexSpawn,
  codexSpawnRequest,
  spawnCodexAppServer,
} from "./process.ts";
import { codexTurnInput, resolveCodexModel } from "./profile.ts";
import {
  type CodexTokenBreakdown,
  initializeParams,
  isCodexInitializeResult,
  readCodexThreadId,
  threadStartParams,
} from "./protocol.ts";
import { createCodexReader } from "./reader.ts";
import { type CodexTransport, startCodexTransport } from "./transport.ts";

/**
 * Codex does two of the three.
 *
 * Resume is a second Turn on the retained root, and steering is `turn/steer`
 * against the active Turn. A **terminal transcript snapshot is not
 * available**: the spike found that `turn/completed` carries `id`, `items`,
 * `status`, `error`, and timestamps — and while `items` looks like a
 * transcript, it is the Turn's own items, which have already been reported one
 * by one as they happened. Reporting them again would duplicate the Run's
 * transcript rather than reconcile it, and a resumed Run's frame would carry
 * only its own Turn in any case. So the reconciliation carries turns and
 * nothing else, and the capability says so rather than the adapter inventing
 * a snapshot.
 */
export const CODEX_CAPABILITIES: BackendCapabilities = {
  resume: true,
  steer: true,
  terminalTranscriptSnapshot: false,
};

export interface CodexOpenOptions {
  /** How the App Server is started. A test injects its stand-in here. */
  readonly spawn?: CodexSpawn;
  /** The process environment a child inherits. Supplied by a test. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long one JSON-RPC request may go unanswered. */
  readonly requestBudgetMillis?: number;
  /** How long each rung of the SIGTERM/SIGKILL ladder waits. */
  readonly escalationMillis?: number;
  /** How long one framed line may be. */
  readonly maxLineLength?: number;
}

/** Where a BackendAgent is in its conversation's life. Two states only. */
type RootState =
  | { readonly state: "live"; readonly id: string }
  /** Closed, exited, or a bound expired. Nothing moves back. */
  | { readonly state: "lost" };

function createCodexBackendAgent(
  transport: CodexTransport,
  rootId: string,
  profile: Profile,
  subagent: SubagentContext,
  probe: CodexProbeCounters,
  tally: CodexTallyCounters,
  reader: ReturnType<typeof createCodexReader>,
): BackendAgent {
  let root: RootState = { state: "live", id: rootId };
  let closed = false;
  let closing: Deferred.Deferred<void> | undefined;
  let firstTurn = true;
  let cumulative: CodexTokenBreakdown | undefined;
  probe.acquired("retainedRoots");

  const loseRoot = (): void => {
    if (root.state === "lost") return;
    root = { state: "lost" };
    probe.released("retainedRoots");
  };

  const admitResume = (): ResumeAdmission =>
    closed || root.state === "lost" || transport.isLost()
      ? "conversation lost"
      : "admitted";

  const execute = (
    input: RunInput,
    io: ExecutionIO,
  ): Effect.Effect<TerminalBundle, never, Scope.Scope> =>
    runCodexExecution(
      {
        transport,
        router: reader.router,
        readerStopped: reader.stopped,
        probe,
        tally,
        cwd: subagent.cwd,
        root: () => (root.state === "live" ? root.id : undefined),
        loseRoot,
        isClosed: () => closed,
        turnText: (prompt) => {
          const text = codexTurnInput(profile, prompt, firstTurn);
          // Flipped once the text has been composed for a Turn that is about
          // to be written. The conversation is initialized once, and a later
          // Turn sends the task prompt alone — repeating the Profile's
          // instructions would read to the model as their having changed.
          firstTurn = false;
          return text;
        },
        usageBaseline: () => cumulative,
        recordCumulative: (total) => {
          cumulative = total;
        },
      },
      input,
      io,
    );

  return {
    capabilities: CODEX_CAPABILITIES,
    admitResume,
    execute,
    // Idempotent by construction: the flag and the `Deferred` are claimed in
    // one synchronous step, so two concurrent closes cannot both decide they
    // are the first — and the second waits rather than returning early, so a
    // caller that closes and then reads the probe sees a released process.
    close: () =>
      Effect.suspend(() => {
        closed = true;
        const already = closing;
        if (already !== undefined) return Deferred.await(already);
        const finished = Deferred.makeUnsafe<void>();
        closing = finished;
        tally.closed();
        loseRoot();
        return transport
          .close()
          .pipe(
            Effect.ensuring(
              Effect.asVoid(Deferred.succeed(finished, undefined)),
            ),
          );
      }),
  };
}

/**
 * Open a BackendAgent into the caller's Scope.
 *
 * The finalizer is registered **before** the child is spawned, which is what
 * makes the open budget honest: the caller races this against its budget and
 * interrupts on expiry, and a child that landed after the interruption finds
 * the open already abandoned and is closed rather than left as a process
 * nothing holds and nothing can kill.
 */
export function openCodexBackendAgent(
  profile: Profile,
  subagent: SubagentContext,
  probe: CodexProbeCounters,
  tally: CodexTallyCounters,
  options: CodexOpenOptions,
): Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const holder: { transport?: CodexTransport; agent?: BackendAgent } = {};

    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* () {
        const agent = holder.agent;
        // The agent's own close is the idempotent one. An open that never got
        // that far falls back to closing the transport directly.
        if (agent !== undefined) {
          yield* agent.close();
          return;
        }
        const transport = holder.transport;
        if (transport !== undefined) yield* transport.close();
      }),
    );

    const unavailable = Effect.fail<BackendOpenFailure>({
      diagnostic: redactedDiagnostic("backend-failure"),
    });

    const started = yield* startCodexTransport({
      spawn: options.spawn ?? spawnCodexAppServer,
      request: codexSpawnRequest(
        subagent.cwd,
        subagent.childDepth,
        options.env,
      ),
      probe,
      tally,
      ...(options.requestBudgetMillis === undefined
        ? {}
        : { requestBudgetMillis: options.requestBudgetMillis }),
      ...(options.escalationMillis === undefined
        ? {}
        : { escalationMillis: options.escalationMillis }),
      ...(options.maxLineLength === undefined
        ? {}
        : { maxLineLength: options.maxLineLength }),
    });
    if (started.outcome !== "started") return yield* unavailable;
    const transport = started.transport;
    holder.transport = transport;

    // The reader owns stdout for the BackendAgent's life, so it is forked into
    // the Subagent Scope before the first request: `initialize` is answered on
    // the same stream every Turn's frames arrive on.
    const reader = createCodexReader(transport, tally);
    yield* Effect.acquireRelease(
      Effect.map(Effect.forkScoped(reader.pump), (fiber) => {
        probe.acquired("readerFibers");
        return fiber;
      }),
      () => Effect.sync(() => probe.released("readerFibers")),
    );

    const initialized = yield* transport.request(
      "initialize",
      initializeParams(),
    );
    if (
      initialized.outcome !== "result" ||
      !isCodexInitializeResult(initialized.result)
    ) {
      return yield* unavailable;
    }
    yield* transport.notify("initialized");

    const choice = resolveCodexModel(profile);
    const thread = yield* transport.request(
      "thread/start",
      threadStartParams({
        cwd: subagent.cwd,
        ...(choice.model === undefined ? {} : { model: choice.model }),
        ...(choice.effort === undefined ? {} : { effort: choice.effort }),
      }),
    );
    if (thread.outcome !== "result") return yield* unavailable;
    const rootId = readCodexThreadId(thread.result);
    if (rootId === undefined) return yield* unavailable;

    tally.opened();
    const agent = createCodexBackendAgent(
      transport,
      rootId,
      profile,
      subagent,
      probe,
      tally,
      reader,
    );
    holder.agent = agent;
    return agent;
  });
}
