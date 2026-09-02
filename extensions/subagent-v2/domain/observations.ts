/**
 * The one vocabulary a backend reports in.
 *
 * Everything a backend witnesses crosses the boundary as a {@link
 * RunObservation}: messages, tool progress, activity, usage, context
 * occupancy, diagnostics, links, the model it actually ran, its terminal
 * snapshot, and how the Run ended. One union means the core has one reducer
 * and an adapter author has one list to implement.
 *
 * What is deliberately *not* here is provider bookkeeping. No observation
 * carries a thread id, turn id, item id, request id, correlation id, session
 * uuid, exit code, or backend stop word. The only provider-adjacent data that
 * crosses is a bounded typed {@link RunDiagnostic} and a bounded typed
 * {@link ResultLink}. Ordering and identity stay adapter-local.
 *
 * See docs/adr/0024-v2-observation-ordering.md.
 */

import type { RunDiagnostic } from "./diagnostics.ts";
import type { RunEnding } from "./endings.ts";
import type { ResultLink } from "./links.ts";
import type { TerminalReconciliation } from "./reconciliation.ts";
import type { MessagePart, MessageRole, ToolStatus } from "./transcript.ts";
import type { ContextGauge, UsageDelta } from "./usage.ts";

export const RUN_OBSERVATION_KINDS = [
  "message",
  "tool_progress",
  "activity",
  "usage",
  "context",
  "diagnostic",
  "link",
  "model",
  "reconciliation",
  "ending",
] as const;

export type RunObservationKind = (typeof RUN_OBSERVATION_KINDS)[number];

/** One message the backend witnessed, with the model that produced it. */
export interface MessageObservation {
  readonly kind: "message";
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  readonly model?: string;
}

/**
 * How one native tool call is going.
 *
 * `callId` is required here, unlike on a tool call part: a progress update
 * that cannot be joined to a call is not progress about anything.
 */
export interface ToolProgressObservation {
  readonly kind: "tool_progress";
  readonly callId: string;
  readonly status: ToolStatus;
  readonly outputSummary?: string;
}

/**
 * What the Run is doing right now.
 *
 * Display-only and conflated: the latest value wins and intermediate values
 * may be dropped. `undefined` clears it. Settlement clears it too, so a
 * settled Run is quiet.
 */
export interface ActivityObservation {
  readonly kind: "activity";
  readonly activity: string | undefined;
}

export interface UsageObservation {
  readonly kind: "usage";
  readonly usage: UsageDelta;
}

export interface ContextObservation {
  readonly kind: "context";
  readonly context: ContextGauge;
}

export interface DiagnosticObservation {
  readonly kind: "diagnostic";
  readonly diagnostic: RunDiagnostic;
}

export interface LinkObservation {
  readonly kind: "link";
  readonly link: ResultLink;
}

/** The model the backend actually ran, when it differs from what was asked. */
export interface ModelObservation {
  readonly kind: "model";
  readonly model: string;
}

export interface ReconciliationObservation {
  readonly kind: "reconciliation";
  readonly reconciliation: TerminalReconciliation;
}

/** The last observation a Run reduces. */
export interface EndingObservation {
  readonly kind: "ending";
  readonly ending: RunEnding;
}

export type RunObservation =
  | MessageObservation
  | ToolProgressObservation
  | ActivityObservation
  | UsageObservation
  | ContextObservation
  | DiagnosticObservation
  | LinkObservation
  | ModelObservation
  | ReconciliationObservation
  | EndingObservation;

/** Narrow the union to one kind, for exact-key-set tests and helpers. */
export type ObservationOfKind<K extends RunObservationKind> = Extract<
  RunObservation,
  { readonly kind: K }
>;

export function isRunObservationKind(
  value: unknown,
): value is RunObservationKind {
  return (RUN_OBSERVATION_KINDS as readonly unknown[]).includes(value);
}
