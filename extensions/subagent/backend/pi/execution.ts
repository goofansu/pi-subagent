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
 *   handed around. Interruption promptly stops the execution and returns
 *   control to settlement. Native cleanup is registered separately as an
 *   interruptible **execution-scope finalizer**, after the event subscription,
 *   so scope closure runs cleanup before unsubscribe under the runtime's
 *   cleanup budget. An overrun escalates through M2's path rather than through
 *   Pi-specific pending state; v1 needed that bookkeeping because it had no
 *   bounded escalation, and this does not.
 * - **A terminal snapshot observed before interruption still answers.** The
 *   interrupt handler emits the snapshot and the ending it implies, so
 *   arbitration sees an announced ending and the Run reports the answer it
 *   actually got. A cancel that arrives after the work finished is a request
 *   against a Run that was already done.
 *
 * The one thing this module never does is settle its own Run. It returns a
 * bundle; the core decides.
 */

import { Deferred, Effect, Fiber, Option, type Scope } from "effect";
import {
  answeredEnding,
  failedEnding,
  type TerminalReconciliation,
} from "../../domain/index.ts";
import type { ExecutionIO, RunInput, TerminalBundle } from "../contract.ts";
import { BRIDGE_OVERFLOW_MESSAGE } from "../native-bridge.ts";
import { createCallbackBridge } from "./bridge.ts";
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

type NativeSettlement =
  | { readonly kind: "native"; readonly error: unknown }
  | { readonly kind: "overflow" };

export interface PiExecutionContext {
  readonly session: PiSession;
  /** The adapter's own closed flag. The SDK does not defend a disposed session. */
  readonly isClosed: () => boolean;
  /** Completes whenever the retained BackendAgent closes, by escalation or Shutdown. */
  readonly closeRequested: Effect.Effect<void>;
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

    const bridge = yield* createCallbackBridge();
    const settlement = yield* Deferred.make<NativeSettlement>();
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

    const offer = (observation: Parameters<typeof bridge.offer>[0]): void => {
      if (bridge.offer(observation)) return;
      Deferred.doneUnsafe(
        settlement,
        Effect.succeed({ kind: "overflow" } as const),
      );
    };

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
            offer(observation);
          }
          return;
        }
        case "activity": {
          offer(read.observation);
          return;
        }
        case "tool": {
          for (const observation of read.observations) offer(observation);
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

    /** Hand everything currently queued to the intake, with backpressure. */
    const drainAvailable = Effect.gen(function* () {
      for (;;) {
        const next = yield* bridge.poll;
        if (Option.isNone(next)) break;
        yield* io.emit(next.value);
      }
      for (const observation of bridge.takeOverflowPolicy()) {
        yield* io.emit(observation);
      }
    });

    /** Emit in offer order until native work settles, then empty the Queue. */
    const drainUntilSettlement = Effect.gen(function* () {
      for (;;) {
        // Drain bursts in one take. Racing once per observation creates and
        // interrupts a waiting fiber for every item in a provider burst.
        yield* drainAvailable;
        if (Deferred.isDoneUnsafe(settlement)) return;

        const next = yield* Effect.race(
          bridge.take.pipe(
            Effect.map((observation) => ({
              kind: "observation" as const,
              observation,
            })),
          ),
          Deferred.await(settlement).pipe(
            Effect.map(() => ({ kind: "settled" as const })),
          ),
        );
        if (next.kind === "observation") {
          yield* io.emit(next.observation);
          continue;
        }
        yield* drainAvailable;
        return;
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
    // Registered after the subscription, so LIFO scope closure stops native
    // work while its events can still be observed, then unsubscribes. This is
    // deliberately a scope finalizer rather than an acquire-use-release
    // release in the execution fiber: interruption can return promptly, and
    // the runtime's step-4 execution-scope budget owns this provider wait.
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.suspend(() => {
        if (completed) return Effect.void;
        return Effect.gen(function* () {
          probe.acquired("pendingCleanups");
          yield* Effect.raceFirst(
            Effect.promise(() => stopNativeWork(session)),
            context.closeRequested,
          );
        }).pipe(
          Effect.ensuring(Effect.sync(() => probe.released("pendingCleanups"))),
        );
      }),
    );
    /** What a cancelled Run still has to say before its intake is sealed. */
    let interruptAnnounced = false;
    const announceOnInterrupt = Effect.gen(function* () {
      if (interruptAnnounced) return;
      interruptAnnounced = true;
      yield* drainAvailable;
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
    let nativeDeliveries = 0;
    /** The completion owned by the one serial delivery currently in flight. */
    let inFlightDelivery:
      | { readonly finished: Deferred.Deferred<void> }
      | undefined;

    const steerLoop = Effect.gen(function* () {
      for (;;) {
        const control = yield* io.controls.take;
        if (control === undefined) return;
        if (context.isClosed()) return;
        deliveries += 1;
        const delivery = { finished: Deferred.makeUnsafe<void>() };
        inFlightDelivery = delivery;
        if (Deferred.isDoneUnsafe(settlement)) {
          yield* io
            .emit({
              kind: "diagnostic",
              diagnostic: confinedControl(STEER_ABANDONED_MESSAGE),
            })
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  deliveries -= 1;
                  Deferred.doneUnsafe(delivery.finished, Effect.void);
                  if (inFlightDelivery === delivery)
                    inFlightDelivery = undefined;
                }),
              ),
            );
          continue;
        }
        nativeDeliveries += 1;
        yield* deliverSteer(session, control.text, io).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliveries -= 1;
              nativeDeliveries -= 1;
              Deferred.doneUnsafe(delivery.finished, Effect.void);
              if (inFlightDelivery === delivery) inFlightDelivery = undefined;
            }),
          ),
        );
      }
    });

    const body = Effect.gen(function* () {
      const steering = yield* Effect.forkChild(steerLoop);
      const draining = yield* Effect.forkChild(drainUntilSettlement);
      yield* Effect.forkChild(
        startNativePrompt(session, input.prompt, settlement),
      );
      const outcome = yield* Deferred.await(settlement).pipe(
        Effect.onInterrupt(() => announceOnInterrupt),
        Effect.tap((settled) =>
          Effect.sync(() => {
            completed = settled.kind === "native";
          }),
        ),
      );

      if (outcome.kind === "overflow") {
        yield* Fiber.interrupt(steering);
        bridge.stop();
        yield* Fiber.join(draining);
        // The settlement can win the take race just before the synchronous
        // callback records its overflow policy. Offers are closed now, so one
        // final drain makes the policy pair lossless in that window too.
        yield* drainAvailable;
        return { ending: failedEnding(BRIDGE_OVERFLOW_MESSAGE) };
      }

      yield* Fiber.join(draining);
      if (deliveries > 0) {
        if (nativeDeliveries > 0 && session.isIdle) {
          // The prompt has settled and Pi is idle, so a delivery still in
          // flight is one the session is never going to take. Do not let it
          // hold the Run open indefinitely.
          yield* io.emit({
            kind: "diagnostic",
            diagnostic: confinedControl(STEER_REJECTED_CATEGORY),
          });
        } else {
          const delivery = inFlightDelivery;
          if (delivery !== undefined) yield* Deferred.await(delivery.finished);
        }
      }
      yield* Fiber.interrupt(steering);
      const abandonedSteering = yield* Effect.sync(() => {
        try {
          return session.clearQueue().steering.length > 0;
        } catch {
          // Completion remains authoritative when the queue refuses inspection.
          return false;
        }
      });
      if (abandonedSteering) {
        yield* io.emit({
          kind: "diagnostic",
          diagnostic: confinedControl(STEER_ABANDONED_MESSAGE),
        });
      }
      bridge.stop();
      yield* drainAvailable;
      return yield* bundleFor(outcome.error, terminal, io);
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

/** The promise side of one Run, forked inside the execution Scope. */
function startNativePrompt(
  session: PiSession,
  prompt: string,
  settlement: Deferred.Deferred<NativeSettlement>,
): Effect.Effect<void> {
  const outcome = Effect.callback<NativeSettlement>((resume) => {
    Promise.resolve()
      .then(() => session.prompt(prompt))
      .then(
        () => undefined,
        (rejection: unknown) => rejection ?? new Error("prompt rejected"),
      )
      .then((error) =>
        Promise.resolve()
          .then(() => session.waitForIdle())
          .then(
            () => error,
            () => error,
          ),
      )
      .then((error) => {
        resume(Effect.succeed({ kind: "native", error }));
      });
  });
  return outcome.pipe(
    Effect.flatMap((native) => Deferred.succeed(settlement, native)),
    Effect.asVoid,
  );
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
