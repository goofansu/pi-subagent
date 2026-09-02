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
 * The union is one schema declaration, and that is what makes ADR-0024's rule
 * *checked* rather than trusted. Decoding it under `EXACT_KEYS` rejects an
 * unlisted key at any depth, including one nested inside a message part or
 * inside a usage delta. M1 needed a compile-time key-set table and a separate
 * runtime key walker to cover those two cases between them; the decoder covers
 * both.
 *
 * See docs/adr/0024-v2-observation-ordering.md and
 * docs/adr/0029-v2-effect-schema.md.
 */

import { Schema } from "effect";
import { RunDiagnostic } from "./diagnostics.ts";
import { RunEnding } from "./endings.ts";
import { ResultLink } from "./links.ts";
import { TerminalReconciliation } from "./reconciliation.ts";
import { MessagePart, MessageRole, ToolStatus } from "./transcript.ts";
import { UsableContextGauge, UsageDelta } from "./usage.ts";

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

export const RunObservationKind = Schema.Literals(RUN_OBSERVATION_KINDS);

export type RunObservationKind = typeof RunObservationKind.Type;

/** One message the backend witnessed, with the model that produced it. */
export const MessageObservation = Schema.Struct({
  kind: Schema.Literal("message"),
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  model: Schema.optionalKey(Schema.String),
});

export type MessageObservation = typeof MessageObservation.Type;

/**
 * How one native tool call is going.
 *
 * `callId` is required here, unlike on a tool call part: a progress update
 * that cannot be joined to a call is not progress about anything. There is no
 * entry it could join and none it could create.
 */
export const ToolProgressObservation = Schema.Struct({
  kind: Schema.Literal("tool_progress"),
  callId: Schema.String.check(Schema.isNonEmpty()),
  status: ToolStatus,
  outputSummary: Schema.optionalKey(Schema.String),
});

export type ToolProgressObservation = typeof ToolProgressObservation.Type;

/**
 * What the Run is doing right now.
 *
 * Display-only and conflated: the latest value wins and intermediate values
 * may be dropped. `undefined` clears it, and the key is required so that
 * clearing is something a backend says rather than something it omits.
 * Settlement clears it too, so a settled Run is quiet.
 */
export const ActivityObservation = Schema.Struct({
  kind: Schema.Literal("activity"),
  activity: Schema.UndefinedOr(Schema.String),
});

export type ActivityObservation = typeof ActivityObservation.Type;

export const UsageObservation = Schema.Struct({
  kind: Schema.Literal("usage"),
  usage: UsageDelta,
});

export type UsageObservation = typeof UsageObservation.Type;

export const ContextObservation = Schema.Struct({
  kind: Schema.Literal("context"),
  context: UsableContextGauge,
});

export type ContextObservation = typeof ContextObservation.Type;

export const DiagnosticObservation = Schema.Struct({
  kind: Schema.Literal("diagnostic"),
  diagnostic: RunDiagnostic,
});

export type DiagnosticObservation = typeof DiagnosticObservation.Type;

export const LinkObservation = Schema.Struct({
  kind: Schema.Literal("link"),
  link: ResultLink,
});

export type LinkObservation = typeof LinkObservation.Type;

/** The model the backend actually ran, when it differs from what was asked. */
export const ModelObservation = Schema.Struct({
  kind: Schema.Literal("model"),
  model: Schema.String.check(Schema.isNonEmpty()),
});

export type ModelObservation = typeof ModelObservation.Type;

export const ReconciliationObservation = Schema.Struct({
  kind: Schema.Literal("reconciliation"),
  reconciliation: TerminalReconciliation,
});

export type ReconciliationObservation = typeof ReconciliationObservation.Type;

/** The last observation a Run reduces. */
export const EndingObservation = Schema.Struct({
  kind: Schema.Literal("ending"),
  ending: RunEnding,
});

export type EndingObservation = typeof EndingObservation.Type;

export const RunObservation = Schema.Union([
  MessageObservation,
  ToolProgressObservation,
  ActivityObservation,
  UsageObservation,
  ContextObservation,
  DiagnosticObservation,
  LinkObservation,
  ModelObservation,
  ReconciliationObservation,
  EndingObservation,
]);

export type RunObservation = typeof RunObservation.Type;

/** Narrow the union to one kind, for helpers and for type-level tests. */
export type ObservationOfKind<K extends RunObservationKind> = Extract<
  RunObservation,
  { readonly kind: K }
>;

export const isRunObservationKind: (
  value: unknown,
) => value is RunObservationKind = Schema.is(RunObservationKind);
