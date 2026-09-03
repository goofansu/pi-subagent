/**
 * One Session runtime with the real Pi backend behind it.
 *
 * The shared conformance suite already drives the adapter through every
 * provider-neutral scenario. This is for the ones that are *Pi's*: the spike's
 * findings, and the cells of the compatibility matrix that only mean something
 * for a retained in-process session. Those need to drive the supervisor
 * directly and then look at what the native session was actually asked to do,
 * which is what the record is for.
 *
 * The Session wiring itself is shared with the other adapters' rigs in
 * `testing/backend-session.ts`, so what is left here is only what is Pi's: the
 * stand-in, the two factories it is injected through, the temporary agent
 * directory a Profile-loading scenario needs, and the adapter's own probe.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Scope } from "effect";
import { Effect } from "effect";
import {
  createPiBackend,
  type PiNativeProbe,
  type PiSessionOptions,
} from "../../backend/pi/index.ts";
import { DEFAULT_BACKEND_ID, type Profile } from "../../domain/index.ts";
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
import {
  createFakeNotificationSink,
  type FakeNotificationSink,
} from "../fake-sink.ts";
import { correlateRuns } from "./correlate.ts";
import {
  createStandInPiSession,
  type PiScript,
  type StandInPiSession,
} from "./stand-in-session.ts";

/** The Profile every Pi rig starts with: no fields, so nothing is pinned. */
export const PI_RIG_PROFILE: Profile = {
  name: "explore",
  description: "The explore specialist",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Explore.",
};

/** A start request with the four fixed facts already filled in. */
export function piRigRequest(
  overrides: Partial<StartRequest> = {},
): StartRequest {
  return {
    agent: PI_RIG_PROFILE.name,
    description: "look around",
    prompt: "have a look",
    cwd: "/work",
    childDepth: 1,
    projectTrusted: true,
    ...overrides,
  };
}

export interface PiRig extends BackendSessionServices {
  readonly sink: FakeNotificationSink;
  readonly counters: RuntimeCounters;
  /** What the native session was asked to do. */
  readonly standIn: StandInPiSession;
  /** What the adapter is still holding, right now. */
  readonly probe: () => PiNativeProbe;
  /** How many native sessions the factory was asked for. */
  readonly opens: () => number;
}

export interface PiRigOptions {
  /** One script per prompt, consumed in order. */
  readonly scripts?: readonly PiScript[];
  readonly profiles?: readonly Profile[];
  readonly policy?: RuntimePolicy;
  /** Models the Session's catalogue holds, for Profile validation. */
  readonly models?: readonly {
    readonly provider: string;
    readonly id: string;
  }[];
  /** Make the session factory refuse, which is how an open fails. */
  readonly openFails?: boolean;
  /** Never resolve the session factory, so the open budget decides. */
  readonly openHangs?: boolean;
  /**
   * Profile files to write, so the Session validates them the way it does on
   * disk.
   *
   * Validation runs only for a Profile the Session *loaded*, so a scenario
   * about a rejected Profile has to supply a file rather than a value: a list
   * of Profiles handed straight to the catalog is one that has already been
   * accepted.
   */
  readonly profileFiles?: Readonly<Record<string, string>>;
  /** Registers the temporary directory's cleanup. */
  readonly cleanup?: { after(fn: () => void): void };
}

export interface PiSessionOutcome<A> {
  readonly value: A;
  /** Read after the Session Scope closed, which is when it must be clear. */
  readonly probeAfterClose: RuntimeProbe;
  /** The adapter's own probe, read at the same moment. */
  readonly nativeProbeAfterClose: PiNativeProbe;
  readonly noLeaks: boolean;
}

/**
 * A temporary agent directory holding the Profile files a scenario needs.
 *
 * `undefined` when a scenario supplies Profiles directly, which is what most
 * of them do: writing files is only necessary when what is under test is the
 * loading and validation a Session performs on them.
 */
function profileDirectoryFor(options: PiRigOptions): string | undefined {
  const files = options.profileFiles;
  if (files === undefined) return undefined;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-v2-pi-rig-")),
  );
  options.cleanup?.after(() =>
    fs.rmSync(root, { recursive: true, force: true }),
  );
  const agents = path.join(root, "agents");
  fs.mkdirSync(agents, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(agents, name), body);
  }
  return root;
}

/** Build a Session over the Pi backend, run a body against it, and close it. */
export function withPiSession<A>(
  options: PiRigOptions,
  body: (rig: PiRig) => Effect.Effect<A, never, Scope.Scope>,
): Promise<PiSessionOutcome<A>> {
  const standIn = createStandInPiSession({ scripts: options.scripts ?? [] });
  const sink = createFakeNotificationSink();
  const counters = createRuntimeCounters();
  let opens = 0;

  const handle = createPiBackend({
    sessionFactory: async () => {
      if (options.openFails) throw new Error("the stand-in refused to open");
      if (options.openHangs) await new Promise<never>(() => {});
      opens += 1;
      return { session: standIn.session };
    },
    sessionOptionsFactory: async () => ({}) as PiSessionOptions,
  });

  const agentDir = profileDirectoryFor(options);

  return withBackendSession(
    {
      backend: correlateRuns(handle.backend, standIn),
      profiles:
        agentDir === undefined
          ? { from: "list", profiles: options.profiles ?? [PI_RIG_PROFILE] }
          : { from: "directory", agentDir },
      sink,
      counters,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.models === undefined ? {} : { models: options.models }),
    },
    (services) =>
      body({
        ...services,
        sink,
        counters,
        standIn,
        probe: handle.probe,
        opens: () => opens,
      }),
  ).then((outcome) => ({
    ...outcome,
    nativeProbeAfterClose: handle.probe(),
  }));
}

/** Wait until the native session has begun its nth prompt. */
export function untilPrompted(rig: PiRig, index = 0): Effect.Effect<void> {
  return until(
    `prompt ${index + 1} to begin`,
    Effect.sync(() => rig.standIn.record().prompts > index),
  );
}

/** Wait until the native session has received its nth steer. */
export function untilSteered(rig: PiRig, index = 0): Effect.Effect<void> {
  return until(
    `steer ${index + 1} to arrive`,
    Effect.sync(() => rig.standIn.record().steers.length > index),
  );
}

/** Wait until a Run is terminal, without sleeping. */
export function untilTerminal(
  rig: PiRig,
  runId: Parameters<RunRepository["Service"]["lookup"]>[0],
): Effect.Effect<void> {
  return untilRunTerminal(rig.repository, runId);
}

export { quiesce, until } from "../backend-session.ts";
