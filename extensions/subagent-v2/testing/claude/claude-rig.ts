/**
 * One Session runtime with the real Claude backend behind it.
 *
 * The shared conformance suite already drives the adapter through every
 * provider-neutral scenario. This is for the ones that are *Claude's*: the M0
 * spike's findings, and the cells of the compatibility matrix that only mean
 * something for a streaming Query with a client-owned input stream. Those need
 * to drive the supervisor directly and then look at what the Query was
 * actually asked to do, which is what the record is for.
 *
 * Like the other rigs it is a test boundary: it is where a `node:test`
 * callback crosses into Effect, and it reads both probes *after* the Session
 * Scope has closed so that a leak cannot go unnoticed.
 */

import type { Scope } from "effect";
import { Effect } from "effect";
import {
  type ClaudeAdapterTally,
  type ClaudeNativeProbe,
  type ClaudeQueryLoader,
  createClaudeBackend,
} from "../../backend/claude/index.ts";
import { backendId, type Profile } from "../../domain/index.ts";
import { sessionRuntimeLayer } from "../../runtime/composition.ts";
import {
  createRuntimeCounters,
  probeIsClear,
  type RuntimeCounters,
  type RuntimeProbe,
} from "../../runtime/counters.ts";
import type { RuntimePolicy } from "../../runtime/policy.ts";
import { RunRepository } from "../../runtime/repository.ts";
import { ResultStore } from "../../runtime/result-store.ts";
import {
  type StartRequest,
  SubagentSupervisor,
} from "../../runtime/supervisor.ts";
import { correlateRuns } from "../correlate.ts";
import {
  createFakeNotificationSink,
  type FakeNotificationSink,
} from "../fake-sink.ts";
import {
  type ClaudeScript,
  createStandInClaudeQuery,
  type StandInClaudeQuery,
} from "./stand-in-query.ts";

/** The Profile every Claude rig starts with: no fields, so nothing is pinned. */
export const CLAUDE_RIG_PROFILE: Profile = {
  name: "review",
  description: "The reviewing specialist",
  backend: backendId("claude"),
  fields: {},
  systemPrompt: "Review.",
};

/** A start request with the four fixed facts already filled in. */
export function claudeRigRequest(
  overrides: Partial<StartRequest> = {},
): StartRequest {
  return {
    agent: CLAUDE_RIG_PROFILE.name,
    description: "look it over",
    prompt: "have a look",
    cwd: "/work",
    childDepth: 1,
    projectTrusted: true,
    ...overrides,
  };
}

export interface ClaudeRig {
  readonly supervisor: SubagentSupervisor["Service"];
  readonly repository: RunRepository["Service"];
  readonly store: ResultStore["Service"];
  readonly sink: FakeNotificationSink;
  readonly counters: RuntimeCounters;
  /** What the Query was asked to do. */
  readonly standIn: StandInClaudeQuery;
  /** What the adapter is still holding, right now. */
  readonly probe: () => ClaudeNativeProbe;
  /** Opens, and closes that took effect. */
  readonly tally: () => ClaudeAdapterTally;
  /** How many times the SDK loader was asked for a query function. */
  readonly loads: () => number;
}

export interface ClaudeRigOptions {
  /** One script per Query, consumed in order. */
  readonly scripts?: readonly ClaudeScript[];
  readonly profiles?: readonly Profile[];
  readonly policy?: RuntimePolicy;
  /** Make the SDK loader refuse, which is how an open fails. */
  readonly openFails?: boolean;
  /** Never resolve the loader, so the open budget decides. */
  readonly openHangs?: boolean;
  /** The process environment the child inherits. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ClaudeSessionOutcome<A> {
  readonly value: A;
  /** Read after the Session Scope closed, which is when it must be clear. */
  readonly probeAfterClose: RuntimeProbe;
  /** The adapter's own probe, read at the same moment. */
  readonly nativeProbeAfterClose: ClaudeNativeProbe;
  readonly tallyAfterClose: ClaudeAdapterTally;
  readonly noLeaks: boolean;
}

/** Build a Session over the Claude backend, run a body, and close it. */
export function withClaudeSession<A>(
  options: ClaudeRigOptions,
  body: (rig: ClaudeRig) => Effect.Effect<A, never, Scope.Scope>,
): Promise<ClaudeSessionOutcome<A>> {
  const standIn = createStandInClaudeQuery({ scripts: options.scripts ?? [] });
  const sink = createFakeNotificationSink();
  const counters = createRuntimeCounters();
  let loads = 0;

  const loadQuery: ClaudeQueryLoader = async () => {
    loads += 1;
    if (options.openFails) throw new Error("the stand-in SDK refused to load");
    if (options.openHangs) await new Promise<never>(() => {});
    return standIn.query;
  };

  const handle = createClaudeBackend({
    loadQuery,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const correlated = correlateRuns(handle.backend, standIn);

  const built = Effect.gen(function* () {
    const supervisor = yield* SubagentSupervisor;
    const repository = yield* RunRepository;
    const store = yield* ResultStore;
    const value = yield* body({
      supervisor,
      repository,
      store,
      sink,
      counters,
      standIn,
      probe: handle.probe,
      tally: handle.tally,
      loads: () => loads,
    });
    return { value, readProbe: () => supervisor.probe() };
  }).pipe(
    Effect.provide(
      sessionRuntimeLayer({
        backends: [correlated],
        profiles: {
          from: "list",
          profiles: options.profiles ?? [CLAUDE_RIG_PROFILE],
        },
        sink,
        counters,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
      }),
    ),
  );

  // Annotated rather than inferred, for the same reason the other rigs
  // annotate: providing a Layer that itself needs a `Scope` leaves the
  // requirement as `any` in this release.
  const program: Effect.Effect<{
    readonly value: A;
    readonly readProbe: () => RuntimeProbe;
  }> = Effect.scoped(built);

  return Effect.runPromise(program).then(({ value, readProbe }) => {
    const probeAfterClose = readProbe();
    return {
      value,
      probeAfterClose,
      nativeProbeAfterClose: handle.probe(),
      tallyAfterClose: handle.tally(),
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

/** Wait until the adapter has started its nth Query. */
export function untilQueried(rig: ClaudeRig, index = 0): Effect.Effect<void> {
  return until(
    `query ${index + 1} to start`,
    Effect.sync(() => rig.standIn.record().queries > index),
  );
}

/** Wait until the adapter has pushed its nth Control into an input stream. */
export function untilPushed(rig: ClaudeRig, index = 0): Effect.Effect<void> {
  return until(
    `control ${index + 1} to be pushed`,
    Effect.sync(() => rig.standIn.record().controls.length > index),
  );
}

/** Wait until a Run is terminal, without sleeping. */
export function untilTerminal(
  rig: ClaudeRig,
  runId: Parameters<RunRepository["Service"]["lookup"]>[0],
): Effect.Effect<void> {
  return until(
    `${runId} to settle`,
    Effect.map(
      rig.repository.lookup(runId),
      (known) => known.state === "terminal",
    ),
  );
}

/** Let the forks that follow settlement — delivery, sweeps — finish. */
export function quiesce(): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let step = 0; step < 30; step += 1) yield* Effect.yieldNow;
  });
}
