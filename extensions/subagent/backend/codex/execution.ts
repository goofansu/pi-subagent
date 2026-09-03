/**
 * One Run, executed as one Codex Turn on the Subagent's retained root.
 *
 * Codex is the backend where "a Run must be able to settle without the
 * backend's cooperation" stops being a slogan. Four shapes in this file exist
 * because of that, and none of them is a choice:
 *
 * - **The Turn's completion frame is the ending, and the loss signal races
 *   it.** A healthy Turn ends with `turn/completed` carrying a status. A dead
 *   one ends with nothing at all — the M0 spike killed an App Server mid-Turn
 *   and no terminal frame ever arrived — so the execution waits on whichever
 *   of the two comes first, and process exit is as good an answer as a frame.
 * - **The turn id is captured before any frame can be applied.** It is the
 *   routing key, and `turn/start` returns it before the model does any work.
 *   Frames that beat the response are buffered and flushed on the reader
 *   fiber, in order, so nothing about the opening of a Turn depends on which
 *   fiber won a race.
 * - **Confirmation requires the provider's echo.** A steer is sent with a
 *   client message id. It becomes a `user` observation only when a
 *   user-message item comes back carrying that id. A transcript showing
 *   guidance the model never saw is the one lie this seam must not tell, and
 *   the protocol's own `expectedTurnId` means the server refuses guidance for
 *   the wrong Turn before this adapter has to.
 * - **Background commands are awaited in a finalizer, not in the body.** A
 *   command execution can outlive the Turn that started it. Waiting for it in
 *   the body would be waiting with no bound at all; waiting for it in the
 *   execution scope's finalizer puts it under the runtime's cleanup budget, so
 *   a wedged terminal escalates to closing the BackendAgent — which kills the
 *   process and ends the terminal — instead of leaving a Run in `finalizing`
 *   forever. The user-visible consequence is the one the roadmap asks for: a
 *   result is unavailable while a background terminal the Run started is still
 *   running.
 *
 * What this module never does is settle its own Run. It returns a bundle; the
 * core decides.
 */

import { Deferred, Effect, Fiber, type Scope } from "effect";
import {
  answeredEnding,
  cancelledEnding,
  failedEnding,
  type MessagePart,
  runDiagnostic,
  type TerminalReconciliation,
} from "../../domain/index.ts";
import type { ExecutionIO, RunInput, TerminalBundle } from "../contract.ts";
import type { CodexProbeCounters, CodexTallyCounters } from "./probe.ts";
import {
  type CodexItem,
  type CodexNotification,
  type CodexTokenBreakdown,
  type CodexTurnStatus,
  codexEchoedText,
  readCodexTurnId,
  turnInterruptParams,
  turnStartParams,
  turnSteerParams,
} from "./protocol.ts";
import type { CodexReader, CodexRoute, CodexRouter } from "./reader.ts";
import {
  confined,
  confinedControl,
  confinedLoss,
  createCodexTranslator,
  redactCodexIdentities,
} from "./translate.ts";
import type { CodexFrame, CodexTransport } from "./transport.ts";

/** What a Run says when its BackendAgent was closed under it. */
export const CLOSED_BEFORE_EXECUTION_MESSAGE =
  "the Codex BackendAgent was closed before this Run could start";

/**
 * What a Run says when the Turn completed with no answer in it.
 *
 * Fixed rather than provider-authored, and reported only when no provider
 * error was witnessed: a Turn that said what went wrong has a better message
 * than this one.
 */
export const MISSING_CODEX_ANSWER_MESSAGE =
  "the Codex Turn completed without a final agent message";

/** What a Turn the server reported as failed says, with nothing of its text. */
export const CODEX_TURN_FAILED_CATEGORY = "the Codex Turn failed";

/** What a `turn/start` that did not produce a Turn reports. */
export const CODEX_TURN_START_CATEGORY = "the Codex Turn could not be started";

/** What a lost App Server reports. The Run's partial output stands. */
export const CODEX_TRANSPORT_LOST_CATEGORY = "the Codex App Server was lost";

/** What guidance the server refused reports. */
export const CODEX_STEER_REFUSED_CATEGORY = "Codex refused guidance";

/** What guidance that never reached the server reports. */
export const CODEX_STEER_NOT_DELIVERED_CATEGORY =
  "Codex guidance was not delivered";

/** What the child's own stderr reports, with provider identities removed. */
export const CODEX_STDERR_CATEGORY = "the Codex App Server reported";

/** What a declared method whose payload did not fit reports. */
export const CODEX_MALFORMED_FRAME_CATEGORY =
  "the Codex App Server sent a frame this adapter could not read";

/** How much of the child's stderr one diagnostic carries. */
const STDERR_DIAGNOSTIC_LIMIT = 1024;

/**
 * The retained conversation, as the execution is allowed to see it.
 *
 * One object rather than six members on the context, because these six are one
 * thing: the root thread a Subagent holds, what it has spent, whether it is
 * still there, and how a Turn's input is composed on it. The Claude adapter
 * draws the same line for the same reason.
 */
export interface CodexConversation {
  /** The retained root thread, or nothing once it is lost. */
  readonly root: () => string | undefined;
  /** Mark the conversation lost. Monotonic: nothing moves back. */
  readonly lose: () => void;
  /** Whether the BackendAgent has been closed. */
  readonly isClosed: () => boolean;
  /** This Turn's input text, with the Profile prompt composed on the first. */
  readonly turnText: (prompt: string) => string;
  /** The conversation-cumulative usage total this Turn starts from. */
  readonly usageBaseline: () => CodexTokenBreakdown | undefined;
  /** Told each newer cumulative total, so the next Run's baseline is right. */
  readonly recordCumulative: (total: CodexTokenBreakdown) => void;
}

/** What the execution is allowed to know about its BackendAgent. */
export interface CodexExecutionContext {
  readonly transport: CodexTransport;
  readonly router: CodexRouter;
  /** Completed when the reader has stopped, whichever way it stopped. */
  readonly readerStopped: CodexReader["stopped"];
  readonly probe: CodexProbeCounters;
  readonly tally: CodexTallyCounters;
  /** The Subagent's working directory, for relative paths in activity. */
  readonly cwd: string;
  readonly conversation: CodexConversation;
}

/** One steer that has been written and not yet answered by an item. */
interface LiveCorrelation {
  readonly text: string;
}

/** The user-message item a frame carries, when it carries one. */
function userMessageItem(
  notification: CodexNotification,
): Extract<CodexItem, { readonly type: "userMessage" }> | undefined {
  if (
    notification.method !== "item/started" &&
    notification.method !== "item/completed"
  ) {
    return undefined;
  }
  return notification.item.type === "userMessage"
    ? notification.item
    : undefined;
}

/** Every provider identity a frame mentions, for stderr redaction. */
function identitiesOf(notification: CodexNotification): string[] {
  const found = [notification.turnId];
  if (
    notification.method === "item/started" ||
    notification.method === "item/completed"
  ) {
    found.push(notification.item.id);
  } else if (
    notification.method === "item/agentMessage/delta" ||
    notification.method === "item/commandExecution/outputDelta" ||
    notification.method === "item/reasoning/summaryTextDelta"
  ) {
    found.push(notification.itemId);
  } else if (notification.method === "turn/completed") {
    for (const item of notification.items) found.push(item.id);
  }
  return found;
}

export function runCodexExecution(
  context: CodexExecutionContext,
  input: RunInput,
  io: ExecutionIO,
): Effect.Effect<TerminalBundle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { transport, router, probe, tally, conversation } = context;

    if (conversation.isClosed()) {
      return { ending: failedEnding(CLOSED_BEFORE_EXECUTION_MESSAGE) };
    }
    const root = conversation.root();
    if (root === undefined || transport.isLost()) {
      // The conversation is already gone. Admission normally catches this;
      // losing it between admission and here is a race, not a special case.
      conversation.lose();
      const diagnostic = confinedLoss(CODEX_TRANSPORT_LOST_CATEGORY);
      yield* io.emit({ kind: "diagnostic", diagnostic });
      return { ending: failedEnding(diagnostic.message) };
    }

    const baseline = conversation.usageBaseline();
    const translator = createCodexTranslator({
      cwd: context.cwd,
      ...(baseline === undefined ? {} : { baseline }),
      onCumulative: conversation.recordCumulative,
    });

    /* ---- Run-local state, all of it written on one fiber at a time ---- */

    let turnId: string | undefined;
    let status: CodexTurnStatus | undefined;
    let witnessedError: string | undefined;
    let accepting = true;
    let reportedStderr = false;
    let reportedMalformed = false;
    /** Frames that beat the `turn/start` response. Flushed by the reader. */
    const buffered: CodexNotification[] = [];
    /** Command executions started in this Turn and not yet completed. */
    const outstanding = new Set<string>();
    /** Identities to strip from the child's stderr before it crosses. */
    const identities = new Set<string>([root]);
    /** Steers written and not yet echoed. Kept live through cancellation. */
    const correlations = new Map<string, LiveCorrelation>();
    /** Client ids already turned into a user observation. At most one each. */
    const confirmed = new Set<string>();

    /**
     * How this Turn ended, as the *reader* saw it.
     *
     * Both endings arrive through the stream, in the stream's order: the
     * completion frame, and the transport's own loss frame. That is what makes
     * "a Run that died mid-Turn keeps its partial output" true rather than a
     * race — everything the child had already written is applied before the
     * loss is.
     */
    const settled = yield* Deferred.make<"completed" | "lost">();
    const commandsIdle = yield* Deferred.make<void>();

    /**
     * Wake the background-command wait once the Turn is over and quiet.
     *
     * Called from both sides — a completing command, and the completion frame
     * — because either can be the last of the two to happen.
     */
    const settleCommandsIfIdle = (): void => {
      if (status === undefined || outstanding.size > 0) return;
      Deferred.doneUnsafe(commandsIdle, Effect.void);
    };

    /* ---- applying one frame ---- */

    const confirmSteer = (
      item: Extract<CodexItem, { readonly type: "userMessage" }>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const clientId = item.clientId;
        if (typeof clientId !== "string") return;
        const correlation = correlations.get(clientId);
        if (correlation === undefined || confirmed.has(clientId)) return;
        confirmed.add(clientId);
        correlations.delete(clientId);
        const echoed = codexEchoedText(item).map(
          (text): MessagePart => ({ kind: "text", text }),
        );
        yield* io.emit({
          kind: "message",
          role: "user",
          // The provider's own echo when it carried one, and the admitted text
          // otherwise. Both are the same guidance; the echo is the truth about
          // what the model actually read.
          parts:
            echoed.length > 0
              ? echoed
              : [{ kind: "text", text: correlation.text }],
        });
      });

    const applyNotification = (
      notification: CodexNotification,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const identity of identitiesOf(notification)) {
          identities.add(identity);
        }

        const echo = userMessageItem(notification);
        if (echo !== undefined) {
          // A user-message item is confirmation and nothing else. Translating
          // it as well would put the same guidance in the transcript twice.
          if (typeof echo.clientId === "string") {
            identities.add(echo.clientId);
          }
          yield* confirmSteer(echo);
          return;
        }

        if (notification.method === "item/started") {
          if (notification.item.type === "commandExecution") {
            outstanding.add(notification.item.id);
          }
        } else if (notification.method === "item/completed") {
          if (notification.item.type === "commandExecution") {
            outstanding.delete(notification.item.id);
          }
        }

        const translation = translator.notification(notification);
        if (translation.errorMessage !== undefined) {
          witnessedError = translation.errorMessage;
        }
        for (const observation of translation.observations) {
          yield* io.emit(observation);
        }

        if (notification.method === "turn/completed") {
          status = notification.status;
          accepting = false;
          Deferred.doneUnsafe(settled, Effect.succeed("completed"));
        }
        settleCommandsIfIdle();
      });

    const deliver = (frame: CodexFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Buffered frames first, always, so the flush cannot reorder the Turn.
        if (turnId !== undefined && buffered.length > 0) {
          for (const pending of buffered.splice(0)) {
            if (pending.turnId !== turnId) {
              tally.count("lateFrames");
              continue;
            }
            yield* applyNotification(pending);
          }
        }
        switch (frame.kind) {
          case "wake":
            return;
          case "lost": {
            // The Turn was never named and the transport is gone, so the only
            // Run these frames could belong to is this one. Applying them is
            // the difference between a failed Run with its partial output and
            // a failed Run with nothing.
            if (turnId === undefined) {
              for (const pending of buffered.splice(0)) {
                yield* applyNotification(pending);
              }
            }
            accepting = false;
            Deferred.doneUnsafe(settled, Effect.succeed("lost"));
            return;
          }
          case "stderr": {
            if (reportedStderr) return;
            reportedStderr = true;
            yield* io.emit({
              kind: "diagnostic",
              diagnostic: runDiagnostic(
                "backend-failure",
                `${CODEX_STDERR_CATEGORY}: ${redactCodexIdentities(
                  frame.text,
                  identities,
                ).slice(0, STDERR_DIAGNOSTIC_LIMIT)}`,
              ),
            });
            return;
          }
          case "malformed": {
            if (reportedMalformed) return;
            reportedMalformed = true;
            yield* io.emit({
              kind: "diagnostic",
              diagnostic: confined(CODEX_MALFORMED_FRAME_CATEGORY),
            });
            return;
          }
          case "notification": {
            if (turnId === undefined) {
              buffered.push(frame.notification);
              return;
            }
            if (frame.notification.turnId !== turnId) {
              tally.count("lateFrames");
              return;
            }
            yield* applyNotification(frame.notification);
            return;
          }
        }
      });

    const route: CodexRoute = {
      claims: (frameTurnId) =>
        turnId === undefined ||
        frameTurnId === undefined ||
        frameTurnId === turnId,
      deliver,
    };

    /* ---- two scoped resources, and the order is the design ---- */

    // Registered first, so it is released *last*: the background-command wait
    // below still needs frames to arrive while it waits.
    yield* Effect.acquireRelease(
      Effect.sync(() => router.register(route)),
      () => Effect.sync(() => router.unregister(route)),
    );

    // Registered second, so it runs *first*. See the module comment: this is
    // the wait the runtime's cleanup budget bounds.
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.suspend(() => {
        // Only a Turn that finished on its own waits for its terminals. A
        // cancelled Run is being stopped; making it wait for a background
        // command would make cancellation as slow as the command.
        if (status !== "completed" && status !== "failed") return Effect.void;
        if (outstanding.size === 0) return Effect.void;
        return Effect.asVoid(
          Effect.raceFirst(
            Deferred.await(commandsIdle),
            Deferred.await(transport.lost),
          ),
        );
      }),
    );

    /* ---- starting the Turn ---- */

    const started = yield* transport.request(
      "turn/start",
      turnStartParams(root, conversation.turnText(input.prompt)),
      // Synchronously, on the stream callback: the server may write this
      // Turn's first notifications in the very next line, and a routing key
      // set on the fiber that resumes later would leave them unattributed.
      (result) => {
        const named = readCodexTurnId(result);
        if (named !== undefined) turnId = named;
      },
    );
    if (started.outcome !== "result") {
      if (started.outcome === "lost") conversation.lose();
      const diagnostic =
        started.outcome === "lost"
          ? confinedLoss(CODEX_TRANSPORT_LOST_CATEGORY)
          : confined(CODEX_TURN_START_CATEGORY);
      yield* io.emit({ kind: "diagnostic", diagnostic });
      return { ending: failedEnding(diagnostic.message) };
    }
    const named = readCodexTurnId(started.result);
    if (named === undefined) {
      const diagnostic = confined(CODEX_TURN_START_CATEGORY);
      yield* io.emit({ kind: "diagnostic", diagnostic });
      return { ending: failedEnding(diagnostic.message) };
    }
    identities.add(named);
    // Flush whatever beat the response, in order, on the reader fiber.
    yield* transport.wake();

    /* ---- steering: one in flight, taken serially ---- */

    const reconcile = (): TerminalReconciliation => ({
      turns: translator.turns(),
    });

    /**
     * Take one Control at a time and write it as one `turn/steer`.
     *
     * Serial by construction: the loop awaits the request, so a second
     * Control cannot be written while the first is unanswered. The Control
     * that has not been taken yet stays in ADR-0026's bounded mailbox, which
     * is where the bound is and where a caller learns there is no room —
     * draining it into an array here would move the queue somewhere with no
     * bound and no answer for the caller.
     */
    const steerLoop = Effect.gen(function* () {
      for (;;) {
        const control = yield* io.controls.take;
        if (control === undefined) return;
        if (!accepting || status !== undefined || conversation.isClosed()) {
          // The Run is settling. A Control taken now produces nothing at all:
          // admission already told the caller it was accepted, and nothing
          // else about it is true.
          continue;
        }
        const clientId = globalThis.crypto.randomUUID();
        identities.add(clientId);
        correlations.set(clientId, { text: control.text });
        // Counted with a flag rather than by pairing two calls around the
        // request: `ensuring` runs its finalizer even for an effect that was
        // interrupted before it started, and a release without its acquire
        // would drive the probe negative — which reads as a leak in the one
        // place a leak is being looked for.
        let counted = false;
        const outcome = yield* Effect.ensuring(
          Effect.suspend(() => {
            probe.acquired("inFlightSteers");
            counted = true;
            return transport.request(
              "turn/steer",
              turnSteerParams(root, named, control.text, clientId),
            );
          }),
          Effect.sync(() => {
            if (!counted) return;
            counted = false;
            probe.released("inFlightSteers");
          }),
        );
        if (outcome.outcome === "result") continue;
        // A steer the server would not take is a bounded `control`
        // diagnostic and nothing else. No user observation is fabricated, and
        // the correlation is dropped so a later echo cannot resurrect it.
        correlations.delete(clientId);
        yield* io.emit({
          kind: "diagnostic",
          diagnostic: confinedControl(
            outcome.outcome === "refused"
              ? CODEX_STEER_REFUSED_CATEGORY
              : CODEX_STEER_NOT_DELIVERED_CATEGORY,
          ),
        });
      }
    });

    /* ---- the Turn, raced against loss ---- */

    const bundle = (): TerminalBundle => {
      if (status === "interrupted") {
        // The reason is a fallback: a cancel that was admitted recorded its
        // own reason, and arbitration prefers that one.
        return {
          ending: cancelledEnding("requested"),
          reconciliation: reconcile(),
        };
      }
      if (status === "completed" && translator.sawFinalAnswer()) {
        return { ending: answeredEnding(), reconciliation: reconcile() };
      }
      if (status === "completed") {
        return {
          ending: failedEnding(witnessedError ?? MISSING_CODEX_ANSWER_MESSAGE),
          reconciliation: reconcile(),
        };
      }
      return {
        ending: failedEnding(
          witnessedError ?? confined(CODEX_TURN_FAILED_CATEGORY).message,
        ),
        reconciliation: reconcile(),
      };
    };

    /**
     * The loss signal, waited for the way it has to be waited for.
     *
     * The `Deferred` fires the instant the transport is gone; the loss *frame*
     * arrives after everything already parsed. So this waits for the signal
     * and then for the reader to reach the frame — bounded not by a clock but
     * by the reader itself, which either gets there or has stopped.
     */
    const lossReachedTheRun = Effect.gen(function* () {
      yield* Deferred.await(transport.lost);
      yield* Effect.raceFirst(
        Effect.asVoid(Deferred.await(settled)),
        Deferred.await(context.readerStopped),
      );
      return "lost" as const;
    });

    const body = Effect.gen(function* () {
      const steering = yield* Effect.forkChild(steerLoop);
      const first = yield* Effect.raceFirst(
        Deferred.await(settled),
        lossReachedTheRun,
      );
      accepting = false;
      yield* Fiber.interrupt(steering);
      if (first === "lost") {
        // Process exit, an expired request, or a frame past the framing
        // bound. None of them is on the wire, and all of them mean the same
        // thing: this Run's partial output is all there will ever be.
        conversation.lose();
        const diagnostic = confinedLoss(CODEX_TRANSPORT_LOST_CATEGORY);
        yield* io.emit({ kind: "diagnostic", diagnostic });
        return {
          ending: failedEnding(diagnostic.message),
          reconciliation: reconcile(),
        };
      }
      return bundle();
    });

    /**
     * What a cancelled Run does before its intake is sealed.
     *
     * Admission closes first, the interrupt goes out without being waited for,
     * and the signal ladder is armed in case the Turn ignores it. A final
     * answer already observed is announced, so arbitration prefers the answer
     * over the interruption — a cancel that arrived after the work finished is
     * a request against a Run that was already done.
     *
     * Nothing here sleeps. `agent_cancel` awaits the interruption of this
     * fiber, so a handler that waited for the ladder would hold the caller's
     * answer for as long as the ladder took.
     */
    const announceOnInterrupt = Effect.gen(function* () {
      accepting = false;
      // Armed *before* the interrupt is written, not after. A cooperative
      // server answers by reporting the Turn interrupted, and that frame can
      // be parsed before this fiber runs again — so an arming added
      // afterwards would find the stand-down it was waiting for had already
      // gone past, and would signal a Turn that had done as it was asked.
      yield* transport.escalate(named);
      yield* transport.send("turn/interrupt", turnInterruptParams(root, named));
      if (!translator.sawFinalAnswer()) return;
      yield* io.emit({ kind: "reconciliation", reconciliation: reconcile() });
      yield* io.emit({ kind: "ending", ending: answeredEnding() });
    });

    return yield* Effect.onInterrupt(body, () => announceOnInterrupt);
  });
}
