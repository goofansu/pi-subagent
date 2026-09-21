/**
 * Deciding which of several endings a Run actually had.
 *
 * A Run can be told it is over by several things at nearly the same time: an
 * execution records or returns a terminal bundle, its fiber is interrupted, or
 * it dies. Under concurrency, more than one happens. Only one of them is what
 * the Run's result says.
 *
 * This is a pure function so that "which one wins" is decided in one place,
 * readable in one sitting, and testable without a runtime. The Run scope hands
 * it the execution candidate, the once-only recorded decision, and the first
 * cancellation request; this function alone interprets their precedence.
 *
 * The rules, in the order they apply:
 *
 * 1. **A recorded decision is ordered against the first stop request.** A
 *    decision recorded first wins with its bundle's ending; a stop recorded
 *    first yields `cancelled` with the first reason.
 * 2. **A normal return records the same kind of decision at return time.** It
 *    has no separate precedence rule: if a stop was recorded first, the stop
 *    wins just as it does against an adapter-recorded decision.
 * 3. **A defect yields `failed`** with a redacted `backend-failure` diagnostic,
 *    even if the execution recorded a decision before it died.
 *    An adapter must not fail its Effect for a backend failure, so one that
 *    does — or that dies — is an adapter defect, and the Run settles with
 *    everything it managed to observe retained.
 */

import type { TerminalBundle } from "../backend/contract.ts";
import {
  type CancellationReason,
  type CancellationRequest,
  cancelledEnding,
  failedEnding,
  type RunDiagnostic,
  type RunEnding,
  redactedDiagnostic,
} from "../domain/index.ts";

/** What the fallback message of a defect-classified Run says. */
export const DEFECT_FALLBACK_MESSAGE = "the backend execution failed";

/** The three things that can tell a Run it is over. */
export type SettlementCandidate =
  /** A decision recorded through ExecutionIO, ordered against the first stop. */
  | {
      readonly source: "recorded-decision";
      readonly bundle: TerminalBundle;
      readonly beforeStop: boolean;
    }
  /** The execution returned after the core recorded its bundle as a decision. */
  | { readonly source: "execution-return" }
  /** The execution fiber was interrupted: cancel, timeout, shutdown, close. */
  | { readonly source: "interruption"; readonly reason: CancellationReason }
  /** The execution failed or died, which an adapter must never do. */
  | { readonly source: "defect" };

export interface ArbitrationInput {
  readonly candidate: SettlementCandidate;
  /** A decision recorded before the execution produced its exit candidate. */
  readonly decision?: Extract<
    SettlementCandidate,
    { readonly source: "recorded-decision" }
  >;
  /** The cancellation recorded on the Run, if one was ever admitted. */
  readonly cancellation?: CancellationRequest;
}

export interface Arbitration {
  /** The one ending the Run had. */
  readonly ending: RunEnding;
  /** Where it came from, for a trace and for the conformance suite. */
  readonly from: "recorded-decision" | "interruption" | "defect";
  /** A diagnostic settlement must record on the Run, when one is produced. */
  readonly diagnostic?: RunDiagnostic;
}

export function arbitrate(input: ArbitrationInput): Arbitration {
  const { candidate, decision, cancellation } = input;

  // A defect is an adapter contract violation, not a second opinion about a
  // decision. Preserve the partial work but classify the execution as failed.
  if (candidate.source === "defect") {
    return {
      ending: failedEnding(DEFECT_FALLBACK_MESSAGE),
      from: "defect",
      diagnostic: redactedDiagnostic("backend-failure"),
    };
  }

  const effective = decision ?? candidate;
  switch (effective.source) {
    // Rule 1. `beforeStop` is captured by the Run at the recording operation,
    // so arbitration does not infer chronology from which fiber exited first.
    case "recorded-decision":
      return effective.beforeStop
        ? {
            ending: effective.bundle.ending,
            from: "recorded-decision",
          }
        : {
            ending: cancelledEnding(cancellation?.reason ?? "requested"),
            from: "interruption",
          };

    // A successful execution cannot reach arbitration without the decision
    // its return recorded. Treat that impossible state as a backend defect
    // rather than reviving a second precedence rule for returned bundles.
    case "execution-return":
      return {
        ending: failedEnding(DEFECT_FALLBACK_MESSAGE),
        from: "defect",
        diagnostic: redactedDiagnostic("backend-failure"),
      };

    // The recorded reason is the one that was admitted first; the
    // candidate's own reason is the fallback for an interruption that reached
    // the fiber without ever being recorded, which is what a Subagent close
    // during shutdown looks like.
    case "interruption":
      return {
        ending: cancelledEnding(cancellation?.reason ?? effective.reason),
        from: "interruption",
      };
  }
}
