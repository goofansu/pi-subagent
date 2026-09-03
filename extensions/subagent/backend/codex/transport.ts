/**
 * The App Server transport: framing, bounded requests, and the two loss
 * signals the protocol does not provide.
 *
 * Codex is the backend ADR-0025 is really about. The M0 spike killed an App
 * Server mid-Turn and found that **nothing** arrived: no terminal Turn frame,
 * and a request issued afterwards neither resolved nor rejected. The protocol
 * has no error for "the peer is gone". So this module carries the two signals
 * that stand in for it, and neither comes from the wire:
 *
 * 1. **Process exit**, watched by the client that owns the child. It is the
 *    authoritative loss signal: pending requests are settled, the loss
 *    `Deferred` completes, and whatever races it decides the active Run.
 * 2. **A per-request bound** on the runtime clock. A wedged-but-alive process
 *    answers nothing and exits never, and without a bound it would hold a Run
 *    open forever. An expired request is transport loss and escalates.
 *
 * Three things happen **synchronously, on the stdout callback**, and the
 * reason is that none of them may ever wait:
 *
 * - **Framing.** A line longer than the bound is not truncated silently; it
 *   fails the BackendAgent as transport loss, because a frame this adapter
 *   cannot parse means the stream is no longer trustworthy.
 * - **Answering server-to-client requests.** The spike found that a request
 *   the client ignores *stalls the server*. Every one gets a JSON-RPC error,
 *   whether or not a Run is active, which is why answering cannot be behind
 *   anything that might block.
 * - **Resolving responses.** A response has a waiting fiber and settling it is
 *   a `Deferred` completion, so there is nothing to gain by deferring it — and
 *   something to lose: exit settles what is still pending, and a response
 *   sitting in a queue behind the exit would be lost to a bound it had already
 *   beaten.
 *
 * **Notifications** are the one kind that is queued, because they are the one
 * kind whose handling may legitimately wait: the reader emits them into the
 * active Run's intake with backpressure. When that queue grows, stdout is
 * paused — so a reducer that is behind slows the provider down instead of
 * being outrun. That is the ADR-0024 policy for an awaitable emit, and it is
 * why the native-bridge overflow policy does not apply to Codex.
 *
 * Everything here is confined to this directory: no other v2 module names a
 * JSON-RPC id, a thread id, a turn id, or a child process.
 */

import { type Cause, Deferred, Effect, Exit, Queue, type Scope } from "effect";
import type { CodexProbeCounters, CodexTallyCounters } from "./probe.ts";
import type {
  CodexChildProcess,
  CodexProcessExit,
  CodexSignal,
  CodexSpawn,
  CodexSpawnRequest,
} from "./process.ts";
import {
  type CodexNotification,
  type CodexParams,
  readCodexNotification,
} from "./protocol.ts";

/**
 * How long one framed line may be, in UTF-16 code units.
 *
 * v1's 32 MiB, and a code unit rather than a byte on purpose: a byte-exact
 * check would mean encoding every partial buffer on every chunk, and the bound
 * exists to stop a runaway frame from taking the heap rather than to be
 * precise. A code unit bounds bytes to within a small factor, which is all
 * this needs to do.
 */
export const CODEX_MAX_LINE_LENGTH = 32 * 1024 * 1024;

/**
 * How long a JSON-RPC request may go unanswered.
 *
 * Generous, because every request this adapter makes is answered immediately
 * by a healthy server: the spike measured `initialize` at 53 ms and found that
 * `turn/start` returns its turn id before any model work. What takes minutes
 * is the *Turn*, and a Turn is notifications rather than a pending request. So
 * this is a bound on a wedged peer, not on the provider thinking.
 */
export const CODEX_REQUEST_BUDGET_MILLIS = 30_000;

/** How long each rung of the signal ladder waits. v1's number. */
export const CODEX_ESCALATION_MILLIS = 5_000;

/** How many queued notifications pause stdout, and how few resume it. */
const PAUSE_ABOVE = 256;
const RESUME_AT_OR_BELOW = 64;

/** The JSON-RPC error every server-to-client request is answered with. */
export const CODEX_METHOD_NOT_SUPPORTED = {
  code: -32601,
  message: "Method not supported by pi-subagent",
} as const;

/** What one framed inbound line turned out to be, for the reader. */
export type CodexFrame =
  | {
      readonly kind: "notification";
      readonly notification: CodexNotification;
    }
  /** A declared method whose payload did not fit. One bounded diagnostic. */
  | { readonly kind: "malformed"; readonly method: string }
  /** What the child wrote to stderr, with provider identities still in it. */
  | { readonly kind: "stderr"; readonly text: string }
  /**
   * The transport is gone, in the stream's own order.
   *
   * Loss is also a `Deferred` an execution can race, and this frame is the
   * reason it is *both*. The `Deferred` says "the transport is gone" the
   * instant it happens; this frame says it **after every frame that was
   * already parsed**. A Run that settled on the `Deferred` alone would throw
   * away the partial output the child had already written, which is exactly
   * what a Run that died mid-Turn has to keep. Nothing follows it: the queue
   * ends behind it, so the reader drains what is left and stops.
   */
  | { readonly kind: "lost" }
  /**
   * Nothing at all, offered by an execution once its Turn has been named.
   *
   * A Run's route claims every frame until its `turn/start` answers, because
   * the server may write a Turn's opening notifications before the response
   * that names it. Those frames are buffered, and they have to be applied
   * **on the reader fiber** or two fibers would be emitting into one intake
   * and the ordering the Run is promised would be a race. So the execution
   * does not flush them itself; it offers this, and the reader flushes in
   * order on its way past. Without it, a server that went quiet the moment
   * the Turn was named would leave the opening frames buffered forever.
   */
  | { readonly kind: "wake" };

/** How one request ended. There is no fourth answer. */
export type CodexRequestOutcome =
  | { readonly outcome: "result"; readonly result: unknown }
  /** The server refused it. The error is the server's own and stays here. */
  | { readonly outcome: "refused" }
  /** The transport is gone, or the request outlived its bound. */
  | { readonly outcome: "lost" };

export interface CodexTransport {
  /** The child's operating-system id, for cleanup evidence. */
  readonly pid: () => number | undefined;
  /** Whether the transport has reached its terminal state. Monotonic. */
  readonly isLost: () => boolean;
  /** Completed once, when the transport is lost. What a Run races. */
  readonly lost: Deferred.Deferred<void>;
  /** Completed once, when the child has actually gone. */
  readonly exited: Deferred.Deferred<CodexProcessExit>;
  /** Notifications, stderr, and the loss frame, in arrival order. */
  readonly frames: Queue.Queue<CodexFrame, Cause.Done>;
  /** Called by the reader after each take, so a drained queue resumes stdout. */
  readonly resumeIfDrained: () => void;
  /**
   * Write one request and wait for its answer, within its bound.
   *
   * `onResult` is called **synchronously, on the stream callback**, before the
   * waiting fiber is resumed. Exactly one caller needs that and the reason is
   * ordering: `turn/start`'s response is what names the Turn, and the server
   * may write the Turn's first notifications in the very next line. Setting
   * the routing key on the fiber that resumes later would leave those frames
   * belonging to a Turn nobody had named yet.
   */
  readonly request: (
    method: string,
    params: CodexParams,
    onResult?: (result: unknown) => void,
  ) => Effect.Effect<CodexRequestOutcome>;
  /** Write one notification. Nothing waits for it. */
  readonly notify: (
    method: string,
    params?: CodexParams,
  ) => Effect.Effect<void>;
  /**
   * Write one request and never wait for its answer.
   *
   * `turn/interrupt` is the only user, and it is a request whose result is
   * empty. What matters about it is that it was *written*: waiting for the
   * answer would make `agent_cancel` as slow as the server's worst case, and
   * the signal ladder is already the backstop for a server that ignores it.
   * The response, when it comes, finds no pending entry and is discarded.
   */
  readonly send: (method: string, params: CodexParams) => Effect.Effect<void>;
  /** Nudge the reader, so an execution's buffered opening frames flush. */
  readonly wake: () => Effect.Effect<void>;
  /**
   * Start the SIGTERM-then-SIGKILL ladder, without waiting for it.
   *
   * Called from an interrupt handler, which must return promptly:
   * `agent_cancel` awaits the interruption of the execution fiber, so a handler
   * that slept would hold the caller's answer for as long as the ladder took.
   *
   * `turnId` is what the ladder stands down for: the arming is cancelled the
   * moment *that* Turn reports itself interrupted. Two things about it are
   * load-bearing.
   *
   * It is **per arming** rather than a flag on this transport, because a flag
   * would be set by the first cancelled Run and never cleared — quietly
   * disarming the ladder for every later Run on the same App Server, which is
   * exactly the case the ladder exists for.
   *
   * And the stand-down is noticed **here**, as the frame is parsed, rather
   * than by the Run that asked for it. By the time an interrupted Turn's
   * completion frame arrives, the Run's routing entry is usually already gone
   * — its scope closed when it settled — so a Run watching for its own
   * confirmation would miss it and signal a Turn that had cooperated.
   * Omitting the id arms a ladder that never stands down, which is what an
   * expired request and a corrupt stream both want.
   */
  readonly escalate: (turnId?: string) => Effect.Effect<void>;
  /** End stdin, await exit within a bound, then escalate. Idempotent. */
  readonly close: () => Effect.Effect<void>;
}

export interface CodexTransportOptions {
  readonly spawn: CodexSpawn;
  readonly request: CodexSpawnRequest;
  readonly probe: CodexProbeCounters;
  readonly tally: CodexTallyCounters;
  readonly requestBudgetMillis?: number;
  readonly escalationMillis?: number;
  readonly maxLineLength?: number;
}

/** Whether the spawn produced a transport, without carrying its error text. */
export type CodexTransportStart =
  | { readonly outcome: "started"; readonly transport: CodexTransport }
  /** The provider's own text stops at the spawn. `open` reports the category. */
  | { readonly outcome: "failed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One request to climb the ladder, and whether it has been called off.
 *
 * Mutable, and read by the ladder fiber rather than by whoever armed it — see
 * {@link CodexTransport.escalate} for why the stand-down cannot belong to the
 * Run that asked for the escalation.
 */
interface LadderArming {
  /** The Turn whose own interruption calls this off, if there is one. */
  readonly turnId: string | undefined;
  standDown: boolean;
}

/**
 * Build the transport into the caller's Scope, which is the Subagent's.
 *
 * The escalation ladder is forked here rather than by the caller, because it
 * is the transport's own bookkeeping and because it has to be able to run
 * after the Run that asked for it has been interrupted.
 */
export function startCodexTransport(
  options: CodexTransportOptions,
): Effect.Effect<CodexTransportStart, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { probe, tally } = options;
    const requestBudget =
      options.requestBudgetMillis ?? CODEX_REQUEST_BUDGET_MILLIS;
    const escalationMillis =
      options.escalationMillis ?? CODEX_ESCALATION_MILLIS;
    const maxLineLength = options.maxLineLength ?? CODEX_MAX_LINE_LENGTH;

    const frames = yield* Queue.unbounded<CodexFrame, Cause.Done>();
    const lost = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<CodexProcessExit>();
    /** Escalations asked for, each carrying the Turn it stands down for. */
    const ladder = yield* Queue.unbounded<LadderArming>();

    interface Pending {
      readonly waiter: Deferred.Deferred<CodexRequestOutcome>;
      readonly onResult?: (result: unknown) => void;
    }
    const pending = new Map<number, Pending>();
    let child: CodexChildProcess | undefined;
    let nextRequestId = 1;
    let terminal = false;
    let processGone = false;
    let buffer = "";
    /** Escalations armed and not yet climbed. Emptied as each is consumed. */
    const armed = new Set<LadderArming>();
    let paused = false;
    let closing: Deferred.Deferred<void> | undefined;

    /* ---- writing ---- */

    const write = (value: Record<string, unknown>): boolean => {
      if (terminal || processGone || child === undefined) return false;
      return child.write(`${JSON.stringify(value)}\n`);
    };

    /* ---- settling ---- */

    /** Release one pending entry, whoever gets there first. */
    const settleOne = (id: number, outcome: CodexRequestOutcome): void => {
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      probe.released("pendingRequests");
      if (outcome.outcome === "result") entry.onResult?.(outcome.result);
      Deferred.doneUnsafe(entry.waiter, Effect.succeed(outcome));
    };

    /** Settle everything still waiting as transport loss. */
    const settleAllPending = (): void => {
      for (const id of [...pending.keys()]) {
        settleOne(id, { outcome: "lost" });
      }
    };

    /**
     * Reach the terminal state, once.
     *
     * Monotonic by construction: the flag is set first, so a second caller
     * finds the pending map already empty and the `Deferred` already done.
     */
    const markLost = (): void => {
      if (terminal) return;
      terminal = true;
      settleAllPending();
      // The frame first, then the end of the queue, then the signal. That
      // order is what lets a Run keep the output the child had already
      // written: the reader drains to the loss frame and stops, and the
      // signal is the fallback for a reader that is no longer running.
      Queue.offerUnsafe(frames, { kind: "lost" });
      Queue.endUnsafe(frames);
      Deferred.doneUnsafe(lost, Effect.void);
    };

    /* ---- backpressure ---- */

    const offerFrame = (frame: CodexFrame): void => {
      Queue.offerUnsafe(frames, frame);
      if (paused || Queue.sizeUnsafe(frames) < PAUSE_ABOVE) return;
      paused = true;
      child?.pauseStdout();
    };

    const resumeIfDrained = (): void => {
      if (!paused || Queue.sizeUnsafe(frames) > RESUME_AT_OR_BELOW) return;
      paused = false;
      child?.resumeStdout();
    };

    /* ---- reading one line ---- */

    const answerServerRequest = (id: unknown): void => {
      // Answered whether or not a Run is active. The spike found that a
      // server-to-client request the client ignores stalls the server.
      write({ jsonrpc: "2.0", id, error: { ...CODEX_METHOD_NOT_SUPPORTED } });
    };

    const resolveResponse = (value: Record<string, unknown>): void => {
      const id = value.id;
      if (typeof id !== "number" || !Number.isInteger(id)) return;
      if ("error" in value) {
        settleOne(id, { outcome: "refused" });
        return;
      }
      if (!("result" in value)) return;
      settleOne(id, { outcome: "result", result: value.result });
    };

    const readLine = (line: string): void => {
      if (line.trim() === "") return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // Not JSON at all. The App Server does not emit such lines, and one
        // line that is not a frame is not a reason to lose the conversation.
        tally.count("malformedFrames");
        return;
      }
      if (!isRecord(value)) return;
      const method = value.method;
      if (typeof method !== "string") {
        resolveResponse(value);
        return;
      }
      if ("id" in value) {
        answerServerRequest(value.id);
        return;
      }
      const reading = readCodexNotification(method, value.params);
      if (reading.outcome === "ignored") return;
      if (reading.outcome === "malformed") {
        tally.count("malformedFrames");
        offerFrame({ kind: "malformed", method: reading.method });
        return;
      }
      const notification = reading.notification;
      if (
        notification.method === "turn/completed" &&
        notification.status === "interrupted"
      ) {
        // The Turn stopped when asked, so whatever asked it to can stand down
        // and the process, the root, and the Subagent all survive. Noticed as
        // the frame is parsed rather than where it is routed, because the Run
        // that asked has usually settled by now.
        for (const arming of armed) {
          if (arming.turnId === notification.turnId) arming.standDown = true;
        }
      }
      offerFrame({ kind: "notification", notification });
    };

    /**
     * An arming with no Turn to stand down for.
     *
     * What an expired request and a corrupt stream both want: there is no peer
     * left to cooperate, so nothing can call the escalation off.
     */
    const unconditional = (): LadderArming => ({
      turnId: undefined,
      standDown: false,
    });

    /**
     * A frame past the bound: nothing is dropped quietly.
     *
     * The stream can no longer be parsed, so the BackendAgent says so — and
     * the child is terminated rather than left running with nobody willing to
     * read it. An expired request does the same thing for the same reason;
     * process exit does not, because the child is already gone.
     */
    const loseToOversizedLine = (): void => {
      tally.count("oversizedLines");
      markLost();
      Queue.offerUnsafe(ladder, unconditional());
    };

    const readChunk = (chunk: string): void => {
      if (terminal) return;
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (buffer.length <= maxLineLength) return;
          buffer = "";
          loseToOversizedLine();
          return;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > maxLineLength) {
          loseToOversizedLine();
          return;
        }
        readLine(line);
      }
    };

    /* ---- the child ---- */

    const spawned = yield* Effect.sync((): CodexChildProcess | undefined => {
      try {
        return options.spawn(options.request);
      } catch {
        // The provider's own text stops here. See the module comment.
        return undefined;
      }
    });

    if (spawned === undefined) return { outcome: "failed" } as const;

    child = spawned;
    probe.acquired("liveProcesses");

    child.onStdout(readChunk);
    child.onStderr((text) => {
      if (text === "") return;
      offerFrame({ kind: "stderr", text });
    });
    child.onExit((exit) => {
      if (processGone) return;
      processGone = true;
      probe.released("liveProcesses");
      // A trailing line with no newline is still a frame the server wrote.
      if (buffer.length > 0 && buffer.length <= maxLineLength) {
        const trailing = buffer;
        buffer = "";
        readLine(trailing);
      }
      buffer = "";
      markLost();
      Deferred.doneUnsafe(exited, Effect.succeed(exit));
    });

    /* ---- the signal ladder ---- */

    /** Wait for the child to go, or for the rung's bound to expire. */
    const rung = (): Effect.Effect<boolean> =>
      Effect.map(
        Effect.exit(Effect.timeout(Deferred.await(exited), escalationMillis)),
        (result) => Exit.isSuccess(result),
      );

    const kill = (signal: CodexSignal): void => {
      if (processGone) return;
      child?.kill(signal);
    };

    /**
     * One pass of SIGTERM then SIGKILL, standing down if the child goes or the
     * arming has been called off.
     *
     * The stand-down check is only meaningful before SIGTERM: once the signal
     * has been sent there is nothing left to stand down from.
     *
     * Shared by the ladder fiber and by `close`, because they climb the same
     * rungs for the same reason and two copies would be two places for the
     * escalation policy to drift.
     */
    const climb = (arming: LadderArming): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (processGone) return;
        if (yield* rung()) return;
        if (arming.standDown) return;
        kill("SIGTERM");
        if (yield* rung()) return;
        kill("SIGKILL");
        // The last rung is waited for too, so a caller that closes and then
        // reads the probe sees a released process rather than a pending one.
        yield* rung();
      });

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Effect.exit(Queue.take(ladder));
          if (Exit.isFailure(next)) return;
          const arming = next.value;
          yield* Effect.ensuring(
            climb(arming),
            Effect.sync(() => armed.delete(arming)),
          );
        }
      }),
    );

    /* ---- requests ---- */

    const request = (
      method: string,
      params: CodexParams,
      onResult?: (result: unknown) => void,
    ): Effect.Effect<CodexRequestOutcome> =>
      Effect.suspend(() => {
        if (terminal || processGone) {
          return Effect.succeed({ outcome: "lost" } as const);
        }
        const id = nextRequestId;
        nextRequestId += 1;
        const waiter = Deferred.makeUnsafe<CodexRequestOutcome>();
        pending.set(id, {
          waiter,
          ...(onResult === undefined ? {} : { onResult }),
        });
        probe.acquired("pendingRequests");
        if (!write({ jsonrpc: "2.0", id, method, params })) {
          settleOne(id, { outcome: "lost" });
          markLost();
          return Effect.succeed({ outcome: "lost" } as const);
        }
        return Effect.gen(function* () {
          const answered = yield* Effect.exit(
            Effect.timeout(Deferred.await(waiter), requestBudget),
          );
          if (Exit.isSuccess(answered)) return answered.value;
          // The bound expired. This is the second loss signal, and the one a
          // wedged-but-alive process produces: nothing on the wire will ever
          // say so, so the adapter says it and terminates the child.
          settleOne(id, { outcome: "lost" });
          markLost();
          Queue.offerUnsafe(ladder, unconditional());
          return { outcome: "lost" } as const;
        }).pipe(
          // An interrupted request must not leave its entry behind, or the
          // probe would report a pending request nothing is waiting for.
          Effect.ensuring(
            Effect.sync(() => settleOne(id, { outcome: "lost" })),
          ),
        );
      });

    const notify = (
      method: string,
      params?: CodexParams,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        write(params === undefined ? { method } : { method, params });
      });

    /* ---- close ---- */

    const close = (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const already = closing;
        if (already !== undefined) return Deferred.await(already);
        const finished = Deferred.makeUnsafe<void>();
        closing = finished;
        return Effect.gen(function* () {
          markLost();
          if (processGone) return;
          // Ending stdin is the graceful path: the spike measured a 13 ms
          // exit with code 0. The ladder is the backstop for a child that
          // does not take the hint, and there is nothing to stand down for.
          child?.endStdin();
          yield* climb(unconditional());
        }).pipe(
          Effect.ensuring(Effect.asVoid(Deferred.succeed(finished, undefined))),
        );
      });

    const transport: CodexTransport = {
      pid: () => child?.pid,
      isLost: () => terminal,
      lost,
      exited,
      frames,
      resumeIfDrained,
      request,
      notify,
      send: (method, params) =>
        Effect.sync(() => {
          const id = nextRequestId;
          nextRequestId += 1;
          write({ jsonrpc: "2.0", id, method, params });
        }),
      wake: () =>
        Effect.sync(() => void Queue.offerUnsafe(frames, { kind: "wake" })),
      escalate: (turnId) =>
        Effect.sync(() => {
          const arming: LadderArming = { turnId, standDown: false };
          armed.add(arming);
          Queue.offerUnsafe(ladder, arming);
        }),
      close,
    };

    return { outcome: "started", transport } as const;
  });
}
