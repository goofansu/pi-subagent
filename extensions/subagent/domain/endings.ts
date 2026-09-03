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

import { Schema } from "effect";
import {
  CancellationReason,
  type SettlementEvent,
  type TerminalRunPhase,
} from "./phases.ts";
import { boundOneLine } from "./text.ts";
import type { ToolEntryStatus } from "./transcript.ts";

export const RUN_ENDING_KINDS = ["answered", "failed", "cancelled"] as const;

export const RunEndingKind = Schema.Literals(RUN_ENDING_KINDS);

export type RunEndingKind = typeof RunEndingKind.Type;

/** Bound on the fallback message a failed ending may carry. */
export const RUN_ENDING_MESSAGE_MAX_BYTES = 2048;

export const RunEnding = Schema.Union([
  Schema.Struct({ ending: Schema.Literal("answered") }),
  Schema.Struct({
    ending: Schema.Literal("failed"),
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ending: Schema.Literal("cancelled"),
    reason: CancellationReason,
  }),
]);

export type RunEnding = typeof RunEnding.Type;

export function answeredEnding(): RunEnding {
  return { ending: "answered" };
}

export function failedEnding(message?: string): RunEnding {
  if (message === undefined) return { ending: "failed" };
  return {
    ending: "failed",
    message: boundOneLine(message, RUN_ENDING_MESSAGE_MAX_BYTES),
  };
}

export function cancelledEnding(reason: CancellationReason): RunEnding {
  return { ending: "cancelled", reason };
}

/**
 * What each ending means downstream, as one table.
 *
 * Three things are derived from an ending — the terminal phase it reaches, the
 * settlement event that gets there, and the status a tool that never reported
 * an outcome is marked with — and they were three separate switches on the
 * same three-member union. One row per ending keeps them together, so adding a
 * fourth ending is one edit and the compiler names what is missing.
 *
 * `unfinishedTool` is `unfinished` for an answered Run rather than `completed`
 * or `failed`: the Run answered, so the tool did not fail, but it never said
 * how it went either.
 */
export const ENDING_CONSEQUENCES: {
  readonly [K in RunEndingKind]: {
    readonly phase: TerminalRunPhase;
    readonly event: SettlementEvent;
    readonly unfinishedTool: ToolEntryStatus;
  };
} = {
  answered: {
    phase: "completed",
    event: "settled-answered",
    unfinishedTool: "unfinished",
  },
  failed: {
    phase: "failed",
    event: "settled-failed",
    unfinishedTool: "failed",
  },
  cancelled: {
    phase: "cancelled",
    event: "settled-cancelled",
    unfinishedTool: "cancelled",
  },
};

/** The one terminal phase an ending resolves to. */
export function terminalPhaseForEnding(ending: RunEnding): TerminalRunPhase {
  return ENDING_CONSEQUENCES[ending.ending].phase;
}

/** The settlement event that reaches that phase from `finalizing`. */
export function settlementEventForEnding(ending: RunEnding): SettlementEvent {
  return ENDING_CONSEQUENCES[ending.ending].event;
}

/** The status settlement writes onto a tool that never reported an outcome. */
export function unfinishedToolStatusForEnding(
  ending: RunEnding,
): ToolEntryStatus {
  return ENDING_CONSEQUENCES[ending.ending].unfinishedTool;
}
