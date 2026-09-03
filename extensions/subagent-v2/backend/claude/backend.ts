/**
 * The `claude` backend: the contract's three members, and nothing else public.
 *
 * The factory returns a **handle** rather than a bare `Backend`, for the same
 * reason the Pi one does: there is one thing about a real adapter a test and
 * the live lane need that the contract has no place for, and that is whether
 * the adapter is still holding a Query, an input stream, or a conversation
 * identity. It hangs off the handle, outside the contract, where only whoever
 * built the backend can reach it.
 *
 * The query loader is the injection point. The SDK's own `query` is the
 * default; a stand-in is a drop-in, so nothing in the adapter branches on
 * whether it is under test.
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
import { type ClaudeOpenOptions, openClaudeBackendAgent } from "./agent.ts";
import {
  type ClaudeAdapterTally,
  type ClaudeNativeProbe,
  type ClaudeProbeCounters,
  type ClaudeTallyCounters,
  createClaudeProbeCounters,
  createClaudeTallyCounters,
} from "./probe.ts";
import { validateClaudeProfile } from "./profile.ts";

/** The name a Profile writes in its `backend` field to reach Claude. */
export const CLAUDE_BACKEND_ID = "claude";

/** A Claude backend, plus the evidence the contract has no place for. */
export interface ClaudeBackendHandle {
  readonly backend: Backend;
  /** What the adapter is still holding. Zero once the Session has closed. */
  readonly probe: () => ClaudeNativeProbe;
  /** How many BackendAgents were opened, and how many closes took effect. */
  readonly tally: () => ClaudeAdapterTally;
}

export interface ClaudeBackendOptions extends ClaudeOpenOptions {
  /** Overridden only where a second Claude-shaped backend is wanted. */
  readonly id?: BackendId;
  /** Shared with the caller when a test wants to read the probe directly. */
  readonly probe?: ClaudeProbeCounters;
  /** Shared with the caller when a test wants to read the tally directly. */
  readonly tally?: ClaudeTallyCounters;
}

export function createClaudeBackend(
  options: ClaudeBackendOptions = {},
): ClaudeBackendHandle {
  const probe = options.probe ?? createClaudeProbeCounters();
  const tally = options.tally ?? createClaudeTallyCounters();
  const backend: Backend = {
    id: options.id ?? backendId(CLAUDE_BACKEND_ID),
    // No validation context is read: Claude's model rule is a fixed family
    // list rather than a Session catalogue, which is exactly why model
    // validation stayed with the backend instead of becoming a central union.
    validateProfile: (
      profile: Profile,
      filePath: string,
    ): readonly ProfileDiagnostic[] => validateClaudeProfile(profile, filePath),
    open: (
      profile: Profile,
      subagent: SubagentContext,
    ): Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope> =>
      openClaudeBackendAgent(profile, subagent, probe, tally, options),
  };
  return { backend, probe: probe.read, tally: tally.read };
}
