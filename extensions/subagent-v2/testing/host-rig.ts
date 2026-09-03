/**
 * One installed v2 extension, a stand-in host, and a Profile directory.
 *
 * Every M3 host test needs the same four things wired together — a stand-in
 * Pi host, a temporary agent directory, a backend set built from the two
 * fakes, and a way to read the runtime probe *after* the Session has gone —
 * and the last of those is why this is shared rather than copied. A probe read
 * while a Session is live proves nothing; a probe read after its Scope closed
 * is the leak assertion the exit gate asks for, and it can only be read
 * through a function captured while the Session still existed.
 *
 * The rig drives the real thing. It installs the real registrations, emits the
 * real host events, and calls the real `execute`. Nothing here reaches past
 * the host boundary into the supervisor, the repository, or the store, with
 * the single exception of the probe — which is a diagnostic rather than a
 * surface, and has nowhere else to come from.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Deferred, Effect } from "effect";
import {
  answeredEnding,
  backendId,
  DEFAULT_BACKEND_ID,
  type Profile,
} from "../domain/index.ts";
import type { AdapterProbe } from "../host/diagnostics-command.ts";
import { installSubagentV2, type SubagentV2Installation } from "../index.ts";
import type { BackendSet } from "../runtime/composition.ts";
import { probeIsClear, type RuntimeProbe } from "../runtime/counters.ts";
import {
  DEFAULT_RUNTIME_POLICY,
  type RuntimePolicy,
} from "../runtime/policy.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import {
  createFakeOneShotBackend,
  createFakeResumableBackend,
  type FakeBackendHandle,
  type FakeBackendOptions,
} from "./fakes/backend.ts";
import {
  emitActivity,
  emitText,
  type FakeStep,
  scripts,
} from "./fakes/script.ts";
import {
  createStandInHost,
  resultText,
  type StandInHost,
  type StandInHostOptions,
  type StandInToolResult,
} from "./stand-in-host.ts";

/** The resumable Profile every rig starts with. */
export const RIG_RESUMABLE_PROFILE = "explore";
/** The one-shot Profile every rig starts with. */
export const RIG_ONE_SHOT_PROFILE = "once";
/** The one-shot backend's id, which the widget row and the card name. */
export const RIG_ONE_SHOT_BACKEND = backendId("one-shot");

/** What a rig Run answers with, unless a test scripts something else. */
export const RIG_ANSWER = "the rig answered";
/** What a rig Run reports it is doing, so a widget row has a tail. */
export const RIG_ACTIVITY = "looking around";

/** The instant a rig's widget renders at, so a row's duration is fixed. */
export const RIG_NOW = 1_000_000;

/** One Run that reports activity, answers, and completes. */
export const RIG_RUN: readonly FakeStep[] = [
  emitActivity(RIG_ACTIVITY),
  emitText(RIG_ANSWER),
  { step: "cumulative-usage", total: { input: 12, output: 8 } },
  { step: "complete", ending: answeredEnding() },
];

/** How many Runs a rig backend is scripted for when a test says nothing. */
const DEFAULT_SCRIPTED_RUNS = 8;

/**
 * The defaults, with one push attempt and no delay between attempts.
 *
 * The real budget waits a second between attempts on the runtime clock, and no
 * test in this lane lets real time pass. Delivery's own retry is proven at the
 * M2 seam with a test clock; what a host test is about is what happens *after*
 * a push, which is landing.
 */
export const RIG_POLICY: RuntimePolicy = {
  ...DEFAULT_RUNTIME_POLICY,
  deliveryRetryBudget: { attempts: 1, delayMillis: 0 },
};

export interface HostRigOptions extends StandInHostOptions {
  /** One script per resumable Run, consumed in order. */
  readonly resumableSteps?: readonly (readonly FakeStep[])[];
  /** One script per one-shot Run, consumed in order. */
  readonly oneShotSteps?: readonly (readonly FakeStep[])[];
  /** Profiles the backend set supplies. Defaults to one per fake. */
  readonly profiles?: readonly Profile[];
  /** Profile files to write into the agent directory before the Session starts. */
  readonly profileFiles?: Readonly<Record<string, string>>;
  /** A shared ordering log the fakes append their lifecycle events to. */
  readonly trace?: string[];
  /**
   * The bounds the Session enforces.
   *
   * A test that proves what happens at a bound has to be able to lower it. The
   * delivery retry budget is the one most tests here want to change, because
   * its default waits a second between attempts on the runtime clock and no
   * test in this lane lets real time pass.
   */
  readonly policy?: RuntimePolicy;
  /**
   * What the resumable fake reports from `validateProfile`.
   *
   * The `BackendValidationContext` it is handed is the Session's own — its
   * model catalogue among it — so a test can assert that what the host read
   * from the live Session reached the backend that needed it.
   */
  readonly diagnose?: FakeBackendOptions["diagnose"];
  /**
   * What the backend adapters report as still held, one block per backend.
   *
   * Supplied here because the diagnostics command reads it through the entry
   * point rather than through the runtime, so a test that wants to see both
   * blocks in the report has nowhere else to put them.
   */
  readonly adapterProbe?: () => AdapterProbe;
  /** Make the set report that this process is loading inside a child. */
  readonly childLoad?: boolean;
  /** What depth the set reports, for the nesting guard and for admission. */
  readonly childDepth?: number;
}

export interface HostRig {
  readonly host: StandInHost;
  readonly installation: SubagentV2Installation;
  /** The two fakes this rig built, for counter evidence. */
  readonly resumable: FakeBackendHandle;
  readonly oneShot: FakeBackendHandle;
  /** Where user Profiles are read from. */
  readonly agentsDir: string;

  /** Call a tool and return the text a model would read. */
  readonly text: (
    name: string,
    params: unknown,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<string>;
  /** Call a tool and return the whole result, details included. */
  readonly call: StandInHost["call"];

  /**
   * Give the Session's fibers turns to run, without letting real time pass.
   *
   * The reducer, the settlement coordinator, and the widget's subscriber are
   * all fibers, and a host call that returns does not mean they have caught
   * up. Where a test asserts on something they produce — a widget row, a
   * counter — it has to let them run first, and yielding is how that is done
   * with no clock involved.
   */
  readonly pump: (turns?: number) => Promise<void>;

  /** A gate the fakes can wait on, created on first mention. */
  readonly gate: (name: string) => Deferred.Deferred<void>;
  /** Release a gate, letting whatever waits on it continue. */
  readonly release: (name: string) => Promise<void>;

  /**
   * Read the probe as it is right now, through the live Session.
   *
   * Also captures the reader, so {@link probeAfterShutdown} can be answered
   * once the Session is gone.
   */
  readonly probe: () => Promise<RuntimeProbe>;
  /**
   * The probe after the Session Scope closed, which is when it must be zero.
   *
   * Requires {@link probe} to have been called at least once while the Session
   * was live, because the reader can only be captured from inside it.
   */
  readonly probeAfterShutdown: () => RuntimeProbe;
  readonly noLeaks: () => boolean;
}

const ZERO_PROBE: RuntimeProbe = {
  liveRunFibers: 0,
  liveReducerFibers: 0,
  openObservationQueues: 0,
  openMailboxes: 0,
  unresolvedWaiters: 0,
  repositorySubscriptions: 0,
  openBackendAgents: 0,
};

function defaultProfiles(oneShotId: string): readonly Profile[] {
  return [
    {
      name: RIG_RESUMABLE_PROFILE,
      description: "The explore specialist",
      backend: DEFAULT_BACKEND_ID,
      fields: {},
      systemPrompt: "Explore.",
    },
    {
      name: RIG_ONE_SHOT_PROFILE,
      description: "The one-shot specialist",
      backend: backendId(oneShotId),
      fields: {},
      systemPrompt: "Answer once.",
    },
  ];
}

/**
 * Build a rig, and register its cleanup.
 *
 * The temporary agent directory is removed after the test; the Session is not
 * shut down for it, because whether shutdown happened is exactly what several
 * of these tests are about.
 */
export function hostRig(
  t: { after(fn: () => void | Promise<void>): void },
  options: HostRigOptions = {},
): HostRig {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-v2-host-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [name, body] of Object.entries(options.profileFiles ?? {})) {
    fs.writeFileSync(path.join(agentsDir, name), body);
  }

  /**
   * Every gate a script mentions, created the first time it is asked for.
   *
   * A proxy rather than a map a test has to populate, because the fake looks
   * its gates up by name from a plain object at execution time and throws for
   * one it cannot find — and a test whose gate did not exist yet would see the
   * Run fail for a reason that has nothing to do with what it is testing. With
   * the proxy, mentioning a gate in a script is all it takes to have one.
   */
  const gates = new Proxy({} as Record<string, Deferred.Deferred<void>>, {
    get: (target, name: string) => {
      target[name] ??= Effect.runSync(Deferred.make<void>());
      return target[name];
    },
  });
  const gate = (name: string): Deferred.Deferred<void> => gates[name];

  const perRun = (
    steps: readonly (readonly FakeStep[])[] | undefined,
  ): ReturnType<typeof scripts> =>
    scripts(
      ...(steps ??
        Array.from({ length: DEFAULT_SCRIPTED_RUNS }, () => RIG_RUN)),
    );

  const resumable = createFakeResumableBackend({
    scripts: perRun(options.resumableSteps),
    id: DEFAULT_BACKEND_ID,
    gates,
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
  });
  const oneShot = createFakeOneShotBackend({
    scripts: perRun(options.oneShotSteps),
    id: RIG_ONE_SHOT_BACKEND,
    gates,
    ...(options.trace === undefined ? {} : { trace: options.trace }),
  });

  const backendSet = (): BackendSet => ({
    name: "rig",
    backends: [resumable.backend, oneShot.backend],
    profiles: options.profiles ?? defaultProfiles(RIG_ONE_SHOT_BACKEND),
    // A fake spawns no child, so the guard is a test's to control: a rig can
    // say the process looks like a child, or that it is nested, and assert
    // that the entry point registers nothing.
    isChildLoad: () => options.childLoad === true,
    childDepth: () => options.childDepth ?? 0,
  });

  const host = createStandInHost(options);
  const installation = installSubagentV2(host.pi, {
    agentDir: root,
    backendSet,
    now: () => RIG_NOW,
    policy: options.policy ?? RIG_POLICY,
    ...(options.adapterProbe === undefined
      ? {}
      : { probe: options.adapterProbe }),
  });

  let readProbe: (() => RuntimeProbe) | undefined;

  const probe = async (): Promise<RuntimeProbe> => {
    const reader = await installation.handle.run(
      Effect.map(SubagentSupervisor, (supervisor) => supervisor.probe),
      () => ZERO_PROBE,
    );
    readProbe = reader;
    return reader();
  };

  const probeAfterShutdown = (): RuntimeProbe => {
    if (!readProbe) {
      throw new Error(
        "the probe reader was never captured; call probe() while the Session is live",
      );
    }
    return readProbe();
  };

  return {
    host,
    installation,
    resumable,
    oneShot,
    agentsDir,
    call: host.call,
    text: async (name, params, callOptions) =>
      resultText(
        (await host.call(name, params, callOptions)) as StandInToolResult,
      ),
    pump: (turns = 40) =>
      installation.handle.run(
        Effect.forEach(
          Array.from({ length: turns }, (_unused, index) => index),
          () => Effect.yieldNow,
          { discard: true },
        ),
        undefined,
      ),
    gate,
    release: (name) =>
      Effect.runPromise(Effect.asVoid(Deferred.succeed(gate(name), undefined))),
    probe,
    probeAfterShutdown,
    noLeaks: () => probeIsClear(probeAfterShutdown()),
  };
}

/**
 * The ids `agent_start` returned, read out of its prose.
 *
 * Read from the text rather than from a detail field, deliberately: the text
 * is what a model gets, so a test that could not find the ids in it would be a
 * test passing where a model would be stuck.
 */
export function startedIds(text: string): {
  readonly subagentId: string;
  readonly runId: string;
} {
  const subagentId = /subagent id (\S+)/.exec(text)?.[1];
  const runId = /run id (\S+)/.exec(text)?.[1];
  if (!subagentId || !runId) {
    throw new Error(`no ids in the start outcome:\n${text}`);
  }
  return { subagentId, runId };
}
