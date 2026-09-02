/**
 * How a Run finished, in the only vocabulary that crosses the boundary.
 *
 * An ending says how the work stopped and nothing else. It carries no exit
 * code, no backend stop word, and no usage: what a Run spent is a separate
 * projection, and what a provider called its stop condition is adapter-local.
 * A `failed` ending's message is a *fallback* — an observation-borne
 * explanation is better, and reconciliation may supply a better one still.
 *
 * See docs/adr/0010-run-endings.md and docs/adr/0025-v2-terminal-settlement.md.
 */

import type {
  CancellationReason,
  RunEvent,
  TerminalRunPhase,
} from "./phases.ts";
import { boundText } from "./text.ts";

export const RUN_ENDING_KINDS = ["answered", "failed", "cancelled"] as const;

export type RunEndingKind = (typeof RUN_ENDING_KINDS)[number];

/** Bound on the fallback message a failed ending may carry. */
export const RUN_ENDING_MESSAGE_MAX_BYTES = 2048;

export type RunEnding =
  | { readonly ending: "answered" }
  | { readonly ending: "failed"; readonly message?: string }
  | { readonly ending: "cancelled"; readonly reason: CancellationReason };

export function answeredEnding(): RunEnding {
  return { ending: "answered" };
}

export function failedEnding(message?: string): RunEnding {
  if (message === undefined) return { ending: "failed" };
  const oneLine = message.replace(/[\r\n]+/g, " ").trim();
  return {
    ending: "failed",
    message: boundText(oneLine, RUN_ENDING_MESSAGE_MAX_BYTES).text,
  };
}

export function cancelledEnding(reason: CancellationReason): RunEnding {
  return { ending: "cancelled", reason };
}

/** The one terminal phase an ending resolves to. */
export function terminalPhaseForEnding(ending: RunEnding): TerminalRunPhase {
  switch (ending.ending) {
    case "answered":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** The settlement event that reaches that phase from `finalizing`. */
export function settlementEventForEnding(ending: RunEnding): RunEvent {
  switch (ending.ending) {
    case "answered":
      return "settled-answered";
    case "failed":
      return "settled-failed";
    case "cancelled":
      return "settled-cancelled";
  }
}
