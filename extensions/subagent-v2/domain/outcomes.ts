/**
 * The typed public outcomes of the six model-facing operations.
 *
 * These are transcribed from `docs/v2/operation-semantics.md`, which decided
 * what a caller observes in every edge case before any of it was implemented.
 * The discriminant of each union is spelled the way that document spells the
 * outcome, including the spaces, so a reader can put the two side by side. The
 * `already <status>` rows are a template literal type, which is exactly what
 * that notation means.
 *
 * M1 defines these and nothing produces them: the supervisor produces them in
 * M2 and the host handlers render them in M3. Defining them now is what stops
 * a host handler from inventing an outcome that the semantics document never
 * agreed to.
 */

import type { RunId, SubagentId } from "./ids.ts";
import type { TerminalRunPhase } from "./phases.ts";
import type { ProfileDiagnostic } from "./profile.ts";
import type { RunResult } from "./result.ts";

/** `already <status>`: the operation names the Run's terminal status. */
export type AlreadyTerminal = `already ${TerminalRunPhase}`;

export function alreadyTerminal(status: TerminalRunPhase): AlreadyTerminal {
  return `already ${status}`;
}

/**
 * `agent_start`.
 *
 * Admission is the single synchronous decision point: a rejection allocates
 * nothing, creates no public Run, and spends no identifier.
 */
export type StartOutcome =
  | {
      readonly outcome: "started";
      readonly runId: RunId;
      readonly subagentId: SubagentId;
    }
  | { readonly outcome: "unknown agent"; readonly agent: string }
  | {
      readonly outcome: "invalid profile";
      readonly diagnostics: readonly ProfileDiagnostic[];
    }
  | { readonly outcome: "at capacity" }
  | { readonly outcome: "shutting down" }
  | {
      readonly outcome: "delegation-depth exceeded";
      readonly depth: number;
    };

/**
 * `agent_resume`.
 *
 * `conversation lost` is what the semantics document calls Conversation loss,
 * spelled as ADR-0014 and the backend contract spell it so the outcome a
 * backend reports and the outcome a caller sees are the same words.
 */
export type ResumeOutcome =
  | {
      readonly outcome: "started";
      readonly runId: RunId;
      readonly subagentId: SubagentId;
    }
  | { readonly outcome: "unknown Subagent"; readonly subagentId: SubagentId }
  | {
      readonly outcome: "Subagent already running";
      readonly subagentId: SubagentId;
    }
  | { readonly outcome: "resume unsupported" }
  | { readonly outcome: "conversation lost" }
  | { readonly outcome: "at capacity" }
  | { readonly outcome: "shutting down" };

/**
 * `agent_steer`.
 *
 * `accepted` is a statement about the local mailbox and nothing else. It does
 * not mean the adapter dequeued the message, the provider accepted it, or a
 * model consumed it.
 */
export type SteerOutcome =
  | { readonly outcome: "accepted"; readonly runId: RunId }
  | { readonly outcome: "mailbox full"; readonly runId: RunId }
  | { readonly outcome: "invalid"; readonly reason: string }
  | { readonly outcome: "unsupported"; readonly runId: RunId }
  | { readonly outcome: "mailbox closed"; readonly runId: RunId }
  | { readonly outcome: AlreadyTerminal; readonly runId: RunId }
  | { readonly outcome: "unknown Run"; readonly runId: RunId }
  | { readonly outcome: "shutting down" };

/**
 * `agent_cancel`, which answers about request admission and never about
 * whether the Run has already stopped.
 */
export type CancelOutcome =
  | { readonly outcome: "admitted"; readonly runId: RunId }
  | { readonly outcome: "idempotent"; readonly runId: RunId }
  | { readonly outcome: AlreadyTerminal; readonly runId: RunId }
  | { readonly outcome: "unknown Run"; readonly runId: RunId };

/**
 * `agent_wait`, per Run id. A wait that gives up reports the Run as still
 * running, which is a normal outcome and not an error.
 */
export type WaitOutcome =
  | {
      readonly outcome: "terminal";
      readonly runId: RunId;
      readonly status: TerminalRunPhase;
    }
  | { readonly outcome: "still running"; readonly runId: RunId }
  | { readonly outcome: "unknown Run"; readonly runId: RunId };

/**
 * `agent_result`.
 *
 * `ResultExpired` is a distinct outcome rather than an unknown-Run error: a
 * spent identifier and a wrong identifier are different mistakes and get
 * different answers.
 */
export type ResultOutcome =
  | { readonly outcome: "result"; readonly result: RunResult }
  | {
      readonly outcome: "ResultExpired";
      readonly runId: RunId;
      readonly subagentId: SubagentId;
      readonly status: TerminalRunPhase;
    }
  | { readonly outcome: "RunNotTerminal"; readonly runId: RunId }
  | { readonly outcome: "unknown Run"; readonly runId: RunId };

/**
 * Every outcome name of every operation, as data.
 *
 * A test compares these lists against the unions themselves, so a union that
 * gains, loses, or renames a member fails rather than silently drifting away
 * from the semantics document.
 */
export const START_OUTCOMES = [
  "started",
  "unknown agent",
  "invalid profile",
  "at capacity",
  "shutting down",
  "delegation-depth exceeded",
] as const;

export const RESUME_OUTCOMES = [
  "started",
  "unknown Subagent",
  "Subagent already running",
  "resume unsupported",
  "conversation lost",
  "at capacity",
  "shutting down",
] as const;

export const STEER_OUTCOMES = [
  "accepted",
  "mailbox full",
  "invalid",
  "unsupported",
  "mailbox closed",
  "already completed",
  "already failed",
  "already cancelled",
  "unknown Run",
  "shutting down",
] as const;

export const CANCEL_OUTCOMES = [
  "admitted",
  "idempotent",
  "already completed",
  "already failed",
  "already cancelled",
  "unknown Run",
] as const;

export const WAIT_OUTCOMES = [
  "terminal",
  "still running",
  "unknown Run",
] as const;

export const RESULT_OUTCOMES = [
  "result",
  "ResultExpired",
  "RunNotTerminal",
  "unknown Run",
] as const;
