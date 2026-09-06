/**
 * The scripted fake backends.
 *
 * One implementation, two declared capability sets. `FakeResumableBackend`
 * declares resume, steering, and a terminal transcript snapshot;
 * `FakeOneShotBackend` declares none of the three. Sharing the script runner
 * between them is deliberate: the two fakes must differ *only* in what they
 * declare, or a capability test could pass because the two fakes were written
 * differently rather than because the core enforced anything.
 *
 * What the resumable fake retains between Runs is what makes the usage rules
 * testable: a message history it can replay, and a **provider-cumulative**
 * token total it never exposes across the boundary. It reports Run-local
 * deltas by differencing that total against a baseline it takes when each Run
 * starts — which is exactly what a real adapter over a cumulative provider
 * does, and what makes "a resumed Run is not charged for the previous one" a
 * real assertion rather than a tautology.
 *
 * Its provider identity exists only after its first Run has started, so the
 * unopened-BackendAgent state from ADR-0023 is exercised without a third fake.
 */

import { Deferred, Effect } from "effect";
import type {
  Backend,
  BackendAgent,
  BackendCapabilities,
  BackendOpenFailure,
  BackendValidationContext,
  ExecutionIO,
  ResumeAdmission,
  RunInput,
  TerminalBundle,
} from "../../backend/contract.ts";
import {
  answeredEnding,
  type BackendId,
  backendId,
  failedEnding,
  type Profile,
  type ProfileDiagnostic,
  type RunObservation,
  redactedDiagnostic,
  runDiagnostic,
  type TranscriptItem,
  usageDelta,
} from "../../domain/index.ts";
import {
  createResourceCounters,
  type ResourceCountersSnapshot,
} from "./counters.ts";
import type {
  CumulativeUsage,
  FakeOpenScript,
  FakeRunScript,
} from "./script.ts";

const CUMULATIVE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const;

type CumulativeTotals = { [K in (typeof CUMULATIVE_FIELDS)[number]]: number };

const EMPTY_CUMULATIVE: CumulativeTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export interface FakeBackendOptions {
  /** One script per Run, consumed in order. */
  readonly scripts: readonly FakeRunScript[];
  /** How the fake behaves when it is opened. Succeeds unless a test says so. */
  readonly open?: FakeOpenScript;
  /** Violate the contract by throwing before an execution Effect is returned. */
  readonly executeThrowsSynchronously?: boolean;
  /** Zero-based executions on which to violate the contract synchronously. */
  readonly executeThrowsSynchronouslyAt?: readonly number[];
  /** Gates the scripts wait on, owned and completed by the test. */
  readonly gates?: Readonly<Record<string, Deferred.Deferred<void>>>;
  /** A shared ordering log. The fake appends its own lifecycle events. */
  readonly trace?: string[];
  /** Hold BackendAgent close at a named gate for cleanup-budget tests. */
  readonly close?: {
    readonly gate: string;
    readonly uninterruptible?: boolean;
  };
  readonly id?: BackendId;
  /**
   * What `validateProfile` reports, so validation scenarios can vary it.
   *
   * Handed the `BackendValidationContext` as well as the Profile, because the
   * Session's model catalogue reaches a backend through exactly that argument
   * and a fake that dropped it could not prove the catalogue arrived.
   */
  readonly diagnose?: (
    profile: Profile,
    filePath: string,
    context?: BackendValidationContext,
  ) => readonly ProfileDiagnostic[];
}

/** A fake backend plus the evidence a test needs about its internals. */
export interface FakeBackendHandle {
  readonly backend: Backend;
  readonly counters: () => ResourceCountersSnapshot;
  /**
   * The provider-cumulative total the fake keeps to itself.
   *
   * Exposed to tests as *evidence*, never across the contract: no observation
   * the fake emits carries it. A usage test compares this against the Run's
   * reported total to prove the difference was taken.
   */
  readonly cumulativeTotals: () => CumulativeTotals;
  /** Whether a provider identity exists yet. False until the first Run starts. */
  readonly identityAcquired: () => boolean;
  /** The conversation the fake retains, if it retains one. */
  readonly history: () => readonly TranscriptItem[];
}

function totalsOf(
  usage: CumulativeUsage,
  from: CumulativeTotals,
): CumulativeTotals {
  return {
    input: usage.input ?? from.input,
    output: usage.output ?? from.output,
    cacheRead: usage.cacheRead ?? from.cacheRead,
    cacheWrite: usage.cacheWrite ?? from.cacheWrite,
  };
}

/** The difference between two cumulative readings, never negative. */
function difference(
  now: CumulativeTotals,
  since: CumulativeTotals,
): CumulativeTotals {
  return {
    input: Math.max(0, now.input - since.input),
    output: Math.max(0, now.output - since.output),
    cacheRead: Math.max(0, now.cacheRead - since.cacheRead),
    cacheWrite: Math.max(0, now.cacheWrite - since.cacheWrite),
  };
}

function createFakeBackend(
  capabilities: BackendCapabilities,
  options: FakeBackendOptions,
): FakeBackendHandle {
  const counters = createResourceCounters();
  const trace = options.trace ?? [];
  const gates = options.gates ?? {};
  let cumulative: CumulativeTotals = { ...EMPTY_CUMULATIVE };
  let identityAcquired = false;
  let history: TranscriptItem[] = [];

  const gate = (name: string): Deferred.Deferred<void> => {
    const deferred = gates[name];
    if (!deferred) {
      throw new Error(
        `the script waits on gate '${name}', which the test did not create`,
      );
    }
    return deferred;
  };

  const openAgent = (): BackendAgent => {
    let runIndex = 0;
    let closed = false;
    let conversationLost = false;

    const admitResume = (): ResumeAdmission => {
      if (!capabilities.resume) return "unsupported";
      // No provider identity yet means there is nothing to resume. ADR-0023's
      // unopened BackendAgent reports it through this outcome rather than
      // through a fourth one.
      if (closed || conversationLost || !identityAcquired) {
        return "conversation lost";
      }
      return "admitted";
    };

    const execute = (
      input: RunInput,
      io: ExecutionIO,
    ): Effect.Effect<TerminalBundle, never, import("effect").Scope.Scope> => {
      if (
        options.executeThrowsSynchronously ||
        options.executeThrowsSynchronouslyAt?.includes(runIndex)
      ) {
        throw new Error("the fake execute threw synchronously");
      }
      return Effect.gen(function* () {
        counters.executionFiberStarted();
        // ADR-0023 exception 3: a closed scope is enforced by the backend's own
        // state, never by trusting a provider to reject work after disposal.
        if (closed) {
          return { ending: failedEnding("the BackendAgent is closed") };
        }
        const script: FakeRunScript | undefined = options.scripts[runIndex];
        runIndex += 1;
        if (!script) {
          return {
            ending: failedEnding(`no script for run ${runIndex}`),
          };
        }

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            counters.executionStarted();
            identityAcquired = true;
            trace.push(`execution-started:${input.runId}`);
          }),
          () =>
            Effect.sync(() => {
              counters.executionReleased();
              trace.push(`execution-released:${input.runId}`);
            }),
        );
        // A per-execution event subscription, the thing a real adapter attaches
        // for one Run and must not leave attached.
        yield* Effect.acquireRelease(
          Effect.sync(() => void counters.subscriptionAcquired()),
          () => Effect.sync(() => void counters.subscriptionReleased()),
        );

        if (!capabilities.resume) {
          // A one-shot backend retains nothing between Runs.
          history = [];
          cumulative = { ...EMPTY_CUMULATIVE };
        }
        // The Run's baseline: the provider's cumulative reading at the moment
        // this Run started. Every delta this Run reports is measured from
        // here, which is what keeps a resumed Run off the previous Run's bill.
        let reported: CumulativeTotals = { ...cumulative };

        const remember = (observation: RunObservation): void => {
          if (observation.kind !== "message") return;
          history.push({
            role: observation.role,
            parts: observation.parts,
            ...(observation.model === undefined
              ? {}
              : { model: observation.model }),
          });
        };

        let bundle: TerminalBundle | undefined;
        for (const step of script.steps) {
          switch (step.step) {
            case "emit": {
              remember(step.observation);
              yield* io.emit(step.observation);
              break;
            }
            case "announce-ending": {
              yield* io.emit({ kind: "ending", ending: step.ending });
              break;
            }
            case "await-gate": {
              yield* Deferred.await(gate(step.gate));
              break;
            }
            case "await-control": {
              const control = yield* io.controls.take;
              if (control === undefined) break;
              counters.controlStarted(input.runId, control.text);
              if (step.confirm) {
                // Only authoritative provider evidence becomes an observation.
                // This step is the script saying the provider gave it.
                const observation: RunObservation = {
                  kind: "message",
                  role: "user",
                  parts: [{ kind: "text", text: control.text }],
                };
                remember(observation);
                yield* io.emit(observation);
              }
              counters.controlFinished();
              break;
            }
            case "result-then-quiet": {
              const control = capabilities.steer
                ? yield* io.controls.take
                : undefined;
              if (control !== undefined) {
                counters.controlStarted(input.runId, control.text);
              }
              yield* Effect.gen(function* () {
                // The provider has reported its result and now contributes no
                // event capable of releasing this wait. Only the adapter's
                // runtime-clock bound can move the execution forward.
                yield* Effect.exit(
                  Effect.timeout(Effect.never, step.waitMillis),
                );
                yield* io.emit({
                  kind: "diagnostic",
                  diagnostic: runDiagnostic(
                    "control",
                    "guidance was not delivered",
                  ),
                });
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (control !== undefined) counters.controlFinished();
                  }),
                ),
              );
              bundle = { ending: answeredEnding() };
              break;
            }
            case "cumulative-usage": {
              cumulative = totalsOf(step.total, cumulative);
              const delta = difference(cumulative, reported);
              reported = { ...cumulative };
              yield* io.emit({
                kind: "usage",
                usage: usageDelta({ ...delta, turns: 1 }),
              });
              break;
            }
            case "echo-prompt": {
              // The one step that reads the Run's input. Everything else a
              // script says is decided before the Run exists.
              const observation: RunObservation = {
                kind: "message",
                role: "assistant",
                parts: [
                  {
                    kind: "text",
                    text: `${step.prefix ?? ""}${input.prompt}`,
                  },
                ],
              };
              remember(observation);
              yield* io.emit(observation);
              break;
            }
            case "replay-history": {
              // A provider replaying the conversation. It carries no usage:
              // replay is not new work.
              for (const item of [...history]) {
                yield* io.emit({
                  kind: "message",
                  role: item.role,
                  parts: item.parts,
                  ...(item.model === undefined ? {} : { model: item.model }),
                });
              }
              break;
            }
            case "complete": {
              bundle = {
                ending: step.ending ?? answeredEnding(),
                ...(step.reconciliation === undefined
                  ? {}
                  : { reconciliation: step.reconciliation }),
              };
              break;
            }
            case "fail": {
              bundle = { ending: failedEnding(step.message) };
              break;
            }
            case "defect": {
              return yield* Effect.die(new Error(step.message));
            }
            case "hang": {
              yield* Effect.never;
              break;
            }
            case "hang-on-stop": {
              // Unlike `hang-in-finalizer`, this release belongs to the
              // execution fiber itself. Interruption starts it
              // uninterruptibly and it never returns: the Pi shape that the
              // Run Scope must bound before native-scope cleanup begins.
              yield* Effect.acquireUseRelease(
                Effect.void,
                () => Effect.never,
                () => Effect.never,
              );
              break;
            }
            case "emit-in-finalizer": {
              const late = step.observation;
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.gen(function* () {
                  trace.push(`finalizer-emitting:${input.runId}`);
                  yield* io.emit(late);
                }),
              );
              break;
            }
            case "gate-the-finalizer": {
              const held = gate(step.gate);
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.gen(function* () {
                  trace.push(`finalizer-waiting:${input.runId}`);
                  yield* Deferred.await(held);
                  trace.push(`finalizer-released:${input.runId}`);
                }),
              );
              break;
            }
            case "hang-in-finalizer": {
              // Acquired now, released never. Closing the execution scope
              // waits on this forever, which is what the cleanup budget and
              // its escalation are for.
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  trace.push(`finalizer-armed:${input.runId}`);
                }),
                () =>
                  Effect.gen(function* () {
                    trace.push(`finalizer-hanging:${input.runId}`);
                    yield* Effect.never;
                  }),
              );
              break;
            }
            case "lose-conversation": {
              conversationLost = true;
              break;
            }
          }
        }
        // A script that named no ending answered: the observations are what it
        // had to say, and it said them all.
        return bundle ?? { ending: answeredEnding() };
      }).pipe(
        Effect.ensuring(Effect.sync(() => counters.executionFiberReleased())),
      );
    };

    return {
      capabilities,
      admitResume,
      execute,
      close: () =>
        Effect.gen(function* () {
          // Idempotent: closing twice counts once and does nothing twice.
          if (closed) return;
          if (options.close !== undefined) {
            trace.push("agent-close-waiting");
            const wait = Deferred.await(gate(options.close.gate));
            yield* options.close.uninterruptible
              ? Effect.uninterruptible(wait)
              : wait;
          }
          if (closed) return;
          closed = true;
          counters.closed();
          trace.push("agent-closed");
        }),
    };
  };

  const openScript: FakeOpenScript = options.open ?? { open: "succeeds" };

  const backend: Backend = {
    id: options.id ?? backendId("fake"),
    validateProfile: (profile, filePath, context) =>
      options.diagnose?.(profile, filePath, context) ?? [],
    open: (): Effect.Effect<
      BackendAgent,
      BackendOpenFailure,
      import("effect").Scope.Scope
    > =>
      Effect.gen(function* () {
        if (openScript.open === "fails") {
          trace.push(`agent-open-failed:${openScript.reason}`);
          // The reason is the fake's own provider text, and it stops here.
          // What crosses is the category, exactly as a real adapter's would.
          return yield* Effect.fail<BackendOpenFailure>({
            diagnostic: redactedDiagnostic("backend-failure"),
          });
        }
        if (openScript.open === "hangs") {
          trace.push("agent-open-hanging");
          yield* openScript.gate === undefined
            ? Effect.never
            : Deferred.await(gate(openScript.gate));
        }
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            counters.opened();
            trace.push("agent-opened");
            return openAgent();
          }),
          (agent) => agent.close(),
        );
      }),
  };

  return {
    backend,
    counters: () => counters.snapshot(),
    cumulativeTotals: () => ({ ...cumulative }),
    identityAcquired: () => identityAcquired,
    history: () => [...history],
  };
}

export const RESUMABLE_CAPABILITIES: BackendCapabilities = {
  resume: true,
  steer: true,
  terminalTranscriptSnapshot: true,
};

export const ONE_SHOT_CAPABILITIES: BackendCapabilities = {
  resume: false,
  steer: false,
  terminalTranscriptSnapshot: false,
};

/** Declares resume, steering, and a terminal transcript snapshot. */
export function createFakeResumableBackend(
  options: FakeBackendOptions,
): FakeBackendHandle {
  return createFakeBackend(RESUMABLE_CAPABILITIES, {
    id: backendId("fake-resumable"),
    ...options,
  });
}

/** Declares none of the three capabilities and retains nothing. */
export function createFakeOneShotBackend(
  options: FakeBackendOptions,
): FakeBackendHandle {
  return createFakeBackend(ONE_SHOT_CAPABILITIES, {
    id: backendId("fake-one-shot"),
    ...options,
  });
}
