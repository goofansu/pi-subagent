/**
 * One managed Effect runtime per Pi Session, composed here and nowhere else.
 *
 * Six services, a policy value, and a clock. That is the whole session-long
 * surface, and the number is deliberately small: the roadmap's rule is to keep
 * session-long services few and start with these six, because every service is
 * a thing that has to be wired, provided, and torn down in the right order.
 *
 * What is *not* a Layer matters more than what is. No Subagent, no
 * BackendAgent, and no Run is a Layer (ADR-0023). Those have lifetimes shorter
 * than the Session, and a Layer whose lifetime is shorter than the runtime it
 * belongs to is a Layer that has to be rebuilt — which is how v1's lifecycle
 * machinery grew. They are Scopes instead, nested under the Session Scope, and
 * closing the Session Scope closes all of them in reverse acquisition order.
 *
 * The boundary test enforces the other half of that rule: `Layer` may be
 * imported only by this module and the service definitions it wires.
 */

import { Layer } from "effect";
import type { Backend } from "../backend/contract.ts";
import type { Profile, ProfileDiagnostic } from "../domain/index.ts";
import { BackendCatalog } from "./backend-catalog.ts";
import { createRuntimeCounters, type RuntimeCounters } from "./counters.ts";
import { CompletionDelivery, type NotificationSink } from "./delivery.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";
import { ProfileCatalog } from "./profile-catalog.ts";
import { RunRepository } from "./repository.ts";
import { ResultStore } from "./result-store.ts";
import { type SessionSettings, SubagentSupervisor } from "./supervisor.ts";

/** Every service the Session runtime provides. */
export type SessionServices =
  | BackendCatalog
  | ProfileCatalog
  | RunRepository
  | ResultStore
  | CompletionDelivery
  | SubagentSupervisor;

/** How deeply a Subagent may itself delegate, when nothing says otherwise. */
export const DEFAULT_MAX_DELEGATION_DEPTH = 2;

/**
 * A named set of backends, with the Profiles that ship with it.
 *
 * A Session is built from one set, and the set is what decides which backends
 * exist and which Profiles a user gets for free. M3's set is the **demo set**:
 * the two fakes, and one Profile per fake, so launching Pi with only the v2
 * entry point gives a working extension with nothing to configure. M4 replaces
 * it with a set containing the real Pi backend, and the demo Profiles go with
 * it.
 *
 * A set is a value rather than a service. Nothing about it is decided at run
 * time, and a Session that could change its backends half-way through would be
 * a Session whose Subagents disagreed about what they were.
 */
export interface BackendSet {
  /** What the set is called, for the start-up diagnostic. */
  readonly name: string;
  readonly backends: readonly Backend[];
  /** Profiles the set supplies, merged under the user's own. */
  readonly profiles: readonly Profile[];
}

/**
 * Where a Session's backends come from.
 *
 * Two forms, and exactly one may be given — the type says so rather than a
 * runtime check. A **list** is what a test has: the fakes it built for one
 * scenario, with the Profiles the scenario needs supplied directly. A **set**
 * is what a Session has, and it brings its own Profiles.
 */
export type BackendSource =
  | { readonly backends: readonly Backend[]; readonly backendSet?: never }
  | { readonly backendSet: BackendSet; readonly backends?: never };

interface SessionRuntimeBaseOptions {
  /**
   * Where Profiles come from.
   *
   * A directory is what a real Session has. A list is what a test has, and it
   * is not a lesser path: the conformance suite supplies the Profiles a
   * scenario needs directly rather than writing files for them.
   */
  readonly profiles:
    | { readonly from: "directory"; readonly agentDir: string }
    | {
        readonly from: "list";
        readonly profiles: readonly Profile[];
        readonly diagnostics?: readonly ProfileDiagnostic[];
      };
  readonly policy?: RuntimePolicy;
  readonly maxDelegationDepth?: number;
  /**
   * Where completion Notifications go. Required, and deliberately so.
   *
   * M3 supplies the real Session push; until then every caller is a test and
   * passes its own fake. A default would mean a Session built without a sink
   * delivered into something that discarded, and looked like it was working.
   */
  readonly sink: NotificationSink;
  /** Shared with the caller when a test wants to read the probe directly. */
  readonly counters?: RuntimeCounters;
}

export type SessionRuntimeOptions = SessionRuntimeBaseOptions & BackendSource;

/**
 * Build the Session runtime's Layer.
 *
 * The wiring is a chain rather than a merge, because the order is real: the
 * Profile catalog validates through the backend catalog, and the supervisor
 * needs all four of the others. `Layer.provideMerge` keeps each one visible to
 * the caller as well as to the layer above it, so a test can reach the
 * repository or the store directly to assert on what the supervisor did.
 */
export function sessionRuntimeLayer(
  options: SessionRuntimeOptions,
): Layer.Layer<SessionServices> {
  const counters = options.counters ?? createRuntimeCounters();
  const settings: SessionSettings = {
    policy: options.policy ?? DEFAULT_RUNTIME_POLICY,
    maxDelegationDepth:
      options.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH,
    counters,
  };

  const backends = options.backendSet?.backends ?? options.backends ?? [];
  const builtInProfiles = options.backendSet?.profiles ?? [];

  const backendCatalog = BackendCatalog.layerOf(backends);
  const profileCatalog = (
    options.profiles.from === "directory"
      ? ProfileCatalog.layerOf(options.profiles.agentDir, builtInProfiles)
      : ProfileCatalog.layerOfProfiles(
          [...builtInProfiles, ...options.profiles.profiles],
          options.profiles.diagnostics ?? [],
        )
  ).pipe(Layer.provide(backendCatalog));

  const resultStore = ResultStore.layerOf(settings.policy, counters);
  const delivery = CompletionDelivery.layerOf(
    settings.policy,
    options.sink,
    counters,
  ).pipe(Layer.provideMerge(resultStore));

  const foundation = Layer.mergeAll(
    backendCatalog,
    profileCatalog,
    RunRepository.layerOf(counters),
    delivery,
  );

  return SubagentSupervisor.layerOf(settings).pipe(
    Layer.provideMerge(foundation),
  );
}
