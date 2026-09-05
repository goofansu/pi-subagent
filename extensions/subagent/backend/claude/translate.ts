/**
 * Claude's Query frames, as Run observations. Total, and free of provider
 * vocabulary on the way out.
 *
 * Everything here takes `unknown` and checks, rather than taking the SDK's
 * declared frame types and trusting them. That is not distrust of the SDK — it
 * is that a resumed Query replays history, the frame union has forty members
 * and grows, and this is the one place a provider's own vocabulary would
 * otherwise cross the boundary. A frame shape this module does not recognize
 * produces nothing rather than a failure, because a provider that adds a
 * content block must not be able to fail a Run.
 *
 * Three concerns require state, all **Run-local by construction** — the
 * translator is created per execution and discarded with it:
 *
 * - **Usage differencing.** `modelUsage` and `total_cost_usd` are *cumulative
 *   across the turns of one Query*, so each result frame carries the running
 *   total rather than that turn's spend. A Run that summed them would charge
 *   itself several times over, and a resumed Run that reported them raw would
 *   be charged for the whole conversation. Every result frame is differenced
 *   against the previous one, with a smaller reading read as a provider reset
 *   rather than as a negative delta.
 * - **Turn counting.** The SDK emits one assistant frame per completed content
 *   block, and sidechain replies use the same frame type. So a provider turn is
 *   one unique *root* assistant message id — not one assistant frame — and the
 *   result frame's own `num_turns` may only *raise* the count, never lower it.
 *   A cancelled Run has already made real progress and must not have it erased.
 * - **Streaming activity.** Partial-message block starts become thinking,
 *   writing, or a bare tool name only when that activity changes. Deltas carry
 *   no retained text and every other streaming event is discarded.
 *
 * The other decision worth naming is the one the spike forced. `modelUsage`
 * reports every model the Query pipeline ran, including ones the Profile never
 * asked for — the spike saw a single-model Run charged for a second, internal
 * model. Summing every entry is what ADR-0027 chose: the Run really did cause
 * that spend, and reading only the requested model's entry would undercount.
 * The **context gauge** is the opposite case, because occupancy is not additive
 * — it is read from the primary model's entry alone, and omitted when that
 * entry is not there rather than guessed at from another model's window.
 */

import {
  type ContextGauge,
  type MessagePart,
  type RunDiagnostic,
  type RunObservation,
  runDiagnostic,
  type UsageDelta,
} from "../../domain/index.ts";
import { toolActivity } from "../activity.ts";

/** What a confined provider diagnostic says instead of provider text. */
export const CLAUDE_DIAGNOSTIC_REDACTED = "[redacted]";

/**
 * Report that something Claude authored went wrong, without keeping what it
 * said.
 *
 * The category is the adapter's own and is the useful part at the seam; the
 * provider's string stays here, unread. v1's provider-diagnostic confinement,
 * expressed in v2's typed diagnostic.
 */
export function confined(what: string): RunDiagnostic {
  return runDiagnostic(
    "backend-failure",
    `${what}: ${CLAUDE_DIAGNOSTIC_REDACTED}`,
  );
}

/** The same confinement, for guidance the Query could not be given. */
export function confinedControl(what: string): RunDiagnostic {
  return runDiagnostic("control", `${what}: ${CLAUDE_DIAGNOSTIC_REDACTED}`);
}

/**
 * A conversation identity, as the SDK spells one.
 *
 * Checked rather than trusted because this string is the *only* thing a
 * Subagent retains between Runs, and a malformed one would be handed back to
 * the SDK as a resume target on the next Run. v1's pattern, unchanged.
 */
export const CLAUDE_IDENTITY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isClaudeIdentity(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_IDENTITY_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One of the domain's counters: a whole, nonnegative number, or nothing. */
function readCounter(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

/** A real-valued amount, which cost is and no counter is. */
function readAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/* ============================================================== */
/* Reading one frame                                               */
/* ============================================================== */

/** The frame kinds this adapter has any use for. */
export type ClaudeFrameKind =
  | "init"
  | "assistant"
  | "user"
  | "stream"
  | "result"
  | "other";

/**
 * One Query frame, read once, into something with no wire in it.
 *
 * Every field is a Run-state decision the *execution* has to make and the
 * translator cannot: whether this frame is replayed history, whether it is the
 * attachment boundary, whether it confirms outstanding guidance, and whether
 * it ends the Run. The translator's own job — turning content into
 * observations — is below, and it is handed the reading rather than the frame.
 */
export interface ClaudeFrameReading {
  readonly kind: ClaudeFrameKind;
  /** The frame itself, for the content readers below and nothing else. */
  readonly frame: Record<string, unknown>;
  /** The provider marked this frame as replayed history. */
  readonly isReplay: boolean;
  /**
   * This frame carries the conversation identity authoritatively.
   *
   * The init frame of a fresh Query and every result frame. A resumed Query
   * may replay user, assistant, and system history *before* its boundary, and
   * none of that is this Run's work.
   */
  readonly isIdentityBoundary: boolean;
  /** The conversation identity this frame claims, unchecked. */
  readonly identity: unknown;
  /** This frame's own uuid. On a user frame, the input it echoes. */
  readonly uuid: unknown;
  /** On a result frame, the input uuid the provider correlated the turn to. */
  readonly correlation: unknown;
  /** The provider marked this result as an error. */
  readonly isError: boolean;
  /** A user frame carrying a tool result, as opposed to a steering echo. */
  readonly isToolResult: boolean;
}

function frameKind(frame: Record<string, unknown>): ClaudeFrameKind {
  if (frame.type === "assistant" && isRecord(frame.message)) return "assistant";
  if (frame.type === "user" && isRecord(frame.message)) return "user";
  if (frame.type === "stream_event") return "stream";
  if (frame.type === "result") return "result";
  if (frame.type === "system" && frame.subtype === "init") return "init";
  return "other";
}

/** Whether a user frame's content carries a tool result block. */
function carriesToolResult(frame: Record<string, unknown>): boolean {
  if (!isRecord(frame.message)) return false;
  const content = frame.message.content;
  return (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && block.type === "tool_result")
  );
}

const UNREADABLE: ClaudeFrameReading = {
  kind: "other",
  frame: {},
  isReplay: false,
  isIdentityBoundary: false,
  identity: undefined,
  uuid: undefined,
  correlation: undefined,
  isError: false,
  isToolResult: false,
};

export function readClaudeFrame(message: unknown): ClaudeFrameReading {
  if (!isRecord(message)) return UNREADABLE;
  const kind = frameKind(message);
  return {
    kind,
    frame: message,
    isReplay: message.isReplay === true,
    isIdentityBoundary: kind === "result" || kind === "init",
    identity: message.session_id,
    uuid: message.uuid,
    correlation: message.user_message_uuid,
    isError: message.is_error === true,
    isToolResult: kind === "user" && carriesToolResult(message),
  };
}

/* ============================================================== */
/* Content                                                         */
/* ============================================================== */

/**
 * One content block, as a message part. Anything else is not a part.
 *
 * A `tool_use` block carries its **native id**, which is the join key between
 * the streamed call and the tool result about it. Without it a Claude tool
 * call and its output would become two unrelated tool entries, and the
 * reducer would have nothing to merge them by.
 *
 * Thinking blocks produce nothing. They are the model's private reasoning and
 * they do not cross the boundary; the message that carried them still does,
 * because its model and the usage about it do.
 */
export function claudeMessagePart(value: unknown): MessagePart | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : { kind: "text", text: value };
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return value.text === "" ? undefined : { kind: "text", text: value.text };
  }
  if (value.type === "tool_use" && typeof value.name === "string") {
    const callId = typeof value.id === "string" ? value.id : undefined;
    return {
      kind: "tool_call",
      name: value.name,
      ...(callId === undefined ? {} : { callId }),
    };
  }
  if (value.type === "tool_result") {
    const text = claudeToolResultText(value.content);
    return text === undefined ? undefined : { kind: "text", text };
  }
  return undefined;
}

/**
 * The text of a tool result block.
 *
 * A tool result's content is a string on the simple path and a block list when
 * the tool returned structured output, and both are worth reading: a reader
 * who sees an empty tool item learns nothing about what the tool did.
 */
export function claudeToolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content === "" ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => (block as { text?: unknown }).text)
    .filter((value): value is string => typeof value === "string")
    .join("");
  return text === "" ? undefined : text;
}

/** Every part one message's content carries, in order. */
export function claudeContentParts(content: unknown): MessagePart[] {
  const raw = Array.isArray(content) ? content : [content];
  return raw
    .map(claudeMessagePart)
    .filter((part): part is MessagePart => part !== undefined);
}

/** Whether a tool result block reported a failure. */
function toolResultFailed(block: unknown): boolean {
  return isRecord(block) && block.is_error === true;
}

/* ============================================================== */
/* Usage                                                           */
/* ============================================================== */

/** The cumulative figures one result frame reports, summed across models. */
export interface ClaudeCumulativeUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export const ZERO_CUMULATIVE_USAGE: ClaudeCumulativeUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

/**
 * Every model the Query pipeline ran, summed.
 *
 * ADR-0027's choice, and the spike's second finding is why it needed one:
 * `modelUsage` includes main-loop, subagent, sidechain, and internal calls, so
 * even a single-model Run is charged for the model the SDK reached for on its
 * own. The Run really did cause that spend, so every entry is charged; reading
 * only the requested model's entry would undercount.
 *
 * Cost prefers the frame's own `total_cost_usd`, which is the provider's own
 * total for the same call set, and falls back to summing per-model costs when
 * the frame does not carry one.
 */
export function claudeCumulativeUsage(
  frame: Record<string, unknown>,
): ClaudeCumulativeUsage {
  const perModel = isRecord(frame.modelUsage) ? frame.modelUsage : undefined;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let summedCost = 0;
  if (perModel) {
    for (const entry of Object.values(perModel)) {
      if (!isRecord(entry)) continue;
      input += readNumber(entry.inputTokens);
      output += readNumber(entry.outputTokens);
      cacheRead += readNumber(entry.cacheReadInputTokens);
      cacheWrite += readNumber(entry.cacheCreationInputTokens);
      summedCost += readNumber(entry.costUSD);
    }
  }
  const reported = readAmount(frame.total_cost_usd);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: reported ?? summedCost,
  };
}

/**
 * The delta between two cumulative readings, never negative.
 *
 * A reading smaller than the last one is a provider reset — a mid-session
 * clear, or a resumed session starting its own running total — and the honest
 * answer is to charge the new reading rather than to charge nothing or, worse,
 * to subtract. v1's rule, unchanged.
 */
export function claudeUsageDelta(
  current: ClaudeCumulativeUsage,
  previous: ClaudeCumulativeUsage,
): UsageDelta {
  const reset =
    current.input < previous.input ||
    current.output < previous.output ||
    current.cacheRead < previous.cacheRead ||
    current.cacheWrite < previous.cacheWrite ||
    current.cost < previous.cost;
  const of = (now: number, before: number): number =>
    reset ? now : Math.max(0, now - before);
  return {
    input: of(current.input, previous.input),
    output: of(current.output, previous.output),
    cacheRead: of(current.cacheRead, previous.cacheRead),
    cacheWrite: of(current.cacheWrite, previous.cacheWrite),
    cost: of(current.cost, previous.cost),
  };
}

/**
 * How much of the primary model's window the conversation occupies.
 *
 * A **derivation**, not a provider figure: the SDK reports no occupancy, so
 * this is the primary model's own token reading over its own window. It is
 * decided here rather than at the call site so that it is one documented rule
 * instead of an invention per reader.
 *
 * Only the primary model's entry is read, because occupancy is not additive:
 * summing two models' inputs against one model's window would report a
 * conversation as several windows full. When the primary model has no entry —
 * a Run that failed before its model answered, or a frame that named a model
 * `modelUsage` does not key — the gauge is omitted rather than borrowed from
 * whatever entry happens to be there.
 *
 * **No window, no gauge.** The domain allows a gauge without a denominator,
 * and for a provider that reports true occupancy that is a reasonable thing to
 * send. This figure is not that: it is *cumulative across the turns of the
 * Query*, so without a window to read it against it is exactly the sum a gauge
 * exists not to be. An entry with no usable `contextWindow` is therefore no
 * gauge at all.
 */
export function claudeContextGauge(
  frame: Record<string, unknown>,
  primaryModel: string | undefined,
): ContextGauge | undefined {
  if (primaryModel === undefined) return undefined;
  const perModel = isRecord(frame.modelUsage) ? frame.modelUsage : undefined;
  if (!perModel) return undefined;
  const entry = primaryModelEntry(perModel, primaryModel);
  if (entry === undefined) return undefined;
  const tokens = readCounter(
    readNumber(entry.inputTokens) +
      readNumber(entry.cacheReadInputTokens) +
      readNumber(entry.cacheCreationInputTokens),
  );
  if (tokens === undefined) return undefined;
  const window = readCounter(entry.contextWindow);
  if (window === undefined || window === 0) return undefined;
  return { tokens, window };
}

/** The entry for the model the Run is running, by key or by canonical name. */
function primaryModelEntry(
  perModel: Record<string, unknown>,
  primaryModel: string,
): Record<string, unknown> | undefined {
  const direct = perModel[primaryModel];
  if (isRecord(direct)) return direct;
  for (const entry of Object.values(perModel)) {
    if (isRecord(entry) && entry.canonicalModel === primaryModel) return entry;
  }
  return undefined;
}

/* ============================================================== */
/* The Run-local translator                                        */
/* ============================================================== */

/**
 * What one frame produced.
 *
 * Observations and nothing else. The provider's own turn total is deliberately
 * *not* here: the translator has already folded it into its running count,
 * raise-only, and a second copy on the way out would be a number a caller
 * could apply twice.
 */
export interface ClaudeTranslation {
  readonly observations: readonly RunObservation[];
}

export interface ClaudeTranslator {
  /** Translate one frame the execution has decided to keep. */
  readonly frame: (reading: ClaudeFrameReading) => ClaudeTranslation;
  /** The model the Run actually ran, once the provider has named one. */
  readonly primaryModel: () => string | undefined;
  /** Turns counted from root assistant messages and raised by result totals. */
  readonly turns: () => number;
}

/**
 * Build a translator for one Run.
 *
 * Created inside the execution and discarded with it, which is what makes
 * "usage is Run-local" true by construction rather than by subtraction: a
 * resumed Run's translator starts from zero, so the first result frame's
 * cumulative reading is charged in full and every later one is differenced.
 */
export function createClaudeTranslator(): ClaudeTranslator {
  let previous = ZERO_CUMULATIVE_USAGE;
  let primaryModel: string | undefined;
  let lastAssistantAnswered = false;
  let lastStreamingKind: string | undefined;
  const rootMessages = new Set<string>();
  let turns = 0;

  /**
   * One turn per unique root assistant message id.
   *
   * The SDK emits an assistant frame per completed content block, so several
   * frames can share a message id and only the first is a turn. A frame
   * parented to a tool use, or carrying a subagent type, is a sidechain reply
   * rather than a turn of *this* conversation.
   */
  const countAssistantTurn = (frame: Record<string, unknown>): number => {
    if (frame.parent_tool_use_id != null) return 0;
    if (typeof frame.subagent_type === "string") return 0;
    const message = isRecord(frame.message) ? frame.message : undefined;
    const id = message?.id;
    if (typeof id !== "string" || rootMessages.has(id)) return 0;
    rootMessages.add(id);
    turns += 1;
    return 1;
  };

  /** A result total may raise the count. It may never lower it. */
  const raiseTurns = (frame: Record<string, unknown>): number => {
    const reported = readCounter(frame.num_turns);
    if (reported === undefined || reported <= turns) return 0;
    const delta = reported - turns;
    turns = reported;
    return delta;
  };

  const assistantFrame = (
    frame: Record<string, unknown>,
  ): ClaudeTranslation => {
    const message = isRecord(frame.message) ? frame.message : {};
    const parts = claudeContentParts(message.content);
    const model = typeof message.model === "string" ? message.model : undefined;
    if (model !== undefined) primaryModel ??= model;
    const turnDelta = countAssistantTurn(frame);
    lastAssistantAnswered = parts.some((part) => part.kind === "text");
    const observations: RunObservation[] = [];
    // A frame with no readable content and no model carries nothing a reader
    // could use, so no message is reported for it — but if it was a new root
    // message it was still a turn, and dropping the frame whole would lose
    // that. Thinking-only frames are the ordinary case here, and they *do*
    // carry a model, so they keep their message.
    if (parts.length > 0 || model !== undefined) {
      observations.push({
        kind: "message",
        role: "assistant",
        parts,
        ...(model === undefined ? {} : { model }),
      });
    }
    if (turnDelta > 0) {
      observations.push({ kind: "usage", usage: { turns: turnDelta } });
    }
    const activity =
      frame.parent_tool_use_id == null &&
      typeof frame.subagent_type !== "string"
        ? latestToolActivity(message.content)
        : undefined;
    if (activity !== undefined) {
      observations.push({ kind: "activity", activity });
      // The detailed completion replaced the streamed bare name. A later call
      // of the same tool must be allowed to replace that old detail at once.
      lastStreamingKind = undefined;
    }
    return { observations };
  };

  const streamFrame = (frame: Record<string, unknown>): ClaudeTranslation => {
    if (
      frame.parent_tool_use_id != null ||
      typeof frame.subagent_type === "string"
    ) {
      return { observations: [] };
    }
    const event = isRecord(frame.event) ? frame.event : undefined;
    if (event?.type !== "content_block_start") return { observations: [] };
    const block = isRecord(event.content_block)
      ? event.content_block
      : undefined;
    let kind: string | undefined;
    let activity: string | undefined;
    if (block?.type === "thinking") {
      kind = "thinking";
      activity = "thinking…";
    } else if (block?.type === "text") {
      kind = "writing";
      activity = "responding…";
    } else if (
      block?.type === "tool_use" &&
      typeof block.name === "string" &&
      block.name !== ""
    ) {
      kind = `tool:${block.name}`;
      activity = toolActivity(block.name, undefined);
    }
    if (
      kind === undefined ||
      activity === undefined ||
      kind === lastStreamingKind
    ) {
      return { observations: [] };
    }
    lastStreamingKind = kind;
    return { observations: [{ kind: "activity", activity }] };
  };

  const userFrame = (frame: Record<string, unknown>): ClaudeTranslation => {
    const message = isRecord(frame.message) ? frame.message : {};
    const parts = claudeContentParts(message.content);
    const observations: RunObservation[] = [];
    if (parts.length > 0) {
      observations.push({ kind: "message", role: "tool", parts });
    }
    const content = isRecord(message) ? message.content : undefined;
    for (const block of Array.isArray(content) ? content : []) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const callId = block.tool_use_id;
      if (typeof callId !== "string" || callId === "") continue;
      const summary = claudeToolResultText(block.content);
      observations.push({
        kind: "tool_progress",
        callId,
        status: toolResultFailed(block) ? "failed" : "completed",
        ...(summary === undefined ? {} : { outputSummary: summary }),
      });
    }
    return { observations };
  };

  const initFrame = (frame: Record<string, unknown>): ClaudeTranslation => {
    const model = frame.model;
    if (typeof model !== "string" || model === "") {
      return { observations: [] };
    }
    // The init frame names the resolved main-loop model before the first
    // answer, so a Run that fails before answering still says what it ran.
    primaryModel ??= model;
    return { observations: [{ kind: "model", model }] };
  };

  const resultFrame = (frame: Record<string, unknown>): ClaudeTranslation => {
    const observations: RunObservation[] = [];
    // The result's own text is the answer only when the last assistant frame
    // did not carry one — a Run whose model answered in an assistant frame
    // would otherwise have its answer in the transcript twice.
    const text = typeof frame.result === "string" ? frame.result : "";
    if (frame.is_error !== true && text !== "" && !lastAssistantAnswered) {
      observations.push({
        kind: "message",
        role: "assistant",
        parts: [{ kind: "text", text }],
        ...(primaryModel === undefined ? {} : { model: primaryModel }),
      });
      lastAssistantAnswered = true;
    }
    const current = claudeCumulativeUsage(frame);
    const delta = claudeUsageDelta(current, previous);
    previous = current;
    const turnDelta = raiseTurns(frame);
    observations.push({
      kind: "usage",
      usage: { ...delta, ...(turnDelta > 0 ? { turns: turnDelta } : {}) },
    });
    const context = claudeContextGauge(frame, primaryModel);
    if (context !== undefined) {
      observations.push({ kind: "context", context });
    }
    return { observations };
  };

  return {
    frame: (reading) => {
      switch (reading.kind) {
        case "assistant":
          return assistantFrame(reading.frame);
        case "user":
          return userFrame(reading.frame);
        case "stream":
          return streamFrame(reading.frame);
        case "init":
          return initFrame(reading.frame);
        case "result":
          return resultFrame(reading.frame);
        case "other":
          return { observations: [] };
      }
    },
    primaryModel: () => primaryModel,
    turns: () => turns,
  };
}

/** What the widget shows a Run doing, read from the last raw tool-use block. */
export function latestToolActivity(content: unknown): string | undefined {
  const blocks = Array.isArray(content) ? content : [content];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      !isRecord(block) ||
      block.type !== "tool_use" ||
      typeof block.name !== "string" ||
      block.name === ""
    ) {
      continue;
    }
    const input = isRecord(block.input) ? block.input : undefined;
    return toolActivity(block.name, input);
  }
  return undefined;
}
