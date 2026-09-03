/**
 * Typed diagnostics: a fixed category set and a bounded, redacted message.
 *
 * Provider-authored error text is free-form, so no pattern can prove a given
 * string carries no session identifier, no path, and no credential. v1's
 * provider-diagnostic module, at the v1 backend seam, answered this by
 * reporting an adapter-owned category and redacting the text, and v2 keeps
 * that shape: the category is the useful part at the public seam, and the raw
 * provider value stays adapter-local.
 *
 * A diagnostic authored by the core itself — a late event, an overflowing
 * intake — has no provider text to fear, so it may carry a real message. The
 * bound applies either way, at construction, so nothing downstream has to
 * remember to apply it.
 */

import { Schema } from "effect";
import { boundOneLine } from "./text.ts";

export const DIAGNOSTIC_CATEGORIES = [
  "backend-failure",
  "transport-loss",
  "cleanup-escalation",
  "queue-overflow",
  "reconciliation-difference",
  "late-event",
  "delivery-failure",
  "profile",
  "control",
  "other",
] as const;

export const DiagnosticCategory = Schema.Literals(DIAGNOSTIC_CATEGORIES);

export type DiagnosticCategory = typeof DiagnosticCategory.Type;

/** Long enough to explain a failure, short enough to keep on a heap. */
export const DIAGNOSTIC_MESSAGE_MAX_BYTES = 2048;

/** What a redacted diagnostic says instead of provider text. */
export const DIAGNOSTIC_REDACTED = "[redacted]";

export const RunDiagnostic = Schema.Struct({
  category: DiagnosticCategory,
  message: Schema.String,
});

export type RunDiagnostic = typeof RunDiagnostic.Type;

export const isDiagnosticCategory: (
  value: unknown,
) => value is DiagnosticCategory = Schema.is(DiagnosticCategory);

/**
 * Build a diagnostic, rejecting an unknown category and bounding the message.
 *
 * Newlines are collapsed so one diagnostic stays one line wherever it is
 * rendered.
 */
export function runDiagnostic(
  category: DiagnosticCategory,
  message: string,
): RunDiagnostic {
  return RunDiagnostic.make({
    category,
    message: boundOneLine(message, DIAGNOSTIC_MESSAGE_MAX_BYTES),
  });
}

/**
 * Report that something provider-authored went wrong, without retaining what
 * it said. The v2 spelling of v1's provider-diagnostic confinement.
 */
export function redactedDiagnostic(
  category: DiagnosticCategory,
): RunDiagnostic {
  return runDiagnostic(category, DIAGNOSTIC_REDACTED);
}
