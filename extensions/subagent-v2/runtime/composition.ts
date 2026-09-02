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
import {
  CompletionDelivery,
  createFakeNotificationSink,
  type NotificationSink,
} from "./delivery.ts";
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

export interface SessionRuntimeOptions {
  readonly backends: readonly Backend[];
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
   * Where completion Notifications go.
   *
   * M3 supplies the real Session push. Until then the default is a fake that
   * records what it was given, so a Session built with no sink still has
   * delivery running rather than silently skipping it.
   */
  readonly sink?: NotificationSink;
  /** Shared with the caller when a test wants to read the probe directly. */
  readonly counters?: RuntimeCounters;
}

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

  const backendCatalog = BackendCatalog.layerOf(options.backends);
  const profileCatalog = (
    options.profiles.from === "directory"
      ? ProfileCatalog.layerOf(options.profiles.agentDir)
      : ProfileCatalog.layerOfProfiles(
          options.profiles.profiles,
          options.profiles.diagnostics ?? [],
        )
  ).pipe(Layer.provide(backendCatalog));

  const resultStore = ResultStore.layerOf(settings.policy);
  const delivery = CompletionDelivery.layerOf(
    settings.policy,
    options.sink ?? createFakeNotificationSink(),
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
