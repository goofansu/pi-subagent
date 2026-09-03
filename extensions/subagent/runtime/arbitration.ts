/**
 * Deciding which of several endings a Run actually had.
 *
 * A Run can be told it is over by four different things at nearly the same
 * time: the execution returns a terminal bundle, the execution fiber is
 * interrupted, the execution dies, and the backend announces an ending in the
 * observation stream. Under concurrency, more than one of them happens. Only
 * one of them is what the Run's result says.
 *
 * This is a pure function so that "which one wins" is decided in one place,
 * readable in one sitting, and testable without a runtime. The settlement
 * coordinator's job is to capture exactly one candidate and then call this;
 * it makes no judgements of its own.
 *
 * The rules, in the order they apply:
 *
 * 1. **An ending already reduced from the stream wins.** The projection is
 *    terminal the moment it reduces an ending, and a terminal projection is
 *    absorbing — so the ending that got there first is the one the Run's
 *    transcript, tools, and usage were closed against. Anything that arrives
 *    afterwards is late, including a bundle's own ending.
 * 2. **A bundle the execution returned wins over a cancellation request.**
 *    This is the "terminal answer survives a later cancel" rule: the execution
 *    finished, so the Run has an answer, and a cancel that arrived after it is
 *    a request against a Run that was already done.
 * 3. **An interruption that took effect before a bundle yields `cancelled`**,
 *    with the *first* recorded reason. A shutdown arriving after a user's
 *    cancel does not rewrite why the Run stopped.
 * 4. **A defect yields `failed`** with a redacted `backend-failure` diagnostic.
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

/**
 * The four things that can tell a Run it is over.
 *
 * The coordinator captures whichever arrives first and counts the rest. An
 * in-stream ending is a candidate even though it does not *end* the Run — the
 * execution still has to return — because it is the ending that closed the
 * projection, and capturing it is how "first ending wins" is recorded rather
 * than re-derived.
 */
export type SettlementCandidate =
  /** The execution returned. */
  | { readonly source: "bundle"; readonly bundle: TerminalBundle }
  /** The execution fiber was interrupted: cancel, timeout, shutdown, close. */
  | { readonly source: "interruption"; readonly reason: CancellationReason }
  /** The execution failed or died, which an adapter must never do. */
  | { readonly source: "defect" }
  /** The backend said how the Run ended, in the observation stream. */
  | { readonly source: "in-stream-ending"; readonly ending: RunEnding };

export interface ArbitrationInput {
  readonly candidate: SettlementCandidate;
  /** An ending the backend announced in the stream, already reduced. */
  readonly announced?: RunEnding;
  /** The cancellation recorded on the Run, if one was ever admitted. */
  readonly cancellation?: CancellationRequest;
}

export interface Arbitration {
  /** The one ending the Run had. */
  readonly ending: RunEnding;
  /** Where it came from, for a trace and for the conformance suite. */
  readonly from: "in-stream" | "bundle" | "interruption" | "defect";
  /**
   * Whether a competing ending was discarded as late.
   *
   * Not an error: it is the normal outcome of a backend that announced its
   * ending and then returned a bundle saying the same thing.
   */
  readonly late: boolean;
  /** A diagnostic settlement must record on the Run, when one is produced. */
  readonly diagnostic?: RunDiagnostic;
}

export function arbitrate(input: ArbitrationInput): Arbitration {
  const { candidate, announced, cancellation } = input;

  // Rule 1. The projection is already terminal, so whatever the candidate
  // carries would be reduced as late anyway. Deciding it here means the
  // coordinator does not have to reason about it twice.
  if (announced !== undefined) {
    return {
      ending: announced,
      from: "in-stream",
      late: true,
      ...(candidate.source === "defect"
        ? // The Run had said how it ended, and *then* the adapter died. The
          // ending stands; the defect is still worth recording, because an
          // adapter that dies after announcing is still an adapter defect.
          { diagnostic: redactedDiagnostic("backend-failure") }
        : {}),
    };
  }

  switch (candidate.source) {
    // Rule 1 again, for the case where the coordinator captured the in-stream
    // ending before the reducer had written it back to the projection. Same
    // answer, reached from the candidate rather than from `announced`.
    case "in-stream-ending":
      return { ending: candidate.ending, from: "in-stream", late: false };

    // Rule 2.
    case "bundle":
      return { ending: candidate.bundle.ending, from: "bundle", late: false };

    // Rule 3. The recorded reason is the one that was admitted first; the
    // candidate's own reason is the fallback for an interruption that reached
    // the fiber without ever being recorded, which is what a Subagent close
    // during shutdown looks like.
    case "interruption":
      return {
        ending: cancelledEnding(cancellation?.reason ?? candidate.reason),
        from: "interruption",
        late: false,
      };

    // Rule 4.
    case "defect":
      return {
        ending: failedEnding(DEFECT_FALLBACK_MESSAGE),
        from: "defect",
        late: false,
        diagnostic: redactedDiagnostic("backend-failure"),
      };
  }
}
