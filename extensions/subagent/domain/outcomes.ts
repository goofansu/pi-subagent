/**
 * The typed public outcomes of the six model-facing operations.
 *
 * **These unions are the source of truth for what a caller observes.** Every
 * edge case a public operation can answer with is a member here, spelled as
 * prose — spaces and all — because the name is what a reader of a tool result
 * sees. `already <status>` is a template literal type over the terminal
 * statuses, so gaining a terminal status gains its outcomes.
 *
 * Nothing outside this file may invent an outcome: a host handler that wanted
 * to say something new would have to add it here first, where every renderer
 * and every formatter has to account for it.
 */

import type { RunDiagnostic } from "./diagnostics.ts";
import type { RunId, SubagentId } from "./ids.ts";
import type { CancellationReason, TerminalRunPhase } from "./phases.ts";
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
 * `empty label` is the Run label's *lower* bound — a second bound beside the
 * one-line, 200-byte upper one — and the one rejection decided *before*
 * admission. Contributing invariant 11 lets each bound truncate-and-record or
 * refuse; the upper bound truncates, and this one refuses, because there is
 * nothing to shorten in an empty description and nothing honest to invent. It
 * is decided where the label is bounded, which is the last point before a
 * supervisor request exists, so nothing is reserved and no identifier is spent.
 *
 * It therefore outranks every rejection admission makes, `shutting down`
 * included. Both are refusals that start nothing, so the precedence changes
 * which sentence a caller reads and nothing else.
 *
 * Admission is the single synchronous decision point for everything that can
 * be decided without provider I/O: a rejection allocates nothing and creates
 * no public Run. Identifiers allocated for a start that then fails at open
 * stay spent, because no identifier is ever reused.
 *
 * `backend unavailable` is the one rejection that happens *after* admission,
 * because opening a BackendAgent is the one part of starting that talks to a
 * provider. It carries the backend's redacted diagnostic and no Run id: a
 * caller must never hold an id for work that never started. See ADR-0030.
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
  | { readonly outcome: "empty label" }
  | { readonly outcome: "at capacity" }
  | { readonly outcome: "shutting down" }
  | {
      readonly outcome: "delegation-depth exceeded";
      readonly depth: number;
    }
  | {
      readonly outcome: "backend unavailable";
      readonly diagnostic: RunDiagnostic;
    };

/**
 * `agent_resume`.
 *
 * There is no `backend unavailable` here, and the absence is the rule: resume
 * reuses the BackendAgent its Subagent already holds, so it opens nothing.
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
  | { readonly outcome: "empty label" }
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
      /**
       * Why the Run was cancelled, when it was.
       *
       * Present only for a cancelled Run, and reported because the difference
       * matters to a caller: at shutdown every Run is cancelled without
       * anyone asking for it, and a model told plain `cancelled` would
       * conclude its own request had taken effect. v1 reported it here too.
       */
      readonly cancellationReason?: CancellationReason;
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
  "empty label",
  "at capacity",
  "shutting down",
  "delegation-depth exceeded",
  "backend unavailable",
] as const;

export const RESUME_OUTCOMES = [
  "started",
  "unknown Subagent",
  "Subagent already running",
  "empty label",
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
