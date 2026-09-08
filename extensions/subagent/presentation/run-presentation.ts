/**
 * A Run's presentation, resolved once from whichever shape a surface has.
 *
 * The surfaces that describe a live or captured Run — the ambient widget's
 * detail row, the dashboard history's table row, frozen inspection — each read
 * one of two published shapes: the repository's index row ({@link RunRowView})
 * or the domain's Run summary ({@link RunSummary}). The two carry the same
 * values under different field names, so each surface used to assemble the
 * resolver's input itself, and the assemblies drifted. The dashboard history
 * listed the terminal Run phases inline while the widget asked the domain, so
 * a sixth phase would have been adapted in one surface and misfiled in the
 * other with nothing failing.
 *
 * This module is the one derivation. A surface names the shape it holds and
 * gets back everything it needs to describe the Run: the Label, the status
 * word and its tone, the one activity cell, why the Run was cancelled, and the
 * instants an elapsed duration is read between. Whether a phase is terminal is
 * the domain's question: it is asked here for the presentation resolved here,
 * and the phase the answer was given for is published, so a surface with a
 * further question of its own asks it of the same value rather than of a shape
 * a stored Result has since overtaken.
 *
 * The phase policy the resolution reads — which word a phase gets, and in what
 * tone — stays in `status.ts`, which is where a sixth Run phase still has to be
 * given one before this compiles. What is decided here is what a cancellation
 * then does to that answer, and what the whole of it means for a Run in front
 * of a reader.
 *
 * Meaning only. How wide a Label may be, which columns a surface can afford,
 * and what any of it is painted in belong to `run-line.ts` and the surface
 * that draws it.
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
  runPhaseTone,
  runPhaseVerb,
  type Tone,
} from "./status.ts";
import type { RunRowView } from "./views.ts";

/** What the activity cell shows when the Run has nothing to say there. */
const NO_ACTIVITY = "—";

/** Everything a surface needs in order to describe one Run. */
export interface RunPresentation {
  /** The Run's Label: one line saying what this Run was given to do. */
  readonly label: string;
  /** The phase this presentation was resolved for, by the authoritative account. */
  readonly phase: RunPhase;
  /** The status word and the tone the shared phase policy gives it. */
  readonly status: {
    readonly text: string;
    readonly tone: Tone;
  };
  /**
   * The one activity cell, under one rule for every surface.
   *
   * Only a running, uncancelled Run shows current activity. A cancelled Run
   * may show its actual reason; every other case uses the placeholder.
   * Finalizing and cancelling Runs never revive previous tool activity.
   */
  readonly activity: string;
  /**
   * Outstanding request for a nonterminal Run, or actual cause for a cancelled
   * Run. Absent for completed/failed Runs and when the authoritative source
   * has no reason; retained requests are not terminal causes.
   */
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
interface RunPresentationInput {
  readonly label: string;
  readonly phase: RunPhase;
  readonly cancellationReason?: CancellationReason | undefined;
  readonly activity?: string | undefined;
  readonly lastActivity?: SemanticActivity | undefined;
  readonly startedAt: number;
  readonly settledAt?: number | undefined;
}

/**
 * Interpret phase, cancellation and activity once for every Run surface.
 *
 * Current activity is deliberately not recovered from retained last activity:
 * one says what is happening now and the other is historical context. A
 * recorded reason is what says a cancellation was requested, so a Run cannot
 * be shown as cancelling without one, or as carrying a reason nobody asked for.
 */
function resolve(run: RunPresentationInput): RunPresentation {
  const terminal = isTerminalRunPhase(run.phase);
  const cancellationReason =
    !terminal || run.phase === "cancelled" ? run.cancellationReason : undefined;
  const cancelling = cancellationReason !== undefined && !terminal;
  const ordinaryCancellation =
    run.phase === "cancelled" &&
    (run.cancellationReason === "requested" ||
      run.cancellationReason === "shutdown");
  const currentActivity =
    run.phase === "running" &&
    run.cancellationReason === undefined &&
    run.activity?.trim()
      ? run.activity
      : undefined;

  return {
    label: run.label,
    phase: run.phase,
    status: cancelling
      ? { text: "cancelling", tone: "warning" }
      : {
          text: runPhaseVerb(run.phase),
          tone: ordinaryCancellation ? "muted" : runPhaseTone(run.phase),
        },
    activity: (terminal ? cancellationReason : currentActivity) ?? NO_ACTIVITY,
    ...(cancellationReason === undefined ? {} : { cancellationReason }),
    ...(currentActivity === undefined ? {} : { currentActivity }),
    ...(run.lastActivity === undefined
      ? {}
      : { lastActivity: run.lastActivity }),
    executionNeedsAttention:
      run.phase === "failed" ||
      (run.phase === "cancelled" && run.cancellationReason === "timeout"),
    startedAt: run.startedAt,
    ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
  };
}

/** One Run as the published index publishes it: what the ambient widget holds. */
export function runPresentationFromRow(row: RunRowView): RunPresentation {
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
 * summary is a live index entry the capture may have raced. Result presence
 * selects the reason source, including authoritative absence.
 */
export function runPresentationFromSummary(
  run: RunSummary,
  result?: RunResult,
): RunPresentation {
  return resolve({
    label: result?.description ?? run.label,
    phase: result?.status ?? run.phase,
    cancellationReason:
      result !== undefined ? result.cancellationReason : run.cancellationReason,
    activity: run.activity,
    lastActivity: run.lastActivity,
    startedAt: result?.startedAt ?? run.startedAt,
    settledAt: result?.settledAt ?? run.settledAt,
  });
}

/**
 * Elapsed Run duration at the instant a surface is drawing at.
 *
 * Read separately from {@link RunPresentation} because what a Run *means* does
 * not depend on when it is read and how long it has been going does. A surface
 * that only files a Run by what it means would otherwise have to invent a
 * drawing instant to get an answer out of the derivation.
 */
export function runElapsed(run: RunPresentation, now: number): string {
  return formatRunElapsed(run, now);
}
