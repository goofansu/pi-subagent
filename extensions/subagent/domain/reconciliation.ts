/**
 * A backend's authoritative terminal snapshot.
 *
 * Every field is optional, and optionality is the whole semantics: a field
 * that is present *replaces* what was streamed, and a field that is absent
 * retains it. A backend with no terminal snapshot sends no reconciliation at
 * all and its streamed projection stands — it never fabricates one.
 *
 * Reconciliation happens before settlement, as the last ordered observation of
 * the Run, so it is not a late event healing a terminal Run.
 *
 * Two fields are declared more loosely than their observation counterparts,
 * and the looseness is the design rather than an oversight. `context` and
 * `turns` are checked for *shape* here and for *usability* in `reconcileRun`,
 * so a snapshot the domain cannot read one number of still heals the
 * transcript, the output, and the usage it also carried. Rejecting the whole
 * snapshot for one bad field is the opposite of what a snapshot is for.
 *
 * See docs/adr/0025-v2-terminal-settlement.md.
 */

import { Schema } from "effect";
import { TranscriptItem } from "./transcript.ts";
import { ContextGauge, UsageTotalsPatch } from "./usage.ts";

export const TerminalReconciliation = Schema.Struct({
  transcript: Schema.optionalKey(Schema.Array(TranscriptItem)),
  finalOutput: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(UsageTotalsPatch),
  context: Schema.optionalKey(ContextGauge),
  turns: Schema.optionalKey(Schema.Number),
  model: Schema.optionalKey(Schema.String),
});

export type TerminalReconciliation = typeof TerminalReconciliation.Type;
