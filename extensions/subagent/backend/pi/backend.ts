/**
 * The `pi` backend: the contract's three members, and nothing else public.
 *
 * The factory returns a **handle** rather than a bare `Backend` for the same
 * reason the fakes do: there is one thing about a real adapter a test and the
 * live lane need that the contract has no place for, and that is whether the
 * adapter is still holding a native session or an event subscription. It hangs
 * off the handle, outside the contract, where only whoever built the backend
 * can reach it.
 *
 * The session factory is the injection point. `createAgentSession` is the
 * default; a stand-in is a drop-in, so nothing in the adapter branches on
 * whether it is under test.
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Effect, Scope } from "effect";
import {
  type BackendId,
  backendId,
  DEFAULT_BACKEND_ID,
  type Profile,
  type ProfileDiagnostic,
  type SubagentContext,
} from "../../domain/index.ts";
import type {
  Backend,
  BackendAgent,
  BackendOpenFailure,
  BackendValidationContext,
} from "../contract.ts";
import { openPiBackendAgent, type PiOpenOptions } from "./agent.ts";
import {
  createPiProbeCounters,
  type PiNativeProbe,
  type PiProbeCounters,
} from "./probe.ts";
import { validatePiProfile } from "./profile.ts";
import type { PiSession, PiSessionFactory } from "./session.ts";

/** The backend a Profile with no `backend` field names. */
export const PI_BACKEND_ID: BackendId = DEFAULT_BACKEND_ID;

/** A Pi backend, plus the evidence the contract has no place for. */
export interface PiBackendHandle {
  readonly backend: Backend;
  /** What the adapter is still holding. Zero once the Session has closed. */
  readonly probe: () => PiNativeProbe;
}

export interface PiBackendOptions extends PiOpenOptions {
  /** Overridden only where a second Pi-shaped backend is wanted. */
  readonly id?: BackendId;
  /** Shared with the caller when a test wants to read the probe directly. */
  readonly probe?: PiProbeCounters;
}

/** The real thing: one native session per Subagent, created by the SDK. */
const defaultSessionFactory: PiSessionFactory = (options) =>
  createAgentSession(options) as Promise<{ readonly session: PiSession }>;

export function createPiBackend(
  options: PiBackendOptions = {},
): PiBackendHandle {
  const probe = options.probe ?? createPiProbeCounters();
  const backend: Backend = {
    id: options.id ?? backendId(PI_BACKEND_ID),
    validateProfile: (
      profile: Profile,
      filePath: string,
      context?: BackendValidationContext,
    ): readonly ProfileDiagnostic[] =>
      validatePiProfile(profile, filePath, context),
    open: (
      profile: Profile,
      subagent: SubagentContext,
    ): Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope> =>
      openPiBackendAgent(
        profile,
        subagent,
        probe,
        options,
        defaultSessionFactory,
      ),
  };
  return { backend, probe: probe.read };
}
