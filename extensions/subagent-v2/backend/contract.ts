/**
 * The v2 backend contract.
 *
 * Three interfaces, one per scope level, because the three things a backend
 * owns have three different lifetimes and confusing them is what v1's
 * lifecycle machinery cost:
 *
 * - {@link Backend} is **session-long**. It validates Profiles and opens
 *   BackendAgents. There is one per named backend, built when the Session
 *   opens.
 * - {@link BackendAgent} is **Subagent-scoped**. It owns the retained native
 *   conversation, session, or process, and it outlives every Run it executes.
 * - One call to {@link BackendAgent.execute} is **Run-scoped**. It runs
 *   exactly one execution and resolves to a {@link TerminalBundle}.
 *
 * This module is expressed in Effect types while the domain module is plain
 * TypeScript. That is deliberate and it is the one place the two meet: what
 * this contract is *about* is resource lifetime — who owns the native handle,
 * when it is released, and what cancels an execution — and Effect's `Scope`
 * says that in the type instead of in a comment. The domain has no lifetimes
 * in it, so it needs none of that. ADR-0028 records the decision.
 *
 * Two things are deliberately absent, and both absences are load-bearing:
 *
 * - **No cancellation object.** An execution is cancelled by Effect
 *   interrupting its fiber. An adapter observes that through interruption
 *   handling; it is never handed a signal to poll.
 * - **No error channel on an execution.** A backend failure is a `failed`
 *   ending, not a failed Effect, because the *core* decides when a Run is
 *   terminal and what its result says. An adapter that fails its Effect
 *   anyway, or dies, is classified by the caller as failed with a
 *   `backend-failure` diagnostic and its partial observations retained.
 *
 * `open` is different from an execution and has a typed failure channel, which
 * ADR-0030 added after ADR-0028 deferred it. An open that fails has produced
 * no Run to report through, and inventing one — a public Run id, a failed
 * result, and a completion Notification for work that never started — is
 * exactly what operation semantics section 1 forbids.
 *
 * See docs/adr/0023-v2-scope-ownership.md,
 * docs/adr/0025-v2-terminal-settlement.md,
 * docs/adr/0026-v2-control-admission.md, and
 * docs/adr/0030-v2-backend-open-failure.md.
 */

import type { Effect, Scope } from "effect";
import type {
  BackendId,
  Profile,
  ProfileDiagnostic,
  RunDiagnostic,
  RunEnding,
  RunId,
  RunObservation,
  SubagentContext,
  TerminalReconciliation,
} from "../domain/index.ts";

/**
 * Why a BackendAgent could not be opened.
 *
 * Exactly one field, and it is a {@link RunDiagnostic} the adapter has already
 * redacted. Provider text never crosses: an open failure is usually the
 * provider's own error string, and that string is the one thing about a failed
 * open that is guaranteed to be free-form and untrustworthy. What the caller
 * needs is the category — `backend-failure` — and the caller is what turns
 * this into the public `backend unavailable` outcome.
 *
 * There is deliberately no place to put a cause, an exit code, a retry hint,
 * or a provider payload. A type-level test asserts the field list.
 */
export interface BackendOpenFailure {
  readonly diagnostic: RunDiagnostic;
}

/** The member names of {@link BackendOpenFailure}, as data for the shape test. */
export const BACKEND_OPEN_FAILURE_MEMBERS = ["diagnostic"] as const;

/**
 * What a backend may consult while validating a Profile.
 *
 * Nothing in M1 reads this, because model validation is genuinely
 * provider-specific and M1 has no provider. Its reader arrives with the Pi
 * adapter at M4, which checks a Profile's pinned model against the catalogue
 * the session actually loaded — exactly what v1 passes through the equivalent
 * field. It is here now because `validateProfile` is a contract member and the
 * shape test makes adding one later a visible change.
 */
export interface BackendValidationContext {
  /** Models available to this session; omission means an empty catalogue. */
  readonly models?: readonly {
    readonly provider: string;
    readonly id: string;
  }[];
}

/** What one BackendAgent can do, declared once when it is opened. */
export interface BackendCapabilities {
  /** Whether a later Run may reuse this BackendAgent's conversation. */
  readonly resume: boolean;
  /** Whether an execution consumes Controls. */
  readonly steer: boolean;
  /** Whether settlement can offer an authoritative terminal snapshot. */
  readonly terminalTranscriptSnapshot: boolean;
}

/**
 * The synchronous, provider-I/O-free decision for one resume request.
 *
 * Exactly three answers, and no fourth. `conversation lost` covers every way a
 * resumable backend can have nothing left to resume — including a BackendAgent
 * that was never opened in the provider sense, which is how ADR-0023's
 * unopened-Claude case fits with no special case in the core.
 */
export type ResumeAdmission = "admitted" | "unsupported" | "conversation lost";

/** Guidance admitted to a Run while its execution is active. */
export interface RunControl {
  readonly type: "steer";
  readonly text: string;
}

/**
 * The serial source an execution takes Controls from.
 *
 * One consumer, one at a time, in admission order. `undefined` means the feed
 * is closed and drained: the Run is settling, was cancelled, or the Session is
 * shutting down, and no further Control will arrive.
 */
export interface ControlFeed {
  readonly take: Effect.Effect<RunControl | undefined>;
}

/** What one Run asks its BackendAgent to do. */
export interface RunInput {
  readonly runId: RunId;
  readonly description: string;
  readonly prompt: string;
}

/** Where an execution reports to, and where it takes guidance from. */
export interface ExecutionIO {
  /** Report one observation. Ordered and lossless within the Run. */
  readonly emit: (observation: RunObservation) => Effect.Effect<void>;
  readonly controls: ControlFeed;
}

/**
 * How an execution finished, plus its authoritative snapshot if it has one.
 *
 * The bundle is a *report*, not a settlement: the core applies it to the
 * projection and performs the terminal transition. An adapter that could
 * settle its own Run would be able to settle it twice.
 */
export interface TerminalBundle {
  readonly ending: RunEnding;
  /** Omitted by a backend with no snapshot. It never fabricates one. */
  readonly reconciliation?: TerminalReconciliation;
}

/**
 * One Subagent's retained native resource.
 *
 * A BackendAgent may begin life **unopened** in the provider sense, holding no
 * provider identity and acquiring one as a side effect of its first Run. That
 * is not a degraded state; it is what one of the three backends actually does.
 */
export interface BackendAgent {
  readonly capabilities: BackendCapabilities;
  /**
   * Decide whether a later Run may reuse this conversation.
   *
   * Synchronous and free of provider I/O, so admission cannot block the
   * caller's turn on a backend's latency, and a rejected resume costs no
   * provider quota.
   */
  readonly admitResume: () => ResumeAdmission;
  /**
   * Run exactly one execution.
   *
   * The returned Effect requires a `Scope` for the native execution, nested
   * inside the Run's own scope: a provider turn, query, or prompt may end
   * without ending the Run, but it can never outlive it. Cancellation is
   * interruption of this Effect.
   */
  readonly execute: (
    input: RunInput,
    io: ExecutionIO,
  ) => Effect.Effect<TerminalBundle, never, Scope.Scope>;
  /** Release everything this BackendAgent retains. Safe to run more than once. */
  readonly close: () => Effect.Effect<void>;
}

/**
 * One named backend, for the life of the Session.
 */
export interface Backend {
  readonly id: BackendId;
  /** Deterministic: the same Profile always yields the same diagnostics. */
  readonly validateProfile: (
    profile: Profile,
    filePath: string,
    context?: BackendValidationContext,
  ) => readonly ProfileDiagnostic[];
  /**
   * Acquire a BackendAgent into the caller's scope.
   *
   * Closing that scope closes the BackendAgent. Opening creates no Run and
   * emits no observation.
   *
   * The Profile handed here is a *prepared* one: admission has already run it
   * through this backend's own `validateProfile` and found no diagnostics, so
   * `open` may read the fields it recognizes without re-validating them.
   * Preparation is that guarantee rather than a separate type — a
   * `PreparedProfile` brand with no other reader would be ceremony.
   */
  readonly open: (
    profile: Profile,
    subagent: SubagentContext,
  ) => Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope>;
}

/**
 * The exact member names of the contract, as data.
 *
 * The shape test compares the interfaces against these lists, so widening the
 * contract is a failing test rather than a quiet drift. Provider controls,
 * continuation tokens, attempt vocabulary, and a cancellation signal are the
 * four things that would try to creep in here, and the shape test names all
 * four as forbidden.
 */
export const BACKEND_MEMBERS = ["id", "validateProfile", "open"] as const;

export const BACKEND_AGENT_MEMBERS = [
  "capabilities",
  "admitResume",
  "execute",
  "close",
] as const;

export const BACKEND_CAPABILITY_MEMBERS = [
  "resume",
  "steer",
  "terminalTranscriptSnapshot",
] as const;

export const RUN_INPUT_MEMBERS = ["runId", "description", "prompt"] as const;

export const EXECUTION_IO_MEMBERS = ["emit", "controls"] as const;

export const CONTROL_FEED_MEMBERS = ["take"] as const;

export const TERMINAL_BUNDLE_MEMBERS = ["ending", "reconciliation"] as const;

export const RESUME_ADMISSIONS = [
  "admitted",
  "unsupported",
  "conversation lost",
] as const;
