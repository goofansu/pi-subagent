/**
 * One Session runtime, built for a test, torn down after it.
 *
 * Every M2 test that drives the supervisor needs the same six things wired
 * together and the same guarantee about what happens afterwards, and the guarantee
 * is the reason this is shared rather than copied: {@link withSession} reads the
 * runtime probe **after** the Session Scope has closed and hands it back, so a
 * test that forgets to assert on leaks is the only way to have one go unnoticed.
 *
 * It is deliberately not a driver. It builds a Session and gets out of the way;
 * everything a test does to a Run it does through the supervisor's public
 * operations, which is the whole point of having deleted the M1 driver.
 *
 * Like the conformance suite, this is a *test boundary*: it is where a
 * `node:test` callback crosses into Effect, and therefore one of the two
 * places in the lane that runs one. No production module does.
 */

import type { Deferred, Scope } from "effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  DEFAULT_BACKEND_ID,
  type Profile,
  type ResumeOutcome,
  type RunId,
  type StartOutcome,
  type SubagentId,
} from "../domain/index.ts";
import {
  type SessionServices,
  sessionRuntimeLayer,
} from "../runtime/composition.ts";
import {
  createRuntimeCounters,
  probeIsClear,
  type RuntimeCounters,
  type RuntimeProbe,
} from "../runtime/counters.ts";
import { CompletionDelivery } from "../runtime/delivery.ts";
import type { RuntimePolicy } from "../runtime/policy.ts";
import { RunRepository } from "../runtime/repository.ts";
import {
  type PinHolder,
  type ResultEncoder,
  ResultStore,
} from "../runtime/result-store.ts";
import {
  type StartRequest,
  SubagentSupervisor,
} from "../runtime/supervisor.ts";
import {
  createFakeNotificationSink,
  type FakeNotificationSink,
} from "./fake-sink.ts";
import {
  createFakeOneShotBackend,
  createFakeResumableBackend,
  type FakeBackendHandle,
} from "./fakes/backend.ts";
import { type FakeOpenScript, type FakeStep, scripts } from "./fakes/script.ts";

/** The Profile every rig starts with, unless a test supplies its own. */
export const RIG_PROFILE: Profile = {
  name: "explore",
  description: "The explore specialist",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Explore.",
};

/** A start request with the four fixed facts already filled in. */
export function rigRequest(
  overrides: Partial<StartRequest> = {},
): StartRequest {
  return {
    agent: RIG_PROFILE.name,
    description: "look around",
    prompt: "have a look",
    cwd: "/work",
    childDepth: 1,
    projectTrusted: true,
    ...overrides,
  };
}

export interface SessionRig {
  readonly supervisor: SubagentSupervisor["Service"];
  readonly repository: RunRepository["Service"];
  readonly store: ResultStore["Service"];
  readonly delivery: CompletionDelivery["Service"];
  readonly sink: FakeNotificationSink;
  readonly backend: FakeBackendHandle;
  readonly counters: RuntimeCounters;
  /** Inject one test-only exit at a settlement storage boundary. */
  readonly exitNextSettlementAt: (
    boundary: "commit" | "publication",
    exit: "defect" | "interrupt",
  ) => void;
}

export interface SessionRigOptions {
  /** One script per Run, consumed in order. */
  readonly steps?: readonly (readonly FakeStep[])[];
  /** How the fake behaves when it is opened. */
  readonly open?: FakeOpenScript;
  /** Violate the backend contract by throwing before returning an Effect. */
  readonly executeThrowsSynchronously?: boolean;
  /** Zero-based executions on which to throw before returning an Effect. */
  readonly executeThrowsSynchronouslyAt?: readonly number[];
  readonly policy?: RuntimePolicy;
  /** Override the store encoder to inject a settlement failure. */
  readonly resultEncoder?: ResultEncoder;
  readonly profiles?: readonly Profile[];
  readonly maxDelegationDepth?: number;
  /** `false` builds the one-shot fake, which declares no capabilities. */
  readonly resumable?: boolean;
  readonly gates?: Record<string, Deferred.Deferred<void>>;
  readonly trace?: string[];
  /** Hold BackendAgent close at a named gate for cleanup-budget tests. */
  readonly close?: {
    readonly gate: string;
    readonly uninterruptible?: boolean;
  };
  /** Provide a test clock, for the tests where time has to pass. */
  readonly testClock?: boolean;
}

export interface SessionOutcome<A> {
  readonly value: A;
  /** Read after the Session Scope closed, which is when it must be clear. */
  readonly probeAfterClose: RuntimeProbe;
  readonly noLeaks: boolean;
}

/**
 * Build a Session runtime, run a body against it, and close it.
 *
 * The body's value comes back alongside the probe, so every caller is one
 * assertion away from a leak test whether or not the test is about leaks.
 */
export function withSession<A>(
  options: SessionRigOptions,
  // The body may require a `Scope`: it is the Session's own, so anything a
  // test acquires there is released by the same close the probe is read after.
  // It may also require any Session service, because it runs inside the same
  // layer the rig's own fields come from — which is what lets a test drive the
  // `Subagents` façade rather than the supervisor when the path under test
  // starts at a tool call.
  body: (
    rig: SessionRig,
  ) => Effect.Effect<A, never, Scope.Scope | SessionServices>,
): Promise<SessionOutcome<A>> {
  const create =
    options.resumable === false
      ? createFakeOneShotBackend
      : createFakeResumableBackend;
  const backend = create({
    scripts: scripts(...(options.steps ?? [[]])),
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.executeThrowsSynchronously === undefined
      ? {}
      : { executeThrowsSynchronously: options.executeThrowsSynchronously }),
    ...(options.executeThrowsSynchronouslyAt === undefined
      ? {}
      : {
          executeThrowsSynchronouslyAt: options.executeThrowsSynchronouslyAt,
        }),
    ...(options.gates === undefined ? {} : { gates: options.gates }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.close === undefined ? {} : { close: options.close }),
  });
  const sink = createFakeNotificationSink();
  const counters = createRuntimeCounters();
  const profiles = options.profiles ?? [
    { ...RIG_PROFILE, backend: backend.backend.id },
  ];

  const built = Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const repository = yield* RunRepository;
    const store = yield* ResultStore;
    const delivery = yield* CompletionDelivery;
    const exitNextSettlementAt: SessionRig["exitNextSettlementAt"] = (
      boundary,
      exit,
    ) => {
      let pending = true;
      const injectedExit = () =>
        exit === "defect"
          ? Effect.die(new Error("injected settlement defect"))
          : Effect.interrupt;
      if (boundary === "commit") {
        const commit = store.commit;
        Object.defineProperty(store, "commit", {
          configurable: true,
          value: (...args: Parameters<typeof commit>) => {
            if (!pending) return commit(...args);
            pending = false;
            return injectedExit();
          },
        });
        return;
      }
      const releasePin = store.releasePin;
      Object.defineProperty(store, "releasePin", {
        configurable: true,
        value: (runId: RunId, holder: PinHolder) => {
          const released = releasePin(runId, holder);
          if (!pending || holder !== "publication") return released;
          pending = false;
          return Effect.andThen(released, injectedExit());
        },
      });
    };
    const value = yield* body({
      supervisor,
      repository,
      store,
      delivery,
      sink,
      backend,
      counters,
      exitNextSettlementAt,
    });
    return { value, readProbe: () => supervisor.probe() };
  }).pipe(
    Effect.provide(
      sessionRuntimeLayer({
        backends: [backend.backend],
        profiles: { from: "list", profiles },
        sink,
        counters,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.resultEncoder === undefined
          ? {}
          : { resultEncoder: options.resultEncoder }),
        ...(options.maxDelegationDepth === undefined
          ? {}
          : { maxDelegationDepth: options.maxDelegationDepth }),
      }),
    ),
  );

  // Annotated rather than inferred. `Effect.provide` of a Layer that itself
  // needs a `Scope` leaves the requirement as `any` in this release, and an
  // `any` here would silently swallow a real missing service later.
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
    return { value, probeAfterClose, noLeaks: probeIsClear(probeAfterClose) };
  });
}

/**
 * Narrow a start or a resume to the one outcome most tests are about.
 *
 * A throw rather than an early return, so a test body always has one return
 * type: an `Effect.gen` that returns `undefined` down one branch infers a
 * union that every assertion below then has to unwrap.
 *
 * Both outcomes, because the two unions agree on the shape of `started` and
 * every caller wants the same two ids out of either. A separate `resumedRun`
 * would be the same function under a second name.
 */
export function startedRun(outcome: StartOutcome | ResumeOutcome): {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
} {
  if (outcome.outcome !== "started") {
    throw new Error(`expected a started Run, got '${outcome.outcome}'`);
  }
  return outcome;
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
export function untilTerminal(
  rig: SessionRig,
  runId: RunId,
): Effect.Effect<void> {
  return until(
    `${runId} to settle`,
    Effect.map(
      rig.repository.lookup(runId),
      (known) => known.state === "terminal",
    ),
  );
}

/**
 * Wait until the backend has begun the nth execution.
 *
 * The distinction matters more than it looks: a Subagent whose BackendAgent
 * has never run has no conversation to resume and nothing to cancel, so a test
 * that acts too early is testing a different Run from the one it meant to.
 * Counted rather than observed live, because a Run that finishes quickly would
 * otherwise be missed entirely and the wait would never end.
 */
export function untilUnderWay(rig: SessionRig, index = 0): Effect.Effect<void> {
  return until(
    `execution ${index + 1} to begin`,
    Effect.sync(() => rig.backend.counters().executionsStarted > index),
  );
}

/** Let the work settlement forks — delivery, sweeps — finish. */
export function quiesce(): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let step = 0; step < 30; step += 1) yield* Effect.yieldNow;
  });
}
