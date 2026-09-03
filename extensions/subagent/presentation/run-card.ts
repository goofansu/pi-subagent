/**
 * `RunCard`: one Run, presented, from a snapshot or from a stored Result.
 *
 * The card is where Run presentation grows, and M4 is where it grew: identity,
 * status, duration, and accounting were M3's, and the recent transcript, the
 * tools with their statuses, the context gauge, the diagnostics, the links,
 * and the final output are this milestone's. Having one place for all of it
 * means the tool-result renderer, the notification renderer, and anything a
 * later adapter adds read the same card rather than each assembling their own
 * lines from the same fields in slightly different orders.
 *
 * There are exactly two sources, and the distinction is the point. A **live**
 * card comes from the published Run index and knows nothing about output,
 * because the index deliberately does not carry it. A **terminal** card comes
 * from the immutable stored Result and knows everything. Nothing else is a
 * source: a card built from a projection, a backend event, or a half-folded
 * observation would be presentation folding state, which is the thing the
 * layer is forbidden to do.
 *
 * Every expanded section is **omitted when it is empty** rather than printed
 * as a heading with nothing under it. A Run that used no tools did not use
 * zero tools; it has nothing to say about tools, and a reader scanning a card
 * should see only what happened.
 */

import type {
  ResultLink,
  RunDiagnostic,
  RunResult,
  ToolEntry,
  TranscriptItem,
} from "../domain/index.ts";
import {
  type NotificationAccounting,
  toNotificationAccounting,
  transcriptItemText,
} from "../domain/index.ts";
import { formatNotificationAccounting } from "./notification-text.ts";
import { formatResultBody } from "./result-body.ts";
import {
  formatRunPhase,
  formatTokenCount,
  runPhaseTone,
  type Tone,
} from "./status.ts";
import { elapsedMillis, type RunRowView } from "./views.ts";

/**
 * How many transcript items the expanded card shows.
 *
 * The projection holds up to five hundred, and a card that printed them all
 * would bury the answer it is supposed to be presenting. The most recent few
 * are what tell a reader how the Run got where it did; the rest is what
 * `agent_result`'s output and the Run's own tools already say.
 *
 * A presentation number, decided here, because it is about what is readable
 * rather than about what is bounded — the projection's own bound is the
 * runtime's business and is a different question.
 */
export const RECENT_TRANSCRIPT_ITEMS = 6;

export type RunCardSource =
  /** A Run that is still going, read from the published index. */
  | { readonly from: "live"; readonly row: RunRowView; readonly now: number }
  /** A Run that settled, read from its one immutable Result. */
  | { readonly from: "result"; readonly result: RunResult };

export interface RunCard {
  readonly runId: string;
  readonly subagentId: string;
  readonly agent: string;
  readonly description: string;
  readonly backendId: string;
  /** The status phrase, with the duration where the phase has one. */
  readonly status: string;
  readonly tone: Tone;
  /** Present when the Run reported anything to account for. */
  readonly accounting?: string;
  /**
   * How full the conversation's context window was when the Run ended.
   *
   * Separate from the accounting line because it is a gauge and the accounting
   * is a total: the two answer different questions, and a reader who saw them
   * joined by a middle dot would read the occupancy as something the Run
   * spent.
   */
  readonly context?: string;
  /**
   * The last few transcript items, oldest first, present only when there are
   * any. See {@link RECENT_TRANSCRIPT_ITEMS}.
   */
  readonly transcript?: readonly string[];
  /** One line per tool the Run used, with the status it ended in. */
  readonly tools?: readonly string[];
  /** What went wrong that was not the Run's ending, by category. */
  readonly diagnostics?: readonly string[];
  /** Pointers a backend produced: a native session file, a log, a URL. */
  readonly links?: readonly string[];
  /** What bounding dropped, when it dropped anything. */
  readonly truncation?: string;
  /**
   * The Run's answer, present only for a terminal card.
   *
   * A live card has none, and that is not a gap: the published index does not
   * carry output, so a live card that claimed to have it would be reading
   * something it is not allowed to read.
   */
  readonly output?: string;
}

/** One transcript item as a line: who said it, and what. */
export function formatTranscriptItem(item: TranscriptItem): string {
  const text = transcriptItemText(item).trim();
  const calls = item.parts
    .filter((part) => part.kind === "tool_call")
    .map((part) => (part.kind === "tool_call" ? part.name : ""));
  const said =
    text || (calls.length > 0 ? `calls ${calls.join(", ")}` : "(no text)");
  return `${item.role}: ${said}`;
}

/** One tool entry as a line: what it was, how it went, what it said. */
export function formatToolEntry(entry: ToolEntry): string {
  const summary = entry.outputSummary?.trim();
  return [
    `${entry.name ?? "(unnamed tool)"} — ${entry.status}`,
    ...(summary ? [`: ${summary}`] : []),
  ].join("");
}

/** One diagnostic as a line: the category, then what it said. */
export function formatDiagnosticLine(diagnostic: RunDiagnostic): string {
  return `${diagnostic.category}: ${diagnostic.message}`;
}

/** One link as a line: what kind of thing it points at, and where. */
export function formatResultLinkLine(link: ResultLink): string {
  return `${link.label} (${link.kind}): ${link.target}`;
}

/** The context gauge, with its window when the backend reported one. */
export function formatContextGauge(context: {
  readonly tokens: number;
  readonly window?: number;
}): string | undefined {
  if (context.tokens === 0) return undefined;
  const used = formatTokenCount(context.tokens);
  if (context.window === undefined || context.window === 0) {
    return `context ${used}`;
  }
  const percent = Math.round((context.tokens / context.window) * 100);
  return `context ${used} / ${formatTokenCount(context.window)} (${percent}%)`;
}

/**
 * What bounding removed, when it removed anything.
 *
 * A bounded projection is honest about being bounded, and this is where that
 * honesty reaches a reader. Silence means nothing was dropped.
 */
export function formatTruncation(result: RunResult): string | undefined {
  const dropped: string[] = [];
  const { truncation } = result;
  if (truncation.droppedTranscriptItems > 0) {
    dropped.push(`${truncation.droppedTranscriptItems} transcript items`);
  }
  if (truncation.droppedToolEntries > 0) {
    dropped.push(`${truncation.droppedToolEntries} tool entries`);
  }
  if (truncation.droppedDiagnostics > 0) {
    dropped.push(`${truncation.droppedDiagnostics} diagnostics`);
  }
  if (truncation.droppedLinks > 0) {
    dropped.push(`${truncation.droppedLinks} links`);
  }
  return dropped.length > 0
    ? `Dropped to stay within bounds: ${dropped.join(", ")}.`
    : undefined;
}

/** The last few transcript items, oldest first. */
function recentTranscript(
  transcript: readonly TranscriptItem[],
): readonly string[] {
  return transcript
    .slice(Math.max(0, transcript.length - RECENT_TRANSCRIPT_ITEMS))
    .map(formatTranscriptItem);
}

/** A section's lines, or nothing at all when the Run had none to show. */
function omitWhenEmpty<T>(values: readonly T[]): readonly T[] | undefined {
  return values.length > 0 ? values : undefined;
}

/**
 * The accounting line, or nothing when there was nothing to account for.
 *
 * The card and the notice print the same four figures in the same grammar, so
 * they share the formatter; the card's absence handling is here because a card
 * omits a *section* where a notice omits a paragraph.
 */
function accountingLine(
  accounting: NotificationAccounting | undefined,
): string | undefined {
  return accounting === undefined
    ? undefined
    : formatNotificationAccounting(accounting);
}

/** Build the card for one Run. */
export function runCard(source: RunCardSource): RunCard {
  if (source.from === "live") {
    const { row, now } = source;
    const accounting = accountingLine(toNotificationAccounting(row.usage));
    return {
      runId: row.identity.runId,
      subagentId: row.identity.subagentId,
      agent: row.identity.agent,
      description: row.identity.description,
      backendId: row.identity.backendId,
      status: formatRunPhase({
        phase: row.phase,
        elapsedMillis: elapsedMillis(row, now),
      }),
      tone: runPhaseTone(row.phase),
      ...(accounting === undefined ? {} : { accounting }),
    };
  }

  const { result } = source;
  const accounting = accountingLine(
    toNotificationAccounting(result.usage, result.model),
  );
  const context = formatContextGauge(result.usage.context);
  const transcript = omitWhenEmpty(recentTranscript(result.transcript));
  const tools = omitWhenEmpty(result.tools.map(formatToolEntry));
  const diagnostics = omitWhenEmpty(
    result.diagnostics.map(formatDiagnosticLine),
  );
  const links = omitWhenEmpty(result.links.map(formatResultLinkLine));
  const truncation = formatTruncation(result);
  return {
    runId: result.runId,
    subagentId: result.subagentId,
    agent: result.agent,
    description: result.description,
    backendId: result.backendId,
    status: formatRunPhase({
      phase: result.status,
      elapsedMillis: Math.max(0, result.settledAt - result.startedAt),
    }),
    tone: runPhaseTone(result.status),
    ...(accounting === undefined ? {} : { accounting }),
    ...(context === undefined ? {} : { context }),
    ...(transcript === undefined ? {} : { transcript }),
    ...(tools === undefined ? {} : { tools }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(links === undefined ? {} : { links }),
    ...(truncation === undefined ? {} : { truncation }),
    output: formatResultBody(result),
  };
}

/**
 * How a card names the Run it is about.
 *
 * One line, and the same line wherever a Run is identified: the agent a caller
 * asked for, the Subagent that owns the work, and the Run this particular
 * answer belongs to. A reader who has three ids in front of them and no idea
 * which is which has been given three strings.
 */
export function runCardIdentity(card: RunCard): string {
  return `${card.agent} (subagent ${card.subagentId}), run ${card.runId}`;
}

/** One titled block of lines, or nothing when there is nothing to title. */
function section(
  title: string,
  lines: readonly string[] | undefined,
): readonly string[] {
  if (lines === undefined || lines.length === 0) return [];
  return ["", `${title}:`, ...lines.map((line) => `  ${line}`)];
}

/**
 * The card as plain lines, for an expanded view.
 *
 * The order is what a reader wants in the order they want it: who and how it
 * went, then what it spent, then how it got there, then what went wrong, then
 * where to look next — and the answer last, because the answer is the part
 * they will keep reading.
 *
 * One blank line separates each block, and the body is separated the same way,
 * because the body is agent-authored Markdown and two adjacent paragraphs of
 * different voices read as one.
 */
export function runCardLines(card: RunCard): readonly string[] {
  const lines = [
    runCardIdentity(card),
    `${card.description} · ${card.backendId} · ${card.status}`,
    ...(card.accounting === undefined ? [] : [card.accounting]),
    ...(card.context === undefined ? [] : [card.context]),
    ...section("Recent transcript", card.transcript),
    ...section("Tools", card.tools),
    ...section("Diagnostics", card.diagnostics),
    ...section("Links", card.links),
    ...(card.truncation === undefined ? [] : ["", card.truncation]),
  ];
  if (card.output === undefined) return lines;
  return [...lines, "", card.output];
}

/**
 * The complete `agent_result` text: everything the card knows about the Run.
 *
 * Built from the card rather than from the Result directly, which is what
 * makes the card the one place Run presentation grows. M3's text was v1's —
 * the identity line and the body, and nothing else — and M4's is the expanded
 * body, reached by widening the card rather than by a second assembly of the
 * same fields somewhere else.
 */
export function formatResult(result: RunResult): string {
  const [identity, ...rest] = runCardLines(runCard({ from: "result", result }));
  return [`${identity}:`, ...rest].join("\n");
}
