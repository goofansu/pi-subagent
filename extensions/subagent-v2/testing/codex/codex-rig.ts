/**
 * One Session runtime with the real Codex backend behind it.
 *
 * The shared conformance suite already drives the adapter through every
 * provider-neutral scenario. This is for the ones that are *Codex's*: the M0
 * spike's three findings, and the cells of the compatibility matrix that only
 * mean something for a process-wide event stream, a protocol that will not
 * report its peer's death, and usage that is cumulative across a whole
 * conversation. Those need to drive the supervisor directly and then look at
 * what the App Server was actually asked to do, which is what the record is
 * for.
 *
 * The Session wiring is shared with the other adapters' rigs in
 * `testing/backend-session.ts`, so what is left here is only what is Codex's:
 * the stand-in process, the spawn option it is injected through, and the two
 * adapter readings the contract has no place for.
 */

import type { Scope } from "effect";
import { Effect } from "effect";
import {
  type CodexAdapterTally,
  type CodexNativeProbe,
  createCodexBackend,
} from "../../backend/codex/index.ts";
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
  type CodexStandInAppServer,
  type CodexStandInOptions,
  createStandInAppServer,
} from "./stand-in-app-server.ts";

/** The Profile every Codex rig starts with: no fields, so nothing is pinned. */
export const CODEX_RIG_PROFILE: Profile = {
  name: "build",
  description: "The building specialist",
  backend: backendId("codex"),
  fields: {},
  systemPrompt: "Build it.",
};

/** A start request with the four fixed facts already filled in. */
export function codexRigRequest(
  overrides: Partial<StartRequest> = {},
): StartRequest {
  return {
    agent: CODEX_RIG_PROFILE.name,
    description: "get it done",
    prompt: "do the thing",
    cwd: "/work",
    childDepth: 1,
    projectTrusted: true,
    ...overrides,
  };
}

export interface CodexRig extends BackendSessionServices {
  readonly sink: FakeNotificationSink;
  readonly counters: RuntimeCounters;
  /** What the App Server was asked to do. */
  readonly standIn: CodexStandInAppServer;
  /** What the adapter is still holding, right now. */
  readonly probe: () => CodexNativeProbe;
  /** Opens, effective closes, and the routing counts. */
  readonly tally: () => CodexAdapterTally;
}

export interface CodexRigOptions extends CodexStandInOptions {
  readonly profiles?: readonly Profile[];
  readonly policy?: RuntimePolicy;
  /** The process environment the child inherits. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestBudgetMillis?: number;
  readonly escalationMillis?: number;
  readonly maxLineLength?: number;
  /** Provide a test clock, for the bounds the adapter keeps on it. */
  readonly testClock?: boolean;
}

export interface CodexSessionOutcome<A> {
  readonly value: A;
  /** Read after the Session Scope closed, which is when it must be clear. */
  readonly probeAfterClose: RuntimeProbe;
  /** The adapter's own probe, read at the same moment. */
  readonly nativeProbeAfterClose: CodexNativeProbe;
  readonly tallyAfterClose: CodexAdapterTally;
  readonly noLeaks: boolean;
}

/** Build a Session over the Codex backend, run a body, and close it. */
export function withCodexSession<A>(
  options: CodexRigOptions,
  body: (rig: CodexRig) => Effect.Effect<A, never, Scope.Scope>,
): Promise<CodexSessionOutcome<A>> {
  const {
    profiles,
    policy,
    env,
    requestBudgetMillis,
    escalationMillis,
    maxLineLength,
    testClock,
    ...standInOptions
  } = options;
  const standIn = createStandInAppServer(standInOptions);
  const sink = createFakeNotificationSink();
  const counters = createRuntimeCounters();

  const handle = createCodexBackend({
    spawn: standIn.spawn,
    // A fixture environment, so no scenario depends on the machine it runs on.
    env: env ?? { PATH: "/usr/bin" },
    ...(requestBudgetMillis === undefined ? {} : { requestBudgetMillis }),
    ...(escalationMillis === undefined ? {} : { escalationMillis }),
    ...(maxLineLength === undefined ? {} : { maxLineLength }),
  });

  return withBackendSession(
    {
      backend: correlateRuns(handle.backend, standIn),
      profiles: {
        from: "list",
        profiles: profiles ?? [CODEX_RIG_PROFILE],
      },
      sink,
      counters,
      ...(policy === undefined ? {} : { policy }),
      ...(testClock === undefined ? {} : { testClock }),
    },
    (services) =>
      body({
        ...services,
        sink,
        counters,
        standIn,
        probe: handle.probe,
        tally: handle.tally,
      }),
  ).then((outcome) => ({
    ...outcome,
    nativeProbeAfterClose: handle.probe(),
    tallyAfterClose: handle.tally(),
  }));
}

/** Wait until the adapter has started its nth Turn. */
export function untilTurnStarted(
  rig: CodexRig,
  index = 0,
): Effect.Effect<void> {
  return until(
    `turn ${index + 1} to start`,
    Effect.sync(() => rig.standIn.record().turns > index),
  );
}

/** Wait until the adapter has written its nth steer. */
export function untilSteered(rig: CodexRig, index = 0): Effect.Effect<void> {
  return until(
    `steer ${index + 1} to be written`,
    Effect.sync(() => rig.standIn.record().steers.length > index),
  );
}

/** Wait until the adapter has written the named method at least this often. */
export function untilWrote(
  rig: CodexRig,
  method: string,
  count = 1,
): Effect.Effect<void> {
  return until(
    `${method} to be written ${count} time(s)`,
    Effect.sync(
      () =>
        rig.standIn.record().methods.filter((each) => each === method).length >=
        count,
    ),
  );
}

/** Wait until the child process has gone. */
export function untilProcessGone(rig: CodexRig): Effect.Effect<void> {
  return until(
    "the App Server to exit",
    Effect.sync(() => !rig.standIn.alive()),
  );
}

/** Wait until a Run is terminal, without sleeping. */
export function untilTerminal(
  rig: CodexRig,
  runId: Parameters<RunRepository["Service"]["lookup"]>[0],
): Effect.Effect<void> {
  return untilRunTerminal(rig.repository, runId);
}

export { quiesce, until } from "../backend-session.ts";
