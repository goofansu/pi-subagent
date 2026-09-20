/**
 * The backend-neutral meaning of retained final output.
 *
 * Final output and its truncation counter must be read together. An empty
 * retained string can mean either that no visible answer was produced or that
 * bounding removed the answer entirely; a non-empty string can be either the
 * whole retained answer or only its retained prefix. This module is the one
 * owner of that distinction. Presentation chooses its own wording and layout
 * from this value rather than reconstructing the meaning.
 */

import { Schema } from "effect";
import type { TruncationRecord } from "./projection.ts";

const RemovedBytes = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
);

/** Retention facts small enough for a self-sufficient Notification to carry. */
export const FinalOutputRetention = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("retained") }),
  Schema.Struct({
    kind: Schema.Literal("retained-prefix"),
    removedBytes: RemovedBytes,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed"),
    removedBytes: RemovedBytes,
  }),
]);

export type FinalOutputRetention = typeof FinalOutputRetention.Type;

export type FinalOutputInterpretation =
  | { readonly kind: "absent" }
  | { readonly kind: "retained"; readonly output: string }
  | {
      readonly kind: "retained-prefix";
      readonly removedBytes: number;
      readonly output: string;
    }
  | { readonly kind: "removed"; readonly removedBytes: number };

/** Strip retained text for the small meaning carried on a Notification. */
export function finalOutputRetentionOf(
  interpretation: FinalOutputInterpretation,
): FinalOutputRetention {
  switch (interpretation.kind) {
    case "absent":
    case "retained":
      return { kind: interpretation.kind };
    case "retained-prefix":
    case "removed":
      return {
        kind: interpretation.kind,
        removedBytes: interpretation.removedBytes,
      };
  }
}

/**
 * Interpret final-output presence and retention loss once.
 *
 * Whitespace-only text has no visible output. For visible retained text the
 * original string is returned untouched, so rendering does not normalize an
 * agent's Markdown. Truncation evidence wins over apparent emptiness: it proves
 * that output existed even when no visible byte remains.
 */
export function interpretFinalOutput(value: {
  readonly finalOutput: string;
  readonly truncation: Pick<TruncationRecord, "truncatedOutputBytes">;
}): FinalOutputInterpretation {
  const removedBytes = value.truncation.truncatedOutputBytes;
  const hasVisibleOutput = value.finalOutput.trim() !== "";

  if (hasVisibleOutput) {
    return removedBytes > 0
      ? {
          kind: "retained-prefix",
          removedBytes,
          output: value.finalOutput,
        }
      : { kind: "retained", output: value.finalOutput };
  }
  return removedBytes > 0
    ? { kind: "removed", removedBytes }
    : { kind: "absent" };
}
