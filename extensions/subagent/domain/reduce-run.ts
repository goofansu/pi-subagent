/**
 * `reduceRun`: the one function that turns observations into a Run.
 *
 * Adapters emit observations; this folds them. No adapter, host handler, or
 * presentation code writes to a projection, which makes the reduction order
 * the only thing that determines what a Run looks like.
 *
 * It is pure, and it has no side effects even for the things a runtime wants
 * to know about. Instead of logging, it *reports*: every call returns the next
 * projection and an {@link AppliedReport} saying whether the observation was
 * applied, ignored as late, ignored as malformed, or applied with something
 * truncated. The runtime turns those reports into diagnostics; the reducer
 * stays a function of its inputs.
 *
 * Three rules are worth naming because they are the ones that go wrong:
 *
 * - **Tools merge by call id.** A streamed tool call and the tool-progress
 *   observations about it are one entry, in either order. A progress
 *   observation that arrives before its call creates a placeholder the call
 *   fills in, so an adapter's ordering at its own boundary cannot duplicate a
 *   tool.
 * - **A terminal projection is absorbing.** After the ending, every later
 *   observation — including a second ending and a reconciliation — is reported
 *   as late and changes nothing.
 * - **Activity is conflated, not accumulated.** The latest value wins and the
 *   ending clears it, so a settled Run is quiet and a fast progress stream
 *   cannot grow the projection.
 *
 * See docs/adr/0024-v2-observation-ordering.md.
 */

import {
  boundList,
  boundObservation,
  type TruncationEvent,
} from "./bounding.ts";
import { unfinishedToolStatusForEnding } from "./endings.ts";
import {
  decodeRunObservation,
  type RunObservation,
  type RunObservationKind,
} from "./observations.ts";
import {
  DEFAULT_PROJECTION_BOUNDS,
  type ProjectionBounds,
  type RunProjection,
  type TruncationRecord,
} from "./projection.ts";
import {
  type ReconciledField,
  reconcileBoundedRun,
  reconciliationDifference,
} from "./reconcile-run.ts";
import type { ToolEntry } from "./transcript.ts";
import { addUsageDelta, replaceContextGauge } from "./usage.ts";

/**
 * What one call to {@link reduceRun} did.
 *
 * `notes` carries things the runtime may want to say out loud but that are not
 * errors — a tool call with no call id being the one M1 produces. It is on the
 * report rather than in the projection because the projection is the Run, and
 * a note about how the Run was reported is not part of what the Run said.
 *
 * `changed` accompanies a reconciliation's report and no other's: it is the set
 * of projection fields the snapshot actually altered, carried even when it is
 * empty. A caller going through the reducer therefore learns whether a
 * snapshot *disagreed* with the stream without calling {@link reconcileRun}
 * itself, which is what makes counting differences possible on every path a
 * reconciliation can arrive by.
 *
 * It is optional on the type because these two report shapes serve every
 * observation kind and only one kind has a change set. So a reader must treat
 * an absent set and an empty one alike — both mean nothing disagreed — rather
 * than reading absence as "not checked".
 */
export type AppliedReport =
  | {
      readonly report: "applied";
      readonly notes?: readonly string[];
      readonly changed?: readonly ReconciledField[];
    }
  | {
      readonly report: "applied-with-truncation";
      readonly dropped: readonly TruncationEvent[];
      readonly notes?: readonly string[];
      readonly changed?: readonly ReconciledField[];
    }
  | { readonly report: "ignored-late"; readonly kind: RunObservationKind }
  | {
      readonly report: "ignored-invalid";
      readonly kind: RunObservationKind;
      readonly reason: string;
    };

export interface ReduceOutcome {
  readonly projection: RunProjection;
  readonly report: AppliedReport;
}

/** The note a tool call with no call id produces. */
export function missingCallIdNote(name: string): string {
  return `tool call '${name}' carries no call id; kept as a distinct tool`;
}

/**
 * Why an observation cannot be reduced, or `undefined` when it can.
 *
 * The reducer checks rather than trusts, because a malformed observation is an
 * adapter defect and the honest answer to one is to report it and carry on —
 * not to throw inside a fold, and not to write nonsense into a Run. The
 * argument is typed, and the check still runs: a type is a promise an adapter
 * makes, and an adapter that breaks it is exactly the case this is here for.
 *
 * The reason text is the formatted schema issue, which names what was expected
 * and the key path it was expected at, and never the value it rejected.
 */
export function observationProblem(
  observation: RunObservation,
): string | undefined {
  const decoded = decodeRunObservation(observation);
  return decoded._tag === "Failure" ? decoded.failure.message : undefined;
}

function mergeToolEntry(
  tools: readonly ToolEntry[],
  callId: string,
  update: (existing: ToolEntry | undefined) => ToolEntry,
): readonly ToolEntry[] {
  const index = tools.findIndex((entry) => entry.callId === callId);
  if (index === -1) return [...tools, update(undefined)];
  const merged = [...tools];
  merged[index] = update(tools[index]);
  return merged;
}

function withTruncation(
  projection: RunProjection,
  patch: Partial<TruncationRecord>,
): RunProjection {
  return { ...projection, truncation: { ...projection.truncation, ...patch } };
}

function droppedAmount(
  dropped: readonly TruncationEvent[],
  of: TruncationEvent["of"],
): number {
  return dropped
    .filter((event) => event.of === of)
    .reduce((total, event) => total + event.amount, 0);
}

/**
 * Append one entry to a bounded projection list, keeping the newest and
 * recording what went.
 *
 * The transcript and the tool list cannot use this — each does more than
 * append — but diagnostics and links are exactly this operation over two
 * different fields.
 */
function appendBounded<
  L extends "diagnostics" | "links",
  R extends "droppedDiagnostics" | "droppedLinks",
>(
  projection: RunProjection,
  dropped: TruncationEvent[],
  entry: RunProjection[L][number],
  field: { readonly list: L; readonly record: R; readonly max: number },
): RunProjection {
  const kept = boundList(
    [...projection[field.list], entry],
    field.max,
    field.list,
  );
  dropped.push(...kept.dropped);
  return withTruncation(
    { ...projection, [field.list]: kept.items },
    { [field.record]: projection.truncation[field.record] + kept.droppedItems },
  );
}

function applied(
  projection: RunProjection,
  dropped: readonly TruncationEvent[],
  notes: readonly string[],
  changed?: readonly ReconciledField[],
): ReduceOutcome {
  const extra = {
    ...(notes.length > 0 ? { notes } : {}),
    ...(changed === undefined ? {} : { changed }),
  };
  if (dropped.length > 0) {
    return {
      projection,
      report: { report: "applied-with-truncation", dropped, ...extra },
    };
  }
  return { projection, report: { report: "applied", ...extra } };
}

/**
 * Fold one observation into a projection.
 *
 * Deterministic in the strongest sense: the same projection and the same
 * observation always produce the same next projection and the same report.
 * Nothing here reads a clock, a random source, or anything outside its
 * arguments.
 */
export function reduceRun(
  projection: RunProjection,
  observation: RunObservation,
  bounds: ProjectionBounds = DEFAULT_PROJECTION_BOUNDS,
): ReduceOutcome {
  if (projection.terminal) {
    // Absorbing, and deliberately checked before validity: a terminal Run
    // ignores everything, and "late" is the more useful thing to report about
    // an observation that arrived after settlement.
    return {
      projection,
      report: { report: "ignored-late", kind: observation.kind },
    };
  }

  const problem = observationProblem(observation);
  if (problem !== undefined) {
    return {
      projection,
      report: {
        report: "ignored-invalid",
        kind: observation.kind,
        reason: problem,
      },
    };
  }

  const bounded = boundObservation(observation, bounds);
  observation = bounded.observation;
  const dropped: TruncationEvent[] = [...bounded.dropped];
  const notes: string[] = [];

  switch (observation.kind) {
    case "message": {
      const item = {
        role: observation.role,
        parts: observation.parts,
        ...(observation.model === undefined
          ? {}
          : { model: observation.model }),
      };
      const kept = boundList(
        [...projection.transcript, item],
        bounds.maxTranscriptItems,
        "transcript",
      );
      dropped.push(...kept.dropped);

      // Tool calls in this message join the tool projection by call id. A
      // progress observation may already have created the entry.
      let tools = projection.tools;
      for (const part of observation.parts) {
        if (part.kind !== "tool_call") continue;
        if (part.callId === undefined) {
          // Never invent an id: a made-up id could collide with a real one and
          // merge two unrelated tools into one.
          notes.push(missingCallIdNote(part.name));
          tools = [...tools, { name: part.name, status: "running" }];
          continue;
        }
        const callId = part.callId;
        tools = mergeToolEntry(tools, callId, (existing) => ({
          ...existing,
          callId,
          name: part.name,
          status: existing?.status ?? "running",
        }));
      }
      const boundedTools = boundList(tools, bounds.maxToolEntries, "tools");
      dropped.push(...boundedTools.dropped);

      let next: RunProjection = {
        ...projection,
        transcript: kept.items,
        tools: boundedTools.items,
        ...(observation.model === undefined
          ? {}
          : { model: observation.model }),
      };
      next = withTruncation(next, {
        droppedTranscriptItems:
          projection.truncation.droppedTranscriptItems + kept.droppedItems,
        droppedToolEntries:
          projection.truncation.droppedToolEntries + boundedTools.droppedItems,
        truncatedTranscriptBytes:
          projection.truncation.truncatedTranscriptBytes +
          droppedAmount(bounded.dropped, "transcript-text"),
      });

      // An assistant message that only calls tools has not answered anything,
      // so it leaves the previous answer standing. The answer was bounded
      // independently from transcript parts in the one observation step.
      if (bounded.assistantOutput !== undefined) {
        next = withTruncation(
          { ...next, finalOutput: bounded.assistantOutput.text },
          { truncatedOutputBytes: bounded.assistantOutput.cutBytes },
        );
      }
      return applied(next, dropped, notes);
    }

    case "tool_progress": {
      const callId = observation.callId;
      const tools = mergeToolEntry(projection.tools, callId, (existing) => ({
        ...existing,
        callId,
        status: observation.status,
        ...(observation.outputSummary === undefined
          ? {}
          : { outputSummary: observation.outputSummary }),
      }));
      const kept = boundList(tools, bounds.maxToolEntries, "tools");
      dropped.push(...kept.dropped);
      return applied(
        withTruncation(
          { ...projection, tools: kept.items },
          {
            droppedToolEntries:
              projection.truncation.droppedToolEntries + kept.droppedItems,
            // A progress update replaces its summary, so this records what is
            // missing from the summary currently shown rather than history.
            truncatedToolOutputBytes:
              observation.outputSummary === undefined
                ? projection.truncation.truncatedToolOutputBytes
                : droppedAmount(bounded.dropped, "tool-output"),
          },
        ),
        dropped,
        notes,
      );
    }

    case "activity": {
      // Conflated and display-only: one value, replaced rather than
      // accumulated, and cleared by the ending. A cut is reported but not
      // accumulated because earlier activity is no longer in the projection.
      const activity =
        observation.activity === undefined || observation.activity.trim() === ""
          ? undefined
          : observation.activity;
      const next = { ...projection };
      if (activity === undefined)
        delete (next as { activity?: string }).activity;
      else (next as { activity?: string }).activity = activity;
      return applied(next, dropped, notes);
    }

    case "usage":
      return applied(
        {
          ...projection,
          usage: addUsageDelta(projection.usage, observation.usage),
        },
        dropped,
        notes,
      );

    case "context":
      return applied(
        {
          ...projection,
          usage: replaceContextGauge(projection.usage, observation.context),
        },
        dropped,
        notes,
      );

    // Diagnostics and links are one operation over two fields: append an
    // entry, keep the newest, add what went to the record.
    case "diagnostic":
      return applied(
        appendBounded(projection, dropped, observation.diagnostic, {
          list: "diagnostics",
          record: "droppedDiagnostics",
          max: bounds.maxDiagnostics,
        }),
        dropped,
        notes,
      );

    case "link":
      return applied(
        appendBounded(projection, dropped, observation.link, {
          list: "links",
          record: "droppedLinks",
          max: bounds.maxLinks,
        }),
        dropped,
        notes,
      );

    case "model":
      return applied(
        { ...projection, model: observation.model },
        dropped,
        notes,
      );

    case "reconciliation": {
      const reconciled = reconcileBoundedRun(
        projection,
        observation.reconciliation,
        bounds,
        bounded.dropped,
      );
      dropped.push(...reconciled.dropped);
      let next = reconciled.projection;
      // A snapshot that disagreed says so in the Run itself, not only in a
      // Session-wide counter. The diagnostic is core-authored, so it carries a
      // real message; a snapshot that restated the stream appends nothing, and
      // an ordinary answered Run still settles with an empty list.
      if (reconciled.changed.length > 0) {
        next = appendBounded(
          next,
          dropped,
          reconciliationDifference(reconciled.changed),
          {
            list: "diagnostics",
            record: "droppedDiagnostics",
            max: bounds.maxDiagnostics,
          },
        );
      }
      return applied(next, dropped, notes, reconciled.changed);
    }

    case "ending": {
      const ending = observation.ending;
      const status = unfinishedToolStatusForEnding(ending);
      const next: RunProjection = {
        ...projection,
        terminal: true,
        ending,
        tools: projection.tools.map((entry) =>
          entry.status === "running" ? { ...entry, status } : entry,
        ),
      };
      // A settled Run is quiet.
      delete (next as { activity?: string }).activity;
      return applied(next, dropped, notes);
    }
  }
}
