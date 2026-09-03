/**
 * Codex notifications, as Run observations. Pure, and free of provider
 * vocabulary on the way out.
 *
 * Everything here is a function of the decoded notification plus this Run's
 * own accumulated state, and the state is **Run-local by construction**: the
 * translator is created per execution and discarded with it. That is what
 * makes "usage is Run-local" true by subtraction rather than by hope, and it
 * is why a resumed Run cannot be charged for the Turn before it.
 *
 * Four decisions are v1's, ported rather than reinvented, and each one was
 * learned from a real Codex transcript:
 *
 * - **A completed agent message whose phase is not `commentary` is the
 *   answer.** Older servers omit the phase entirely, so "not commentary" is
 *   the test rather than "equals final_answer" — and it is what makes a final
 *   answer that arrived before a cancel win over the cancel.
 * - **Activity is a preview, not a log.** A message delta extends a tail and
 *   the preview is the tail's last sentence; a command's output delta shows the
 *   command and its latest non-blank line; a reasoning summary shows its
 *   headline. All three are capped, so a Run that streams a megabyte of output
 *   grows the projection by nothing.
 * - **Usage is differenced against a baseline.** `tokenUsage.total` is
 *   *conversation*-cumulative, so every frame emits the increment since the
 *   previous frame and the first frame emits the increment since the baseline
 *   the Turn started from. The core sums those, so the Run's total is exactly
 *   its own work.
 * - **The context gauge is the last request's total, not the cumulative
 *   one.** This is the one place this module deliberately differs from the M6
 *   specification text, and the reason is that the two numbers measure
 *   different things: `total.totalTokens` is what the whole conversation has
 *   been billed for and grows without bound, while occupancy is what the model
 *   is carrying right now and is bounded by `modelContextWindow`. A gauge
 *   built from the cumulative figure would exceed its own denominator after
 *   two Turns, which the domain describes as "how much of a Conversation's
 *   context window is occupied". v1 chose `last` for exactly this reason and
 *   said so in a comment; the port keeps it.
 *
 * One thing this module deliberately does not do is decide anything about the
 * Run. Whether a Turn is over, whether guidance was confirmed, whether the
 * conversation is lost — those are the execution's, because they need state
 * the translator has no business holding.
 */

import path from "node:path";
import {
  type ContextGauge,
  type RunDiagnostic,
  type RunObservation,
  runDiagnostic,
  type UsageDelta,
} from "../../domain/index.ts";
import {
  CODEX_COMMENTARY_PHASE,
  type CodexCommandItem,
  type CodexItem,
  type CodexNotification,
  type CodexTokenBreakdown,
} from "./protocol.ts";

/** What a confined provider diagnostic says instead of provider text. */
export const CODEX_DIAGNOSTIC_REDACTED = "[redacted]";

/** What a provider error notification reports. */
export const CODEX_PROVIDER_ERROR_CATEGORY = "Codex reported an error";

/** What a completion frame carrying an error reports. */
export const CODEX_TURN_ERROR_CATEGORY = "the Codex Turn reported an error";

/**
 * Report that something Codex authored went wrong, without keeping what it
 * said.
 *
 * The category is the adapter's own and is the useful part at the seam; the
 * provider's string stays behind this call, unread. v1's provider-diagnostic
 * confinement, expressed in v2's typed diagnostic.
 */
export function confined(what: string): RunDiagnostic {
  return runDiagnostic(
    "backend-failure",
    `${what}: ${CODEX_DIAGNOSTIC_REDACTED}`,
  );
}

/** The same confinement, for guidance the server would not take. */
export function confinedControl(what: string): RunDiagnostic {
  return runDiagnostic("control", `${what}: ${CODEX_DIAGNOSTIC_REDACTED}`);
}

/** The same confinement, for a transport that stopped answering. */
export function confinedLoss(what: string): RunDiagnostic {
  return runDiagnostic(
    "transport-loss",
    `${what}: ${CODEX_DIAGNOSTIC_REDACTED}`,
  );
}

/* ============================================================== */
/* Bounds                                                          */
/* ============================================================== */

/** One line of activity, as wide as the widget can use. v1's number. */
export const ACTIVITY_LIMIT = 120;
/** Leave room after the command for its latest output line. */
const COMMAND_PREFIX_LIMIT = 60;
/** Only the tail of a command's output can become live activity. */
const OUTPUT_TAIL_LIMIT = 2048;
/** Cap memory and keep each delta's preview work constant. */
const MESSAGE_TAIL_LIMIT = 2048;
/** What a completed command's output summary is bounded to. */
const OUTPUT_SUMMARY_LIMIT = 512;

function collapsed(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function capped(value: string): string {
  return collapsed(value).slice(0, ACTIVITY_LIMIT);
}

/**
 * Deltas extend a message, so a tail cap keeps the preview current; reasoning
 * summaries are headlines, so their head cap preserves the lead.
 */
function cappedTail(value: string): string {
  return collapsed(value).slice(-ACTIVITY_LIMIT);
}

function appendTail(tail: string, delta: string, limit: number): string {
  return (tail + delta.slice(-limit)).slice(-limit);
}

/** The latest non-blank line, honouring carriage-return progress. */
function lastNonBlankLine(tail: string): string | undefined {
  const lines = tail.split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) return line;
  }
  return undefined;
}

function stripMarkdownEmphasis(value: string): string {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(?<![\w_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\w_])/g, "$1");
}

/** The last sentence of a streamed message, as one line of prose. */
export function codexMessagePreview(tail: string): string | undefined {
  const line = lastNonBlankLine(tail);
  if (!line || /^(```|~~~)/.test(line)) return undefined;
  // Whitespace after the terminator keeps decimals and versions together.
  const fragments = line.split(/(?<=[.!?])\s+/);
  let sentence: string | undefined;
  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index];
    if (fragment?.trim()) {
      sentence = fragment;
      break;
    }
  }
  if (!sentence) return undefined;
  const prose = stripMarkdownEmphasis(sentence)
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+)/, "")
    .trim();
  return prose ? cappedTail(prose) : undefined;
}

function commandProgress(command: string | undefined, line: string): string {
  if (!command) return capped(line);
  const prefix = collapsed(`$ ${command}`).slice(0, COMMAND_PREFIX_LIMIT);
  return capped(`${prefix} · ${line}`);
}

function relativePath(cwd: string, value: string): string {
  if (!path.isAbsolute(value)) return collapsed(value);
  const relative = path.relative(cwd, value);
  return collapsed(relative || path.basename(value));
}

function reasoningHeadline(summary: string): string | undefined {
  const firstLine = summary.split("\n", 1)[0] ?? "";
  const plain = firstLine.replace(/[*_~`]/g, "").trim();
  return plain ? capped(plain) : undefined;
}

/* ============================================================== */
/* Items as tools                                                  */
/* ============================================================== */

/**
 * The item kinds that are tool calls, and the tool name each reads as.
 *
 * These four and no others produce a `tool_call` part and the `tool_progress`
 * updates that join to it. A plan or a reasoning summary is not a tool call:
 * reporting progress for one would create a nameless entry in the Run's tool
 * list, because a progress update's `callId` creates an entry when it can
 * join nothing — and a Run whose tool list held its own thinking would read
 * as a Run that had called a tool nobody can name.
 */
export const CODEX_COMMAND_TOOL_NAME = "command_execution";
export const CODEX_FILE_CHANGE_TOOL_NAME = "file_change";
export const CODEX_WEB_SEARCH_TOOL_NAME = "web_search";

/** The command a command-execution item is really running. */
export function codexCommandOf(item: CodexCommandItem): string {
  const named = (item.commandActions ?? []).find((action) => action.command);
  return named?.command ?? item.command;
}

/** The tool name an item reads as, or nothing when it is not a tool call. */
export function codexToolName(item: CodexItem): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return CODEX_COMMAND_TOOL_NAME;
    case "fileChange":
      return CODEX_FILE_CHANGE_TOOL_NAME;
    case "mcpToolCall":
      return item.tool;
    case "webSearch":
      return CODEX_WEB_SEARCH_TOOL_NAME;
    default:
      return undefined;
  }
}

/** What the widget shows while an item is under way. */
export function codexItemActivity(
  item: CodexItem,
  cwd: string,
): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return capped(`$ ${codexCommandOf(item)}`);
    case "fileChange": {
      const first = item.changes[0]?.path;
      return first ? capped(`Editing ${relativePath(cwd, first)}`) : undefined;
    }
    case "reasoning":
      return "Thinking…";
    case "plan":
      return "Planning…";
    case "webSearch":
      return capped(`Searching: ${item.query}`);
    case "mcpToolCall":
      return capped(`Calling ${item.tool}…`);
    default:
      return undefined;
  }
}

/** Whether a completed tool item completed or failed. */
function completedToolStatus(item: CodexItem): "completed" | "failed" {
  if (item.type !== "commandExecution") return "completed";
  return item.status === "completed" ? "completed" : "failed";
}

/* ============================================================== */
/* Usage                                                          */
/* ============================================================== */

/** The counters this adapter differences. Every one of them is cumulative. */
export const CODEX_USAGE_COUNTERS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

export const ZERO_CODEX_USAGE: CodexTokenBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function counter(
  breakdown: CodexTokenBreakdown,
  field: (typeof CODEX_USAGE_COUNTERS)[number],
): number {
  return breakdown[field] ?? 0;
}

/** Whether a reading is smaller than the one before it: a provider reset. */
export function codexUsageReset(
  current: CodexTokenBreakdown,
  previous: CodexTokenBreakdown,
): boolean {
  return CODEX_USAGE_COUNTERS.some(
    (field) => counter(current, field) < counter(previous, field),
  );
}

/**
 * The increment between two cumulative readings, never negative.
 *
 * Reasoning output is folded into `output` because the domain has four
 * counters and reasoning tokens are output tokens the provider itemized. A
 * fifth field on the delta would be a field only this backend ever set.
 */
export function codexUsageDelta(
  current: CodexTokenBreakdown,
  previous: CodexTokenBreakdown,
): UsageDelta {
  const since = (field: (typeof CODEX_USAGE_COUNTERS)[number]): number =>
    Math.max(0, counter(current, field) - counter(previous, field));
  return {
    input: since("inputTokens"),
    output: since("outputTokens") + since("reasoningOutputTokens"),
    cacheRead: since("cachedInputTokens"),
    cacheWrite: since("cacheWriteInputTokens"),
  };
}

/** How much of the window the last request occupied. See the module comment. */
export function codexContextGauge(
  last: CodexTokenBreakdown,
  window: number | undefined,
): ContextGauge {
  return {
    tokens: counter(last, "totalTokens"),
    ...(window === undefined ? {} : { window }),
  };
}

/* ============================================================== */
/* The translator                                                  */
/* ============================================================== */

/** What one notification produced. */
export interface CodexTranslation {
  readonly observations: readonly RunObservation[];
  /**
   * A completed agent message whose phase was not commentary.
   *
   * The execution needs this and the translator cannot act on it: it is what
   * makes a Turn's answer survive a cancel that arrived afterwards.
   */
  readonly finalAnswer?: boolean;
  /** A non-retrying provider error, already confined. */
  readonly errorMessage?: string;
}

const NOTHING: CodexTranslation = { observations: [] };

export interface CodexTranslator {
  readonly notification: (notification: CodexNotification) => CodexTranslation;
  /** Turns counted: one per completed Turn. */
  readonly turns: () => number;
  /** Whether a final agent message has been seen. */
  readonly sawFinalAnswer: () => boolean;
}

export interface CodexTranslatorOptions {
  /** The Subagent's working directory, for relative file paths. */
  readonly cwd: string;
  /**
   * The conversation-cumulative total when this Turn began.
   *
   * Omitted for a Subagent's first Run, where the baseline is zero.
   */
  readonly baseline?: CodexTokenBreakdown;
  /**
   * Told the newest cumulative reading, so the next Run's baseline is right.
   *
   * The retained total lives on the BackendAgent rather than here, because it
   * outlives every Run and this translator does not.
   */
  readonly onCumulative?: (total: CodexTokenBreakdown) => void;
}

/** Build a translator for one Run. */
export function createCodexTranslator(
  options: CodexTranslatorOptions,
): CodexTranslator {
  const { cwd } = options;
  const commands = new Map<string, string>();
  const outputTails = new Map<string, string>();
  const messageTails = new Map<string, string>();
  const reasoningSummaries = new Map<string, string>();
  let previous = options.baseline ?? ZERO_CODEX_USAGE;
  let firstUsageFrame = true;
  let turns = 0;
  let sawFinalAnswer = false;

  const itemStarted = (item: CodexItem): CodexTranslation => {
    if (item.type === "commandExecution") {
      commands.set(item.id, codexCommandOf(item));
    }
    const observations: RunObservation[] = [];
    const name = codexToolName(item);
    if (name !== undefined) {
      observations.push({
        kind: "message",
        role: "assistant",
        parts: [{ kind: "tool_call", name, callId: item.id }],
      });
      observations.push({
        kind: "tool_progress",
        callId: item.id,
        status: "running",
      });
    }
    const activity = codexItemActivity(item, cwd);
    if (activity !== undefined)
      observations.push({ kind: "activity", activity });
    return { observations };
  };

  const itemCompleted = (item: CodexItem): CodexTranslation => {
    if (item.type === "agentMessage") {
      messageTails.delete(item.id);
      // Anything other than commentary is the answer; an omitted phase is an
      // older server, and treating it as terminal is what v1 settled on.
      const final = item.phase !== CODEX_COMMENTARY_PHASE;
      sawFinalAnswer ||= final;
      return {
        observations: [
          {
            kind: "message",
            role: "assistant",
            parts: item.text === "" ? [] : [{ kind: "text", text: item.text }],
          },
        ],
        finalAnswer: final,
      };
    }
    const name = codexToolName(item);
    if (name === undefined) return NOTHING;
    if (item.type === "commandExecution") {
      commands.delete(item.id);
      outputTails.delete(item.id);
    }
    const summary =
      item.type === "commandExecution" &&
      typeof item.aggregatedOutput === "string" &&
      item.aggregatedOutput !== ""
        ? collapsed(item.aggregatedOutput).slice(0, OUTPUT_SUMMARY_LIMIT)
        : undefined;
    return {
      observations: [
        {
          kind: "tool_progress",
          callId: item.id,
          status: completedToolStatus(item),
          ...(summary === undefined || summary === ""
            ? {}
            : { outputSummary: summary }),
        },
      ],
    };
  };

  const messageDelta = (itemId: string, delta: string): CodexTranslation => {
    const tail = appendTail(
      messageTails.get(itemId) ?? "",
      delta,
      MESSAGE_TAIL_LIMIT,
    );
    messageTails.set(itemId, tail);
    return {
      observations: [
        {
          kind: "activity",
          activity: codexMessagePreview(tail) ?? "Writing response…",
        },
      ],
    };
  };

  const outputDelta = (itemId: string, delta: string): CodexTranslation => {
    const tail = appendTail(
      outputTails.get(itemId) ?? "",
      delta,
      OUTPUT_TAIL_LIMIT,
    );
    outputTails.set(itemId, tail);
    const line = lastNonBlankLine(tail);
    if (line === undefined) return NOTHING;
    return {
      observations: [
        {
          kind: "activity",
          activity: commandProgress(commands.get(itemId), line),
        },
      ],
    };
  };

  const reasoningDelta = (itemId: string, delta: string): CodexTranslation => {
    const summary = (reasoningSummaries.get(itemId) ?? "") + delta;
    reasoningSummaries.set(itemId, summary);
    return {
      observations: [
        {
          kind: "activity",
          activity: reasoningHeadline(summary) ?? "Thinking…",
        },
      ],
    };
  };

  return {
    turns: () => turns,
    sawFinalAnswer: () => sawFinalAnswer,
    notification: (notification): CodexTranslation => {
      switch (notification.method) {
        case "item/started":
          return itemStarted(notification.item);
        case "item/completed":
          return itemCompleted(notification.item);
        case "item/agentMessage/delta":
          return messageDelta(notification.itemId, notification.delta);
        case "item/commandExecution/outputDelta":
          return outputDelta(notification.itemId, notification.delta);
        case "item/reasoning/summaryTextDelta":
          return reasoningDelta(notification.itemId, notification.delta);
        case "thread/tokenUsage/updated": {
          options.onCumulative?.(notification.total);
          // A reading below the baseline can only be a provider reset, and
          // only the Turn's first frame can see one: within a Turn the
          // cumulative figures only grow. Charging the new reading in full is
          // the honest answer; a negative delta is not available and dropping
          // the frame would lose real spend.
          const baseline =
            firstUsageFrame && codexUsageReset(notification.total, previous)
              ? ZERO_CODEX_USAGE
              : previous;
          firstUsageFrame = false;
          const delta = codexUsageDelta(notification.total, baseline);
          previous = notification.total;
          return {
            observations: [
              { kind: "usage", usage: delta },
              {
                kind: "context",
                context: codexContextGauge(
                  notification.last,
                  notification.contextWindow,
                ),
              },
            ],
          };
        }
        case "error": {
          if (notification.willRetry) {
            return {
              observations: [
                {
                  kind: "activity",
                  activity: "Retrying after a provider error…",
                },
              ],
            };
          }
          const diagnostic = confined(CODEX_PROVIDER_ERROR_CATEGORY);
          return {
            observations: [{ kind: "diagnostic", diagnostic }],
            errorMessage: diagnostic.message,
          };
        }
        case "turn/completed": {
          turns += 1;
          const observations: RunObservation[] = [
            { kind: "usage", usage: { turns: 1 } },
            { kind: "activity", activity: undefined },
          ];
          if (notification.errorMessage === undefined) {
            return { observations };
          }
          const diagnostic = confined(CODEX_TURN_ERROR_CATEGORY);
          return {
            observations: [{ kind: "diagnostic", diagnostic }, ...observations],
            errorMessage: diagnostic.message,
          };
        }
      }
    },
  };
}

/* ============================================================== */
/* Redaction                                                       */
/* ============================================================== */

/**
 * The JSON keys whose values are provider identities.
 *
 * Redacted by key rather than by value pattern, because these strings are
 * uuids and a pattern that matched uuids would also match one a user's own
 * output happened to contain. v1's list, unchanged.
 */
const IDENTITY_KEYS =
  /"(clientUserMessageId|expectedTurnId|correlationId|conversationId|requestId|threadId|turnId|itemId|sessionId|clientId|id)"\s*:\s*("[^"]*"|-?\d+)/g;

/**
 * Replace provider identities in text that is about to cross the boundary.
 *
 * Two passes, because there are two ways an identity appears in stderr: as the
 * value of a known key in a JSON fragment, and bare, because the server
 * mentioned the thread or turn it was talking about. The known identities are
 * replaced longest-first, so a turn id that contains a thread id as a prefix
 * cannot leave half of itself behind.
 */
export function redactCodexIdentities(
  value: string,
  identities: Iterable<string> = [],
): string {
  let redacted = value.replace(
    IDENTITY_KEYS,
    `"$1":"${CODEX_DIAGNOSTIC_REDACTED}"`,
  );
  const known = [...identities]
    .filter((identity) => identity !== "")
    .sort((left, right) => right.length - left.length);
  for (const identity of known) {
    redacted = redacted.split(identity).join(CODEX_DIAGNOSTIC_REDACTED);
  }
  return redacted;
}
