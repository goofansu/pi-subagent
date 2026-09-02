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
 */

import type { Deferred } from "effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  DEFAULT_BACKEND_ID,
  type Profile,
  type RunId,
  type StartOutcome,
  type SubagentId,
} from "../domain/index.ts";
import { sessionRuntimeLayer } from "../runtime/composition.ts";
import {
  createRuntimeCounters,
  probeIsClear,
  type RuntimeCounters,
  type RuntimeProbe,
} from "../runtime/counters.ts";
import {
  CompletionDelivery,
  createFakeNotificationSink,
  type FakeNotificationSink,
} from "../runtime/delivery.ts";
import type { RuntimePolicy } from "../runtime/policy.ts";
import { RunRepository } from "../runtime/repository.ts";
import { ResultStore } from "../runtime/result-store.ts";
import {
  type StartRequest,
  SubagentSupervisor,
} from "../runtime/supervisor.ts";
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
}

export interface SessionRigOptions {
  /** One script per Run, consumed in order. */
  readonly steps?: readonly (readonly FakeStep[])[];
  /** How the fake behaves when it is opened. */
  readonly open?: FakeOpenScript;
  readonly policy?: RuntimePolicy;
  readonly profiles?: readonly Profile[];
  readonly maxDelegationDepth?: number;
  /** `false` builds the one-shot fake, which declares no capabilities. */
  readonly resumable?: boolean;
  readonly gates?: Record<string, Deferred.Deferred<void>>;
  readonly trace?: string[];
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
  body: (rig: SessionRig) => Effect.Effect<A>,
): Promise<SessionOutcome<A>> {
  const create =
    options.resumable === false
      ? createFakeOneShotBackend
      : createFakeResumableBackend;
  const backend = create({
    scripts: scripts(...(options.steps ?? [[]])),
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.gates === undefined ? {} : { gates: options.gates }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
  });
  const sink = createFakeNotificationSink();
  const counters = createRuntimeCounters();
  const profiles = options.profiles ?? [
    { ...RIG_PROFILE, backend: backend.backend.id },
  ];

  const program = Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const repository = yield* RunRepository;
    const store = yield* ResultStore;
    const delivery = yield* CompletionDelivery;
    const value = yield* body({
      supervisor,
      repository,
      store,
      delivery,
      sink,
      backend,
      counters,
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
        ...(options.maxDelegationDepth === undefined
          ? {}
          : { maxDelegationDepth: options.maxDelegationDepth }),
      }),
    ),
    Effect.scoped,
  );

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
 * Narrow a start to the one outcome most tests are about.
 *
 * A throw rather than an early return, so a test body always has one return
 * type: an `Effect.gen` that returns `undefined` down one branch infers a
 * union that every assertion below then has to unwrap.
 */
export function startedRun(outcome: StartOutcome): {
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
function until(
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
