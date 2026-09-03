/**
 * The `codex` backend: the contract's three members, and nothing else public.
 *
 * The factory returns a **handle** rather than a bare `Backend`, for the same
 * reason the Pi and Claude ones do: there is one thing about a real adapter a
 * test and the live lane need that the contract has no place for, and that is
 * whether the adapter is still holding a process, a reader fiber, a pending
 * request, a root thread, or a steer. It hangs off the handle, outside the
 * contract, where only whoever built the backend can reach it.
 *
 * The spawn function is the injection point. The real `codex app-server` is
 * the default; the stand-in is a drop-in, so nothing in the adapter branches
 * on whether it is under test.
 */

import type { Effect, Scope } from "effect";
import {
  type BackendId,
  backendId,
  type Profile,
  type ProfileDiagnostic,
  type SubagentContext,
} from "../../domain/index.ts";
import type { Backend, BackendAgent, BackendOpenFailure } from "../contract.ts";
import { type CodexOpenOptions, openCodexBackendAgent } from "./agent.ts";
import {
  type CodexAdapterTally,
  type CodexNativeProbe,
  createCodexProbeCounters,
  createCodexTallyCounters,
} from "./probe.ts";
import { validateCodexProfile } from "./profile.ts";

/** The name a Profile writes in its `backend` field to reach Codex. */
export const CODEX_BACKEND_ID = "codex";

/** A Codex backend, plus the evidence the contract has no place for. */
export interface CodexBackendHandle {
  readonly backend: Backend;
  /** What the adapter is still holding. Zero once the Session has closed. */
  readonly probe: () => CodexNativeProbe;
  /** Opens, effective closes, and the routing counts. Never zero again. */
  readonly tally: () => CodexAdapterTally;
}

export interface CodexBackendOptions extends CodexOpenOptions {
  /** Overridden only where a second Codex-shaped backend is wanted. */
  readonly id?: BackendId;
}

export function createCodexBackend(
  options: CodexBackendOptions = {},
): CodexBackendHandle {
  // Not injectable: every caller reads them off the handle instead, which is
  // the only way anything outside this module can reach them at all.
  const probe = createCodexProbeCounters();
  const tally = createCodexTallyCounters();
  const backend: Backend = {
    id: options.id ?? backendId(CODEX_BACKEND_ID),
    // No validation context is read: Codex validates a model name itself, so
    // there is no catalogue to check one against and no alias list to compare
    // it with. See `profile.ts`.
    validateProfile: (
      profile: Profile,
      filePath: string,
    ): readonly ProfileDiagnostic[] => validateCodexProfile(profile, filePath),
    open: (
      profile: Profile,
      subagent: SubagentContext,
    ): Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope> =>
      openCodexBackendAgent(profile, subagent, probe, tally, options),
  };
  return { backend, probe: probe.read, tally: tally.read };
}
