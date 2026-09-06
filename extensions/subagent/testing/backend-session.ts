/**
 * One Session runtime over one real backend adapter, for that adapter's own
 * tests.
 *
 * The shared conformance suite has its own driver and needs none of this. What
 * needs it is the *other* half of an adapter's tests: the cells that are the
 * provider's own, which have to drive the supervisor's public operations
 * directly and then look at what the provider was actually asked to do.
 *
 * The wiring for that is identical whichever adapter it is — six services, a
 * policy, a sink, a counter set, and a probe read *after* the Session Scope has
 * closed — so it lives here rather than once per adapter. M5 is where that
 * became worth doing: with one real adapter the duplication was a copy, with
 * two it is a place for the two to drift, and with the third at M6 it would be
 * three copies of the same forty lines.
 *
 * What stays with each adapter is everything provider-shaped: building the
 * stand-in, injecting it through the factory or loader the adapter already
 * has, and reading that adapter's own native probe. This module names no
 * provider and no adapter, and takes a `Backend` it never looks inside.
 *
 * Like the other rigs it is a *test boundary*: it is where a `node:test`
 * callback crosses into Effect, and reading the probe after closure is what
 * makes "this Session leaked nothing" an assertion rather than a hope.
 */

import type { Scope } from "effect";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { Backend } from "../backend/contract.ts";
import type { Profile } from "../domain/index.ts";
import { sessionRuntimeLayer } from "../runtime/composition.ts";
import {
  probeIsClear,
  type RuntimeCounters,
  type RuntimeProbe,
} from "../runtime/counters.ts";
import type { RuntimePolicy } from "../runtime/policy.ts";
import { RunRepository } from "../runtime/repository.ts";
import { ResultStore } from "../runtime/result-store.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import type { FakeNotificationSink } from "./fake-sink.ts";

/** Where the Session's Profiles come from. */
export type RigProfileSource =
  | { readonly from: "list"; readonly profiles: readonly Profile[] }
  /**
   * A directory, which is what a scenario about *loading* needs.
   *
   * Validation runs only for a Profile the Session loaded, so a scenario about
   * a rejected Profile has to supply a file rather than a value: a list handed
   * straight to the catalog is one that has already been accepted.
   */
  | { readonly from: "directory"; readonly agentDir: string };

export interface BackendSessionOptions {
  /** The adapter under test, with its stand-in already injected. */
  readonly backend: Backend;
  readonly profiles: RigProfileSource;
  readonly sink: FakeNotificationSink;
  readonly counters: RuntimeCounters;
  readonly policy?: RuntimePolicy;
  /** Models the Session's catalogue holds, for Profile validation. */
  readonly models?: readonly {
    readonly provider: string;
    readonly id: string;
  }[];
  /**
   * Provide a test clock, for the tests where time has to pass.
   *
   * Needed by any adapter whose own bounds are on the runtime clock — a
   * request budget, a signal-escalation ladder — because the only honest way
   * to prove those is to advance a clock the test controls. The lane forbids
   * real sleeping outright.
   */
  readonly testClock?: boolean;
}

/** The three services an adapter's own tests drive the Session through. */
export interface BackendSessionServices {
  readonly supervisor: SubagentSupervisor["Service"];
  readonly repository: RunRepository["Service"];
  readonly store: ResultStore["Service"];
}

export interface BackendSessionOutcome<A> {
  readonly value: A;
  /** Read after the Session Scope closed, which is when it must be clear. */
  readonly probeAfterClose: RuntimeProbe;
  readonly noLeaks: boolean;
}

/** Build a Session over one backend, run a body against it, and close it. */
export function withBackendSession<A>(
  options: BackendSessionOptions,
  body: (
    services: BackendSessionServices,
  ) => Effect.Effect<A, never, Scope.Scope>,
): Promise<BackendSessionOutcome<A>> {
  const built = Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const repository = yield* RunRepository;
    const store = yield* ResultStore;
    const value = yield* body({ supervisor, repository, store });
    return { value, readProbe: () => supervisor.probe() };
  }).pipe(
    Effect.provide(
      sessionRuntimeLayer({
        backends: [options.backend],
        profiles: options.profiles,
        sink: options.sink,
        counters: options.counters,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.models === undefined
          ? {}
          : { validation: { models: options.models } }),
      }),
    ),
  );

  // Annotated rather than inferred: providing a Layer that itself needs a
  // `Scope` leaves the requirement as `any` in this release.
  const program: Effect.Effect<{
    readonly value: A;
    readonly readProbe: () => RuntimeProbe;
  }> = Effect.scoped(built);

  return Effect.runPromise(
    options.testClock
      ? program.pipe(Effect.provide(TestClock.layer()))
      : program,
  ).then(({ value, readProbe }) => {
    const probeAfterClose = readProbe();
    return {
      value,
      probeAfterClose,
      noLeaks: probeIsClear(probeAfterClose),
    };
  });
}

/**
 * Spin until something is true, or give up and say what was waited for.
 *
 * Bounded deliberately: a test whose fixture deadlocks should fail with the
 * name of what it was waiting for, not hang the lane.
 */
export function until(
  what: string,
  ready: Effect.Effect<boolean>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let step = 0; step < 200_000; step += 1) {
      if (yield* ready) return;
      yield* Effect.yieldNow;
    }
    throw new Error(`gave up waiting for ${what}`);
  });
}

/** Wait until a Run is terminal, without sleeping. */
export function untilRunTerminal(
  repository: RunRepository["Service"],
  runId: Parameters<RunRepository["Service"]["lookup"]>[0],
): Effect.Effect<void> {
  return until(
    `${runId} to settle`,
    Effect.map(repository.lookup(runId), (known) => known.state === "terminal"),
  );
}

/** Let the forks that follow settlement — delivery, sweeps — finish. */
export function quiesce(): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let step = 0; step < 30; step += 1) yield* Effect.yieldNow;
  });
}

/** Issue a Cancel and prove it returned without advancing the test clock. */
export function issueCancelBeforeClockMoves<A, E, R>(
  cancel: Effect.Effect<A, E, R>,
): Effect.Effect<
  { readonly outcome: A; readonly returnedBeforeClockAdvance: boolean },
  E,
  R | Scope.Scope
> {
  return Effect.gen(function* () {
    const cancelling = yield* Effect.forkChild(cancel);
    yield* quiesce();
    const returnedBeforeClockAdvance = cancelling.pollUnsafe() !== undefined;
    if (!returnedBeforeClockAdvance) {
      throw new Error("cancel did not return before the test clock moved");
    }
    const outcome = yield* Fiber.join(cancelling);
    return { outcome, returnedBeforeClockAdvance };
  });
}
