/**
 * Deciding which of several endings a Run actually had.
 *
 * A Run can be told it is over by several things at nearly the same time: an
 * execution records or returns a terminal bundle, its fiber is interrupted or
 * dies, and (temporarily, for adapter compatibility) the backend announces an
 * ending in the observation stream. Under concurrency, more than one happens.
 * Only one of them is what the Run's result says.
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
 * 2. **A recorded decision is ordered against the first stop request.** A
 *    decision recorded first wins with its bundle's ending; a stop recorded
 *    first yields `cancelled` with the first reason.
 * 3. **A normal return records the same kind of decision at return time.** It
 *    has no separate precedence rule: if a stop was recorded first, the stop
 *    wins just as it does against an adapter-recorded decision.
 * 4. **A defect yields `failed`** with a redacted `backend-failure` diagnostic,
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
  | { readonly source: "defect" }
  /** The backend said how the Run ended, in the observation stream. */
  | { readonly source: "in-stream-ending"; readonly ending: RunEnding };

export interface ArbitrationInput {
  readonly candidate: SettlementCandidate;
  /** A decision recorded before the execution produced its exit candidate. */
  readonly decision?: Extract<
    SettlementCandidate,
    { readonly source: "recorded-decision" }
  >;
  /** An ending the backend announced in the stream, already reduced. */
  readonly announced?: RunEnding;
  /** The cancellation recorded on the Run, if one was ever admitted. */
  readonly cancellation?: CancellationRequest;
}

export interface Arbitration {
  /** The one ending the Run had. */
  readonly ending: RunEnding;
  /** Where it came from, for a trace and for the conformance suite. */
  readonly from: "in-stream" | "recorded-decision" | "interruption" | "defect";
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
  const { candidate, decision, announced, cancellation } = input;

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

  // A defect is an adapter contract violation, not a second opinion about a
  // decision. Preserve the partial work but classify the execution as failed.
  if (candidate.source === "defect") {
    return {
      ending: failedEnding(DEFECT_FALLBACK_MESSAGE),
      from: "defect",
      late: false,
      diagnostic: redactedDiagnostic("backend-failure"),
    };
  }

  const effective = decision ?? candidate;
  switch (effective.source) {
    // Rule 1 again, for the case where the coordinator captured the in-stream
    // ending before the reducer had written it back to the projection. Same
    // answer, reached from the candidate rather than from `announced`.
    case "in-stream-ending":
      return { ending: effective.ending, from: "in-stream", late: false };

    // Rule 2. `beforeStop` is captured by the Run at the recording operation,
    // so arbitration does not infer chronology from which fiber exited first.
    case "recorded-decision":
      return effective.beforeStop
        ? {
            ending: effective.bundle.ending,
            from: "recorded-decision",
            late: false,
          }
        : {
            ending: cancelledEnding(cancellation?.reason ?? "requested"),
            from: "interruption",
            late: false,
          };

    // A successful execution cannot reach arbitration without the decision
    // its return recorded. Treat that impossible state as a backend defect
    // rather than reviving a second precedence rule for returned bundles.
    case "execution-return":
      return {
        ending: failedEnding(DEFECT_FALLBACK_MESSAGE),
        from: "defect",
        late: false,
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
        late: false,
      };
  }
}
