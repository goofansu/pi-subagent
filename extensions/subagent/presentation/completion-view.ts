/**
 * One terminal Run, as the surfaces that describe it need it.
 *
 * A Run that has finished is readable from two places, each for a good reason:
 * the immutable `RunResult` (the card, which has everything) and the
 * `RunNotification` (the notice, which is self-sufficient so a push never
 * re-reads the store). Presentation can therefore pick the wrong one, and it
 * has: a row and a result card once printed two different durations for one
 * Run, because one measured against the draw's clock and the other against the
 * instant the Run settled.
 *
 * So the six facts both agree on are named once, and each source gets one
 * derivation into them. Duration is no longer among the things that can
 * diverge here at all: every surface — this one, the widget's row and the
 * dashboard's — now reads {@link runElapsedMillis}, which is the one rule for
 * what a Run cost. The published row's derivation used to live here too, and
 * went when that rule arrived: it had no caller left once the row read the
 * policy directly.
 *
 * **A view, not a service and not a schema.** Nothing constructs one to keep
 * it; it is derived where it is read and thrown away. No source gains a field
 * for it: every one of the six is something all three already carry, which is
 * why the equality test below can build one Run three ways and compare.
 */

import type {
  RunId,
  RunNotification,
  RunResult,
  SubagentId,
  TerminalRunPhase,
} from "../domain/index.ts";
import { runElapsedMillis } from "./status.ts";

/** What a terminal Run is, to anything that prints its status and duration. */
export interface RunCompletionView {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
  readonly agent: string;
  /** The Run's label: the bounded one-line description its caller gave. */
  readonly label: string;
  readonly status: TerminalRunPhase;
  /** Settled instant less started instant. Never a reading of the draw's clock. */
  readonly durationMillis: number;
}

/** The view for a stored Result, which carries all six directly. */
export function completionViewOfResult(result: RunResult): RunCompletionView {
  return {
    runId: result.runId,
    subagentId: result.subagentId,
    agent: result.agent,
    label: result.description,
    status: result.status,
    // Terminal by construction, so the policy needs no instant of the draw.
    durationMillis:
      runElapsedMillis({
        phase: result.status,
        startedAt: result.startedAt,
        settledAt: result.settledAt,
      }) ?? 0,
  };
}

/** The view for a completion notice, which is derived from a Result. */
export function completionViewOfNotification(
  notice: RunNotification,
): RunCompletionView {
  return {
    runId: notice.runId,
    subagentId: notice.subagentId,
    agent: notice.agent,
    label: notice.label,
    status: notice.status,
    durationMillis: notice.durationMillis,
  };
}
