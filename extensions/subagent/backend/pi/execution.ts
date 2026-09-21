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
 * - **Native prompt return records the decision.** The evidence fold classifies
 *   the completed prompt and execution immediately hands that terminal bundle
 *   to the core. Interruption before prompt return records no decision; after
 *   return, core Arbitration preserves the already-recorded bundle.
 *
 * The one thing this module never does is settle its own Run. It returns a
 * bundle; the core decides.
 */

import { Deferred, Effect, Fiber, Option, type Scope } from "effect";
import { failedEnding } from "../../domain/index.ts";
import type { ExecutionIO, RunInput, TerminalBundle } from "../contract.ts";
import { BRIDGE_OVERFLOW_MESSAGE } from "../native-bridge.ts";
import { createCallbackBridge } from "./bridge.ts";
import type { PiProbeCounters } from "./probe.ts";
import { createPiRunEvidence, type PiRunFinishReport } from "./run-evidence.ts";
import type { PiSession, PiSessionEvent } from "./session.ts";
import { confinedControl, createPiRunReadingTranslator } from "./translate.ts";

/** What an execution says when the BackendAgent was closed under it. */
export const CLOSED_BEFORE_EXECUTION_MESSAGE =
  "the Pi BackendAgent was closed before this Run could start";

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
    const translator = createPiRunReadingTranslator();
    const evidence = createPiRunEvidence({
      goal: input.prompt,
      baseline: translator.messages(session.messages),
    });
    // The native callback cannot yield. Translation and evidence therefore
    // make their complete synchronous decision before execution offers the
    // resulting neutral observations to the callback bridge.
    let normalFinish: PiRunFinishReport | undefined;
    let completed = false;

    const offer = (observation: Parameters<typeof bridge.offer>[0]): void => {
      if (bridge.offer(observation)) return;
      Deferred.doneUnsafe(
        settlement,
        Effect.succeed({ kind: "overflow" } as const),
      );
    };

    const listen = (event: PiSessionEvent): void => {
      if (!bridge.accepting()) return;
      for (const observation of evidence.read(translator.event(event))) {
        offer(observation);
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
    // the subscription remains owned until native stop completes. Interruption
    // freezes the bridge before draining the accepted observations, so native
    // abort events cannot become pre-interruption evidence or rewrite its
    // snapshot. Overflow likewise closes offers before native cleanup.
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
    // work before releasing the subscription. This is
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
    /** Stop intake and preserve every observation accepted before interruption. */
    const drainOnInterrupt = Effect.gen(function* () {
      bridge.stop();
      yield* drainAvailable;
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
        Effect.tap((settled) =>
          settled.kind === "native"
            ? Effect.uninterruptible(
                Effect.gen(function* () {
                  normalFinish = evidence.promptReturned(
                    settled.error === undefined ? "resolved" : "rejected",
                  );
                  yield* io.recordDecision(normalFinish.bundle);
                  // A decision does not seal observation intake. Preserve its
                  // diagnostics even when cancellation follows immediately.
                  for (const observation of normalFinish.observations) {
                    yield* io.emit(observation);
                  }
                }),
              )
            : Effect.void,
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
      // Native finish alone is not cleanup completion: interruption before
      // this point must still clear queued input in the bounded finalizer.
      completed = true;
      bridge.stop();
      yield* drainAvailable;
      const decision =
        normalFinish ??
        evidence.promptReturned(
          outcome.error === undefined ? "resolved" : "rejected",
        );
      return decision.bundle;
    });

    return yield* Effect.onInterrupt(body, () => drainOnInterrupt);
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
