/**
 * A Run's presentation, resolved once from whichever shape a surface has.
 *
 * The surfaces that describe a live or captured Run — the ambient widget's
 * detail row, the dashboard history's table row, frozen inspection — each read
 * one of two published shapes: the repository's index row ({@link RunRowView})
 * or the domain's Run summary ({@link RunSummary}). The two carry the same
 * facts under different field names, so each surface used to assemble the
 * shared resolver's input itself, and the assemblies drifted. The dashboard
 * history listed the terminal Run phases inline while the widget asked the
 * domain, so a sixth phase would have been adapted in one surface and misfiled
 * in the other with nothing failing.
 *
 * This module is the one derivation. A surface names the shape it holds and
 * gets back everything it needs to describe the Run: the Label, the status
 * word and its tone, the one activity cell, why the Run was cancelled, and the
 * instants an elapsed duration is read between. Whether a phase is terminal is
 * the domain's question: it is asked here for the facts resolved here, and the
 * phase the answer was given for is published, so a surface with a further
 * question of its own asks it of the same value rather than of a shape a
 * stored Result has since overtaken.
 *
 * Meaning only. How wide a Label may be, which columns a surface can afford,
 * and what any of it is painted in stay with the surface that draws it.
 */

import {
  type CancellationReason,
  isTerminalRunPhase,
  type RunPhase,
  type RunResult,
  type RunSummary,
  type SemanticActivity,
} from "../domain/index.ts";
import {
  formatRunElapsed,
  type RunPresentation,
  resolveRunPresentation,
} from "./status.ts";
import type { RunRowView } from "./views.ts";

/** What the activity cell shows when the Run has nothing to say there. */
const NO_ACTIVITY = "—";

/** Everything a surface needs in order to describe one Run. */
export interface RunFacts {
  /** The Run's Label: one line saying what this Run was given to do. */
  readonly label: string;
  /** The phase these facts were resolved for, by the authoritative account. */
  readonly phase: RunPhase;
  /** The status word and the tone the shared phase policy gives it. */
  readonly status: RunPresentation["status"];
  /**
   * The one activity cell, under one rule for every surface.
   *
   * A live Run says what it is doing; a terminal one says why it was stopped,
   * or nothing at all. A terminal Run's last tool activity is deliberately
   * not its activity: that is history, and showing it beside a finished Run
   * reads as the Run's result.
   */
  readonly activity: string;
  /** Present once a cancellation has been recorded, whatever the phase. */
  readonly cancellationReason?: CancellationReason;
  /** What the Run is doing now. Absent unless it is running uncancelled. */
  readonly currentActivity?: string;
  /** The retained semantic summary and the instant it last changed. */
  readonly lastActivity?: SemanticActivity;
  /** Execution outcome only. Delivery and Conversation maintenance are not inputs. */
  readonly executionNeedsAttention: boolean;
  /** When the Run started, by the authoritative account of it. */
  readonly startedAt: number;
  /** When the Run settled. Present exactly when it has. */
  readonly settledAt?: number;
}

/** The fields both published shapes carry, under one set of names. */
interface RunFactsSource {
  readonly label: string;
  readonly phase: RunPhase;
  readonly cancellationReason?: CancellationReason | undefined;
  readonly activity?: string | undefined;
  readonly lastActivity?: SemanticActivity | undefined;
  readonly startedAt: number;
  readonly settledAt?: number | undefined;
}

function resolve(run: RunFactsSource): RunFacts {
  const presentation = resolveRunPresentation({
    phase: run.phase,
    cancellationRequested: run.cancellationReason !== undefined,
    cancellationReason: run.cancellationReason,
    activity: run.activity,
    lastActivity: run.lastActivity,
  });
  return {
    label: run.label,
    phase: run.phase,
    status: presentation.status,
    activity:
      (isTerminalRunPhase(run.phase)
        ? run.cancellationReason
        : presentation.currentActivity) ?? NO_ACTIVITY,
    ...(run.cancellationReason === undefined
      ? {}
      : { cancellationReason: run.cancellationReason }),
    ...(presentation.currentActivity === undefined
      ? {}
      : { currentActivity: presentation.currentActivity }),
    ...(presentation.lastActivity === undefined
      ? {}
      : { lastActivity: presentation.lastActivity }),
    executionNeedsAttention: presentation.executionNeedsAttention,
    startedAt: run.startedAt,
    ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
  };
}

/** One Run as the published index publishes it: what the ambient widget holds. */
export function runFactsFromRow(row: RunRowView): RunFacts {
  return resolve({
    label: row.identity.description,
    phase: row.phase,
    cancellationReason: row.cancellation?.reason,
    activity: row.activity,
    lastActivity: row.lastActivity,
    startedAt: row.startedAt,
    settledAt: row.settledAt,
  });
}

/**
 * One Run as the domain summarises it: what the dashboard and inspection hold.
 *
 * Inspection supplies the stored Result as well, because a captured Run whose
 * Result it has read has two accounts of itself and the stored one is
 * authoritative: it is the immutable value settlement produced, while the
 * summary is a live index entry the capture may have raced.
 */
export function runFactsFromSummary(
  run: RunSummary,
  result?: RunResult,
): RunFacts {
  return resolve({
    label: result?.description ?? run.label,
    phase: result?.status ?? run.phase,
    cancellationReason: result?.cancellationReason ?? run.cancellationReason,
    activity: run.activity,
    lastActivity: run.lastActivity,
    startedAt: result?.startedAt ?? run.startedAt,
    settledAt: result?.settledAt ?? run.settledAt,
  });
}

/**
 * Elapsed Run duration at the instant a surface is drawing at.
 *
 * Read separately from {@link RunFacts} because what a Run *means* does not
 * depend on when it is read and how long it has been going does. A surface
 * that only files a Run by what it means would otherwise have to invent a
 * drawing instant to get an answer out of the derivation.
 */
export function runElapsed(facts: RunFacts, now: number): string {
  return formatRunElapsed(facts, now);
}
