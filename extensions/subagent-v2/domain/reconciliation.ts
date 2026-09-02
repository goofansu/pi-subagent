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
 * See docs/adr/0025-v2-terminal-settlement.md.
 */

import type { TranscriptItem } from "./transcript.ts";
import type { ContextGauge, UsageTotalsPatch } from "./usage.ts";

export interface TerminalReconciliation {
  readonly transcript?: readonly TranscriptItem[];
  readonly finalOutput?: string;
  readonly usage?: UsageTotalsPatch;
  readonly context?: ContextGauge;
  readonly turns?: number;
  readonly model?: string;
}
