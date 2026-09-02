/**
 * Subagent and Run phases as data.
 *
 * Both state machines are exported transition tables plus a pure function that
 * reads them. A maintainer can see every legal state change by reading one
 * object, and a test can enumerate every cell rather than trusting a chain of
 * `if` statements to be exhaustive.
 *
 * Nothing here throws. An illegal (phase, event) pair returns the
 * {@link ILLEGAL_TRANSITION} marker, because a state machine that throws
 * forces every caller to decide between crashing and swallowing, and neither
 * is what the supervisor wants.
 *
 * See docs/adr/0013-stable-subagent-identity.md for the Subagent rules and
 * docs/adr/0025-v2-terminal-settlement.md for the Run rules.
 */

/** What a transition function returns when the table has no legal next phase. */
export const ILLEGAL_TRANSITION = "illegal";

export type IllegalTransition = typeof ILLEGAL_TRANSITION;

/* ------------------------------------------------------------------ */
/* Subagent                                                            */
/* ------------------------------------------------------------------ */

export const SUBAGENT_PHASES = ["running", "idle", "closed"] as const;

export type SubagentPhase = (typeof SUBAGENT_PHASES)[number];

/**
 * The three things that can happen to a Subagent.
 *
 * `resume-admitted` is the *admitted* resume, not the request: admission is
 * the synchronous decision point, and only an admitted one moves the phase.
 */
export const SUBAGENT_EVENTS = [
  "run-settled",
  "resume-admitted",
  "close",
] as const;

export type SubagentEvent = (typeof SUBAGENT_EVENTS)[number];

export type SubagentTransitionTable = {
  readonly [P in SubagentPhase]: {
    readonly [E in SubagentEvent]: SubagentPhase | IllegalTransition;
  };
};

/**
 * `closed` is absorbing: no event leaves it.
 *
 * Two events are still meaningful there and are legal no-ops. A closed
 * Subagent may have a Run finishing its settlement — closing is
 * cancel-and-await-cleanup, so the Run settles normally and the Subagent stays
 * closed — and closing an already-closed Subagent is idempotent. Admitting a
 * resume on a closed Subagent is the one illegal cell, because a closed
 * Subagent admits no new Run.
 */
export const SUBAGENT_TRANSITIONS: SubagentTransitionTable = {
  running: {
    "run-settled": "idle",
    "resume-admitted": ILLEGAL_TRANSITION,
    close: "closed",
  },
  idle: {
    "run-settled": ILLEGAL_TRANSITION,
    "resume-admitted": "running",
    close: "closed",
  },
  closed: {
    "run-settled": "closed",
    "resume-admitted": ILLEGAL_TRANSITION,
    close: "closed",
  },
};

export function transitionSubagent(
  phase: SubagentPhase,
  event: SubagentEvent,
): SubagentPhase | IllegalTransition {
  return SUBAGENT_TRANSITIONS[phase][event];
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export const RUN_PHASES = [
  "running",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export const TERMINAL_RUN_PHASES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export type TerminalRunPhase = (typeof TERMINAL_RUN_PHASES)[number];

export function isTerminalRunPhase(phase: RunPhase): phase is TerminalRunPhase {
  return (TERMINAL_RUN_PHASES as readonly string[]).includes(phase);
}

/**
 * The four things that can happen to a Run.
 *
 * Settlement is three events rather than one because a settlement names which
 * terminal phase it reaches; a `transition(phase, event)` signature has no
 * other way to say so.
 *
 * `finalizing` exists so the UI never shows a Run as terminal while its
 * cleanup is still running: the native execution ending and the Run settling
 * are separate instants, and only the second one is terminal.
 */
export const RUN_EVENTS = [
  "execution-ended",
  "settled-answered",
  "settled-failed",
  "settled-cancelled",
] as const;

export type RunEvent = (typeof RUN_EVENTS)[number];

export type RunTransitionTable = {
  readonly [P in RunPhase]: {
    readonly [E in RunEvent]: RunPhase | IllegalTransition;
  };
};

/** Every cell out of a terminal phase is illegal: settlement is absorbing. */
const TERMINAL_ROW = {
  "execution-ended": ILLEGAL_TRANSITION,
  "settled-answered": ILLEGAL_TRANSITION,
  "settled-failed": ILLEGAL_TRANSITION,
  "settled-cancelled": ILLEGAL_TRANSITION,
} as const;

export const RUN_TRANSITIONS: RunTransitionTable = {
  running: {
    "execution-ended": "finalizing",
    // Settling straight from running would skip cleanup, which is exactly
    // what `finalizing` exists to make impossible.
    "settled-answered": ILLEGAL_TRANSITION,
    "settled-failed": ILLEGAL_TRANSITION,
    "settled-cancelled": ILLEGAL_TRANSITION,
  },
  finalizing: {
    "execution-ended": ILLEGAL_TRANSITION,
    "settled-answered": "completed",
    "settled-failed": "failed",
    "settled-cancelled": "cancelled",
  },
  completed: TERMINAL_ROW,
  failed: TERMINAL_ROW,
  cancelled: TERMINAL_ROW,
};

export function transitionRun(
  phase: RunPhase,
  event: RunEvent,
): RunPhase | IllegalTransition {
  return RUN_TRANSITIONS[phase][event];
}

/* ------------------------------------------------------------------ */
/* Cancellation                                                        */
/* ------------------------------------------------------------------ */

export const CANCELLATION_REASONS = [
  "requested",
  "shutdown",
  "timeout",
] as const;

/**
 * Why a Run was cancelled. `timeout` is here from the start so the optional
 * Run timeout a later milestone may add needs no domain change.
 */
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export interface CancellationRequest {
  readonly reason: CancellationReason;
}

/**
 * What recording a cancellation request did.
 *
 * Cancellation is a *request* recorded on an active Run, never a phase
 * change: a Run reaches `cancelled` only when its execution and finalizers
 * have finished. Recording is idempotent, and the first reason wins — a
 * shutdown arriving after a user's cancel does not rewrite why the Run
 * stopped.
 */
export type CancellationRecording =
  | { readonly outcome: "recorded"; readonly request: CancellationRequest }
  | { readonly outcome: "unchanged"; readonly request: CancellationRequest }
  | { readonly outcome: IllegalTransition; readonly phase: RunPhase };

export function recordCancellation(
  phase: RunPhase,
  existing: CancellationRequest | undefined,
  reason: CancellationReason,
): CancellationRecording {
  if (isTerminalRunPhase(phase)) {
    return { outcome: ILLEGAL_TRANSITION, phase };
  }
  if (existing) return { outcome: "unchanged", request: existing };
  return { outcome: "recorded", request: { reason } };
}
