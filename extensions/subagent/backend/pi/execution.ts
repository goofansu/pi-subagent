/**
 * One Run, executed against a retained Pi session.
 *
 * This is where the adapter earns its keep, and the shape is deliberately the
 * one the contract asks for rather than the one v1 grew:
 *
 * - **The event subscription is a scoped resource.** It is acquired inside the
 *   nested execution scope and released by that scope's finalizer, so a late
 *   event cannot reach a settled Run — the listener is gone before settlement
 *   commits.
 * - **The baseline is taken before the prompt.** A retained session's message
 *   list carries every previous Run, and a terminal snapshot that did not
 *   subtract it would charge a resumed Run for the whole conversation.
 * - **Cancellation is interruption.** No signal is polled, no cancel object is
 *   handed around. What interruption does is stop the drain loop and run the
 *   native cleanup — as a **scope finalizer**, so the runtime's cleanup budget
 *   bounds it and an overrun escalates through M2's path rather than through
 *   Pi-specific pending state. v1 needed that bookkeeping because it had no
 *   bounded escalation; this does not.
 * - **A terminal snapshot observed before interruption still answers.** The
 *   interrupt handler emits the snapshot and the ending it implies, so
 *   arbitration sees an announced ending and the Run reports the answer it
 *   actually got. A cancel that arrives after the work finished is a request
 *   against a Run that was already done.
 *
 * The one thing this module never does is settle its own Run. It returns a
 * bundle; the core decides.
 */

import { Effect, Fiber, type Scope } from "effect";
import {
  answeredEnding,
  failedEnding,
  type TerminalReconciliation,
} from "../../domain/index.ts";
import type { ExecutionIO, RunInput, TerminalBundle } from "../contract.ts";
import { type CallbackBridge, createCallbackBridge } from "./bridge.ts";
import type { PiProbeCounters } from "./probe.ts";
import type { PiSession, PiSessionEvent } from "./session.ts";
import {
  confined,
  confinedControl,
  createPiEventTranslator,
  currentRunMessages,
  isPiUserText,
  piMessageObservations,
  piTerminalSnapshot,
  withoutInitialGoal,
} from "./translate.ts";

/** What a Run says when it ended with no terminal event to read. */
export const MISSING_TERMINAL_EVENT_MESSAGE =
  "the Pi session finished without a terminal event carrying its messages";

/** What an execution says when the BackendAgent was closed under it. */
export const CLOSED_BEFORE_EXECUTION_MESSAGE =
  "the Pi BackendAgent was closed before this Run could start";

/** What a rejected prompt says, with the provider's own text left behind. */
export const PROMPT_REJECTED_CATEGORY = "Pi prompt failed";

/** What a rejected native steer says. */
export const STEER_REJECTED_CATEGORY = "Pi steering was not delivered";

/** What a steer the session never took says, once the Run is otherwise done. */
export const STEER_ABANDONED_MESSAGE =
  "the Pi session finished without taking guidance that was still being delivered";

export interface PiExecutionContext {
  readonly session: PiSession;
  /** The adapter's own closed flag. The SDK does not defend a disposed session. */
  readonly isClosed: () => boolean;
  readonly probe: PiProbeCounters;
}

/** Run one prompt on the retained session and report everything it produced. */
export function runPiExecution(
  context: PiExecutionContext,
  input: RunInput,
  io: ExecutionIO,
): Effect.Effect<TerminalBundle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { session, probe } = context;
    if (context.isClosed()) {
      return { ending: failedEnding(CLOSED_BEFORE_EXECUTION_MESSAGE) };
    }

    const bridge = createCallbackBridge();
    const translator = createPiEventTranslator();
    // Everything the listener writes and the drain loop reads. Plain mutable
    // state, because a callback cannot yield and a `Ref` it could not write.
    let terminal: TerminalReconciliation | undefined;
    let goalOmitted = false;
    let completed = false;
    const baseline = [...session.messages];
    // Reference identity, not content: two consumed Controls can carry the
    // same text, and equal content is not the same event.
    const seen = new WeakSet<object>();

    const listen = (event: PiSessionEvent): void => {
      if (!bridge.accepting()) return;
      const read = translator.event(event);
      switch (read.kind) {
        case "message": {
          // Two Run-state decisions the translator cannot make for us: Pi
          // echoes the brief back as the Run's first user message, and the
          // same message object can arrive twice. Identity, not content —
          // two consumed Controls can carry the same text.
          const { message } = read;
          if (!goalOmitted && isPiUserText(message, input.prompt)) {
            goalOmitted = true;
            return;
          }
          if (typeof message === "object" && message !== null) {
            if (seen.has(message)) return;
            seen.add(message);
          }
          for (const observation of piMessageObservations(message)) {
            bridge.push(observation);
          }
          return;
        }
        case "activity": {
          bridge.push(read.observation);
          return;
        }
        case "tool": {
          for (const observation of read.observations) bridge.push(observation);
          return;
        }
        case "terminal": {
          terminal = piTerminalSnapshot(
            withoutInitialGoal(
              currentRunMessages(read.messages, baseline),
              input.prompt,
            ),
          );
          return;
        }
        case "other":
          return;
      }
    };

    /** Hand every buffered observation to the intake, with backpressure. */
    const drain = Effect.gen(function* () {
      for (;;) {
        const next = bridge.take();
        if (next === undefined) return;
        yield* io.emit(next);
      }
    });

    // Two finalizers, and their order is the design. Scope finalizers run in
    // reverse, so the subscription is registered *first* and released *last*:
    // the session is still being listened to while it is aborted, so whatever
    // it says on the way down is offered rather than silently discarded. By
    // then the Run has captured its ending and sealed its intake, so the
    // intake counts those as late events — which is the honest record, and
    // exactly what the counter is for.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        probe.acquired("liveSubscriptions");
        return session.subscribe(listen);
      }),
      (unsubscribe) =>
        Effect.sync(() => {
          bridge.stop();
          try {
            unsubscribe();
          } catch {
            // A session disposed under us has nothing left to unsubscribe.
          }
          probe.released("liveSubscriptions");
        }),
    );
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* () {
        if (completed) return;
        yield* Effect.promise(async () => {
          probe.acquired("pendingCleanups");
          try {
            await stopNativeWork(session);
          } finally {
            probe.released("pendingCleanups");
          }
        });
        yield* drain;
      }),
    );

    /** What a cancelled Run still has to say before its intake is sealed. */
    const announceOnInterrupt = Effect.gen(function* () {
      yield* drain;
      const snapshot = terminal;
      if (snapshot === undefined) return;
      // The work finished before the cancel reached it. Announcing the
      // snapshot and its ending is what makes arbitration prefer the answer.
      yield* io.emit({ kind: "reconciliation", reconciliation: snapshot });
      yield* io.emit({ kind: "ending", ending: answeredEnding() });
    });

    // Deliveries begun and not yet finished. The drain loop will not call a
    // Run finished while one is outstanding: a Control that was admitted and
    // is being delivered belongs to this Run, and a Run that returned while
    // it was in flight would settle before its own guidance was reported.
    //
    // What it must *not* do is wait forever. v1 did, and got away with it
    // because a stalled steer was tracked as pending state; ADR-0025 is
    // explicit that waiting indefinitely is not a settlement policy. So the
    // wait has a bound of its own, below: the session going idle with the
    // prompt already settled.
    let deliveries = 0;

    const steerLoop = Effect.gen(function* () {
      for (;;) {
        const control = yield* io.controls.take;
        if (control === undefined) return;
        if (context.isClosed()) return;
        deliveries += 1;
        yield* deliverSteer(session, control.text, io).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliveries -= 1;
              bridge.signal();
            }),
          ),
        );
      }
    });

    const body = Effect.gen(function* () {
      const steering = yield* Effect.forkChild(steerLoop);
      const native = startNativePrompt(session, input.prompt, bridge);
      for (;;) {
        const seenVersion = bridge.version();
        yield* drain;
        if (native.settled() && bridge.size() === 0) {
          if (deliveries === 0) break;
          // The prompt has settled and the session is quiet, so a delivery
          // still in flight is one the session is never going to take. Say so
          // and stop waiting: a Run that waited on it would not settle at
          // all, and admission already told the caller the Control was
          // accepted — only the delivery failed.
          if (session.isIdle) {
            yield* io.emit({
              kind: "diagnostic",
              diagnostic: confinedControl(STEER_REJECTED_CATEGORY),
            });
            break;
          }
        }
        yield* bridge.waitPast(seenVersion);
      }
      yield* Fiber.interrupt(steering);
      bridge.stop();
      yield* drain;
      completed = true;
      return yield* bundleFor(native.error(), terminal, io);
    });

    return yield* Effect.onInterrupt(body, () => announceOnInterrupt);
  });
}

/**
 * Send one Control natively, and say so if it did not arrive.
 *
 * Admission and an otherwise good answer stay honest when native delivery
 * fails: what the caller was told is that the Control entered the mailbox,
 * which it did. Only a bounded `control` diagnostic records that the session
 * refused it, and no user message is fabricated — a transcript that showed
 * guidance the provider never took would be the one lie this seam must not
 * tell.
 */
function deliverSteer(
  session: PiSession,
  text: string,
  io: ExecutionIO,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const failure = yield* Effect.promise(() =>
      Promise.resolve()
        .then(() => session.steer(text))
        .then(
          () => undefined,
          (error: unknown) => error ?? new Error("steer rejected"),
        ),
    );
    if (failure === undefined) return;
    yield* io.emit({
      kind: "diagnostic",
      diagnostic: confinedControl(STEER_REJECTED_CATEGORY),
    });
  });
}

/** What the Run ended as, once the native work has stopped talking. */
function bundleFor(
  promptError: unknown,
  terminal: TerminalReconciliation | undefined,
  io: ExecutionIO,
): Effect.Effect<TerminalBundle> {
  return Effect.gen(function* () {
    if (terminal !== undefined) {
      return { ending: answeredEnding(), reconciliation: terminal };
    }
    if (promptError !== undefined) {
      const diagnostic = confined(PROMPT_REJECTED_CATEGORY);
      yield* io.emit({ kind: "diagnostic", diagnostic });
      return { ending: failedEnding(diagnostic.message) };
    }
    // The session went idle and never said how the Run ended. That is a
    // failure with a fixed message rather than an invented answer.
    return { ending: failedEnding(MISSING_TERMINAL_EVENT_MESSAGE) };
  });
}

/** The promise side of one Run: prompt, then wait for the session to settle. */
function startNativePrompt(
  session: PiSession,
  prompt: string,
  bridge: CallbackBridge,
): { readonly settled: () => boolean; readonly error: () => unknown } {
  let settled = false;
  let error: unknown;
  void (async () => {
    try {
      await session.prompt(prompt);
    } catch (rejection) {
      error = rejection ?? new Error("prompt rejected");
    }
    try {
      await session.waitForIdle();
    } catch {
      // Idleness is best effort: the prompt's own outcome is what settles.
    }
    settled = true;
    bridge.signal();
  })();
  return { settled: () => settled, error: () => error };
}

/**
 * Stop whatever the session is doing, and wait for it to be quiet.
 *
 * Clear first so nothing queued starts after the abort, abort second so
 * uncooperative work cannot prevent cancellation, and wait last so the Run's
 * scope does not close while the session is still writing. Each step is
 * guarded on its own: a session that refuses one of them must not stop the
 * other two from running.
 *
 * The caller bounds the whole thing. A cleanup that outlives its budget is
 * M2's escalation, which closes the BackendAgent and marks the conversation
 * lost — the monotonic outcome, and the reason there is no pending-cleanup
 * state here.
 */
async function stopNativeWork(session: PiSession): Promise<void> {
  try {
    session.clearQueue();
  } catch {
    // The abort below remains authoritative when the queue refuses.
  }
  try {
    await session.abort();
  } catch {
    // A session that cannot be aborted is still waited for.
  }
  try {
    await session.waitForIdle();
  } catch {
    // Cleanup cannot alter an already-settled Run.
  }
}
