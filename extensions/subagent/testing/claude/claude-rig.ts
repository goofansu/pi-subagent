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
 * The Session wiring itself is shared with the other adapters'\u00a0rigs in
 * `testing/backend-session.ts`, so what is left here is only what is Claude's:
 * the stand-in, the loader it is injected through, and the two adapter
 * readings the contract has no place for.
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
import {
  createRuntimeCounters,
  type RuntimeCounters,
  type RuntimeProbe,
} from "../../runtime/counters.ts";
import type { RuntimePolicy } from "../../runtime/policy.ts";
import type { RunRepository } from "../../runtime/repository.ts";
import type { StartRequest } from "../../runtime/supervisor.ts";
import {
  type BackendSessionServices,
  until,
  untilRunTerminal,
  withBackendSession,
} from "../backend-session.ts";
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

export interface ClaudeRig extends BackendSessionServices {
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
  /** Replace the runtime clock so adapter-local bounds can be advanced. */
  readonly testClock?: boolean;
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

  return withBackendSession(
    {
      backend: correlateRuns(handle.backend, standIn),
      profiles: {
        from: "list",
        profiles: options.profiles ?? [CLAUDE_RIG_PROFILE],
      },
      sink,
      counters,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.testClock === undefined
        ? {}
        : { testClock: options.testClock }),
    },
    (services) =>
      body({
        ...services,
        sink,
        counters,
        standIn,
        probe: handle.probe,
        tally: handle.tally,
        loads: () => loads,
      }),
  ).then((outcome) => ({
    ...outcome,
    nativeProbeAfterClose: handle.probe(),
    tallyAfterClose: handle.tally(),
  }));
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
  return untilRunTerminal(rig.repository, runId);
}

export { quiesce, until } from "../backend-session.ts";
