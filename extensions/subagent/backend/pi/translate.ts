/**
 * Pi's native messages and events, as Run observations. Pure, and total.
 *
 * Translation is total and reads no session. The event translator retains two
 * things and nothing else: the running shell commands, keyed by call id,
 * because Pi omits arguments from their end events; and the kind of output the
 * model last streamed, so a turn's activity is emitted once per kind change
 * rather than once per delta. It is created per execution and retains nothing
 * across Runs. A shape this module does not recognize produces nothing rather
 * than a failure, because a provider that adds a content block should not be
 * able to fail a Run.
 *
 * It takes `unknown` and checks, rather than taking Pi's declared types and
 * trusting them. That is not distrust of the SDK — it is that a retained
 * session's message list is rebuilt during compaction and retry, arrives
 * through an untyped event payload, and is the one place a provider's own
 * vocabulary would otherwise cross the boundary. Checking here is what makes
 * "no Pi type leaks into the runtime" true of the values as well as the types.
 *
 * Two rules worth naming, both earned in v1:
 *
 * - **Message identity has two forms.** A translated object preserves streamed
 *   reference identity, while its semantic identity recognizes rebuilt
 *   terminal and baseline occurrences without treating usage restatement as a
 *   new message. Pi Run evidence applies both identities.
 * - **`totalTokens` is a gauge, not a delta.** It is Pi's per-message context
 *   occupancy. Summing it would report a context window several times over.
 */

import {
  type ContextGauge,
  type MessagePart,
  type MessageRole,
  type RunDiagnostic,
  type RunObservation,
  runDiagnostic,
  type UsageDelta,
} from "../../domain/index.ts";
import { finishedShellActivity, toolActivity } from "../activity.ts";

/** The shared diagnostic category used for provider failures in this adapter. */
export const PI_BACKEND_FAILURE_CATEGORY = "backend-failure";

/** What a confined provider diagnostic says instead of provider text. */
export const PI_DIAGNOSTIC_REDACTED = "[redacted]";

/** Adapter-owned wording for a terminal assistant failure. */
export const PI_TERMINAL_FAILURE_DESCRIPTION = "Pi reported a failed message";

/** Domain-neutral wording for an incomplete terminal assistant message. */
export const PI_TERMINAL_ABORT_DESCRIPTION = "Pi did not complete its message";

/**
 * Report that something Pi authored went wrong, without keeping what it said.
 *
 * The category is the adapter's own and is the useful part at the seam; the
 * provider's string stays here, unread. v1's provider-diagnostic confinement,
 * expressed in v2's typed diagnostic.
 */
export function confined(what: string): RunDiagnostic {
  return runDiagnostic(
    PI_BACKEND_FAILURE_CATEGORY,
    `${what}: ${PI_DIAGNOSTIC_REDACTED}`,
  );
}

/** The same confinement, for a Control that the session refused. */
export function confinedControl(what: string): RunDiagnostic {
  return runDiagnostic("control", `${what}: ${PI_DIAGNOSTIC_REDACTED}`);
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
function readCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * One optional field, present only when the value survived reading.
 *
 * A spread of nothing where a field is absent, so an omitted key stays omitted
 * rather than becoming an explicit `undefined` the exact-key decoder would
 * reject.
 */
function field<K extends string>(
  key: K,
  value: number | undefined,
): { [P in K]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };
}

/** One content block, as a message part. Anything else is not a part. */
export function piMessagePart(value: unknown): MessagePart | undefined {
  if (typeof value === "string") return { kind: "text", text: value };
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return { kind: "text", text: value.text };
  }
  if (value.type === "toolCall" && typeof value.name === "string") {
    // The native call id is the join key between this part and the tool
    // progress about it. Without it the reducer keeps the call distinct rather
    // than guessing, which is why it is carried and never invented.
    const callId = typeof value.id === "string" ? value.id : undefined;
    return {
      kind: "tool_call",
      name: value.name,
      ...(callId === undefined ? {} : { callId }),
    };
  }
  return undefined;
}

/** Pi's role words as the domain's. A tool result is a `tool` item. */
export function piRole(value: unknown): MessageRole | undefined {
  if (value === "toolResult") return "tool";
  if (value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return undefined;
}

/** What one native message carries, before it becomes observations. */
export interface PiMessageFacts {
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  readonly model?: string;
  readonly usage?: UsageDelta;
  readonly context?: ContextGauge;
  readonly diagnostic?: RunDiagnostic;
}

/**
 * One message after translation has consumed Pi's wire vocabulary.
 *
 * The object itself is the streamed occurrence identity. `semanticIdentity`
 * is separate because retained-session baselines and terminal frames may
 * rebuild equal messages as new objects. Pi Run evidence can therefore use
 * reference and counted semantic identity for their distinct jobs without
 * inspecting a native message.
 */
export interface PiTranslatedMessage {
  readonly semanticIdentity: string;
  readonly goalText?: string;
  readonly facts?: PiMessageFacts;
  readonly observations: readonly RunObservation[];
  readonly assistantOutcome?: "answered" | "incomplete" | "failed" | "aborted";
}

/** A fully translated reading consumed by Pi Run evidence. */
export type PiRunReading =
  | { readonly kind: "message"; readonly message: PiTranslatedMessage }
  | { readonly kind: "activity"; readonly observation: RunObservation }
  | {
      readonly kind: "tool";
      readonly observations: readonly RunObservation[];
    }
  | { readonly kind: "execution-start" }
  | { readonly kind: "recovery-start" }
  | {
      readonly kind: "recovery-end";
      readonly outcome: "succeeded" | "failed" | "aborted";
      readonly willRetry: boolean;
    }
  | { readonly kind: "final-settled" }
  | {
      readonly kind: "terminal";
      readonly messages: readonly PiTranslatedMessage[];
    }
  | { readonly kind: "other" };

export interface PiRunReadingTranslator {
  readonly event: (event: unknown) => PiRunReading;
  readonly messages: (
    messages: readonly unknown[],
  ) => readonly PiTranslatedMessage[];
}

/**
 * Read one native message.
 *
 * An empty parts list is still a message: thinking blocks and provider-private
 * content do not cross the boundary, but the usage, model, and error the same
 * message carried do, and dropping the message would drop those with it.
 */
export function piMessageFacts(message: unknown): PiMessageFacts | undefined {
  if (!isRecord(message)) return undefined;
  const role = piRole(message.role);
  if (role === undefined) return undefined;
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    return undefined;
  }
  const raw = Array.isArray(message.content)
    ? message.content
    : [message.content];
  const parts = raw
    .map(piMessagePart)
    .filter((part): part is MessagePart => part !== undefined);

  const rawUsage = isRecord(message.usage) ? message.usage : undefined;
  const rawCost =
    rawUsage && isRecord(rawUsage.cost) ? rawUsage.cost : undefined;
  const delta: UsageDelta | undefined = rawUsage
    ? {
        ...field("input", readCounter(rawUsage.input)),
        ...field("output", readCounter(rawUsage.output)),
        ...field("cacheRead", readCounter(rawUsage.cacheRead)),
        ...field("cacheWrite", readCounter(rawUsage.cacheWrite)),
        ...field("cost", readCost(rawCost?.total)),
      }
    : undefined;
  const occupancy = rawUsage ? readCounter(rawUsage.totalTokens) : undefined;

  return {
    role,
    parts,
    ...(typeof message.provider === "string" &&
    typeof message.model === "string"
      ? { model: `${message.provider}/${message.model}` }
      : {}),
    ...(delta === undefined ? {} : { usage: delta }),
    ...(occupancy === undefined ? {} : { context: { tokens: occupancy } }),
    ...(typeof message.errorMessage === "string"
      ? { diagnostic: confined(PI_TERMINAL_FAILURE_DESCRIPTION) }
      : {}),
  };
}

/** The user text used only to recognize Pi's echo of the Run goal. */
function piUserText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter((part) => isRecord(part) && part.type === "text")
    .map((part) => (part as Record<string, unknown>).text)
    .join("");
}

/** Translate one native message all the way to adapter-local evidence input. */
export function translatePiMessage(message: unknown): PiTranslatedMessage {
  const facts = piMessageFacts(message);
  const stopReason = isRecord(message) ? message.stopReason : undefined;
  const assistantOutcome =
    facts?.role !== "assistant"
      ? undefined
      : stopReason === "error"
        ? "failed"
        : stopReason === "length"
          ? "incomplete"
          : stopReason === "aborted"
            ? "aborted"
            : "answered";
  const goalText = piUserText(message);
  return {
    semanticIdentity: messageIdentity(message),
    ...(goalText === undefined ? {} : { goalText }),
    ...(facts === undefined ? {} : { facts }),
    observations: piMessageObservations(message),
    ...(assistantOutcome === undefined ? {} : { assistantOutcome }),
  };
}

/**
 * Every observation one native message produces, in reduction order.
 *
 * The message comes first, because the usage and the gauge are *about* it and
 * a reader that saw them first would see a Run that had spent tokens with
 * nothing to show for it. One turn is counted per assistant message, which is
 * what makes the widget's turn count mean what it did in v1 — a model reply,
 * not a provider round trip.
 */
export function piMessageObservations(
  message: unknown,
): readonly RunObservation[] {
  const facts = piMessageFacts(message);
  if (!facts) return [];
  const observations: RunObservation[] = [
    {
      kind: "message",
      role: facts.role,
      parts: facts.parts,
      ...(facts.model === undefined ? {} : { model: facts.model }),
    },
  ];
  const turns = facts.role === "assistant" ? 1 : 0;
  if (facts.usage !== undefined || turns > 0) {
    observations.push({
      kind: "usage",
      usage: { ...(facts.usage ?? {}), ...(turns > 0 ? { turns } : {}) },
    });
  }
  if (facts.context !== undefined) {
    observations.push({ kind: "context", context: facts.context });
  }
  if (facts.diagnostic !== undefined) {
    observations.push({ kind: "diagnostic", diagnostic: facts.diagnostic });
  }
  return observations;
}

/**
 * One native session event, read once, into something with no wire in it.
 *
 * This module is the **only** consumer of Pi's wire shape in the whole tree —
 * the definition-of-done's rule for the v1 adapter, kept for v2's. Everything
 * downstream branches on `kind`, so an event Pi renames or re-shapes changes
 * this file and nothing else.
 *
 * A message is handed on unread because what to do with it depends on Run
 * state the translator does not have: whether the brief has already been
 * echoed back, and whether this exact event object has been seen before.
 */
export type PiEventReading =
  /** A message the session emitted. The caller decides whether to keep it. */
  | { readonly kind: "message"; readonly message: unknown }
  /** A changed model-output kind, already translated to one activity. */
  | { readonly kind: "activity"; readonly observation: RunObservation }
  /** A tool call starting or finishing, already translated. */
  | { readonly kind: "tool"; readonly observations: readonly RunObservation[] }
  /** A new native execution within the managed Run. */
  | { readonly kind: "execution-start" }
  /** Pi began compaction after a native execution ended. */
  | { readonly kind: "recovery-start" }
  /** Pi finished compaction, with its provider-facing outcome confined here. */
  | {
      readonly kind: "recovery-end";
      readonly outcome: "succeeded" | "failed" | "aborted";
      readonly willRetry: boolean;
    }
  /** Pi has finished every recovery and native execution for this prompt. */
  | { readonly kind: "final-settled" }
  /** The non-retrying terminal frame, with the messages it carried. */
  | { readonly kind: "terminal"; readonly messages: readonly unknown[] }
  /** Anything else Pi emits, which this adapter has no use for. */
  | { readonly kind: "other" };

const IGNORED: PiEventReading = { kind: "other" };

export interface PiEventTranslator {
  readonly event: (event: unknown) => PiEventReading;
}

/**
 * Translate events for the Pi Run evidence seam while preserving message
 * object identity across repeated streamed events.
 */
export function createPiRunReadingTranslator(): PiRunReadingTranslator {
  const events = createPiEventTranslator();
  const references = new WeakMap<object, PiTranslatedMessage>();
  const translate = (message: unknown): PiTranslatedMessage => {
    if (typeof message !== "object" || message === null) {
      return translatePiMessage(message);
    }
    const prior = references.get(message);
    if (prior !== undefined) return prior;
    const translated = translatePiMessage(message);
    references.set(message, translated);
    return translated;
  };
  // Snapshots are translated at read time even when Pi reuses a streamed
  // object: compaction may have restated its accounting in place since the
  // message event was observed. Only streamed event identity is cached.
  const messages = (values: readonly unknown[]) =>
    values.map(translatePiMessage);
  return {
    messages,
    event: (event) => {
      const reading = events.event(event);
      if (reading.kind === "message") {
        return { kind: "message", message: translate(reading.message) };
      }
      if (reading.kind === "terminal") {
        return { kind: "terminal", messages: messages(reading.messages) };
      }
      return reading;
    },
  };
}

type PiTurnKind = "thinking" | "text";

/** The output kind carried by an assistant message update, if any. */
function piTurnKind(event: Record<string, unknown>): PiTurnKind | undefined {
  if (event.type !== "message_update") return undefined;
  const delta = event.assistantMessageEvent;
  if (!isRecord(delta)) return undefined;
  if (delta.type === "thinking_delta") return "thinking";
  if (delta.type === "text_delta") return "text";
  return undefined;
}

/**
 * One Run's event translator, with the two things it remembers.
 *
 * Shell commands are remembered until their end event, because Pi's end event
 * carries the result and call id but not the arguments. The model's last
 * output kind is remembered so `thinking…` and `responding…` are emitted once per
 * change rather than once per delta; a tool activity forgets it, which makes
 * the next delta newer than the tool even when the model resumes with the same
 * kind it emitted before the call. Creating this translator inside each
 * execution keeps all of that Run-local, so a resumed Run's first delta is new.
 */
export function createPiEventTranslator(): PiEventTranslator {
  const shellActivities = new Map<string, string>();
  let lastTurnKind: PiTurnKind | undefined;
  return {
    event: (event) => {
      if (isRecord(event)) {
        const turnKind = piTurnKind(event);
        if (turnKind !== undefined) {
          if (turnKind === lastTurnKind) return IGNORED;
          lastTurnKind = turnKind;
          return {
            kind: "activity",
            observation: {
              kind: "activity",
              activity: turnKind === "thinking" ? "thinking…" : "responding…",
            },
          };
        }
      }
      const reading = readPiEvent(event);
      if (
        reading.kind === "tool" &&
        reading.observations.some((one) => one.kind === "activity")
      ) {
        lastTurnKind = undefined;
      }
      if (!isRecord(event)) return reading;
      const callId = event.toolCallId;
      if (typeof callId !== "string" || callId === "") return reading;

      if (event.type === "tool_execution_start" && event.toolName === "bash") {
        const activity =
          reading.kind === "tool"
            ? reading.observations.find((one) => one.kind === "activity")
            : undefined;
        if (activity?.kind === "activity" && activity.activity !== undefined) {
          shellActivities.set(callId, activity.activity);
        }
        return reading;
      }

      if (event.type !== "tool_execution_end") return reading;
      const commandActivity = shellActivities.get(callId);
      shellActivities.delete(callId);
      if (
        event.toolName !== "bash" ||
        commandActivity === undefined ||
        reading.kind !== "tool"
      ) {
        return reading;
      }
      return {
        kind: "tool",
        observations: [
          {
            kind: "activity",
            activity: finishedShellActivity(
              commandActivity,
              piShellResultText(event.result),
            ),
          },
          ...reading.observations,
        ],
      };
    },
  };
}

export function readPiEvent(event: unknown): PiEventReading {
  if (!isRecord(event)) return IGNORED;
  if (event.type === "message_end" && event.message !== undefined) {
    return { kind: "message", message: event.message };
  }
  if (event.type === "agent_start") {
    return { kind: "execution-start" };
  }
  if (event.type === "compaction_start" || event.type === "auto_retry_start") {
    return { kind: "recovery-start" };
  }
  if (event.type === "compaction_end") {
    return {
      kind: "recovery-end",
      outcome:
        event.result !== undefined
          ? "succeeded"
          : event.aborted === true
            ? "aborted"
            : "failed",
      willRetry: event.willRetry === true,
    };
  }
  if (event.type === "agent_settled") {
    return { kind: "final-settled" };
  }
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end"
  ) {
    const observations: RunObservation[] = [];
    const activity = piActivity(event);
    if (activity) observations.push(activity);
    const progress = piToolProgress(event);
    if (progress) observations.push(progress);
    return { kind: "tool", observations };
  }
  // A retrying terminal frame is not terminal: the session is about to try
  // again, and its messages are not the Run's last word.
  if (
    event.type === "agent_end" &&
    event.willRetry !== true &&
    Array.isArray(event.messages)
  ) {
    return { kind: "terminal", messages: event.messages };
  }
  return IGNORED;
}

/** Text from a native result, shared by shell transcripts and tool summaries. */
function piShellResultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return undefined;
  if (typeof result.output === "string") return result.output;
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content
    .filter(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => (block as { readonly text: string }).text)
    .join("\n");
  return text === "" ? undefined : text;
}

/** What a tool execution event says about the call it names. */
export function piToolProgress(event: unknown): RunObservation | undefined {
  if (!isRecord(event)) return undefined;
  const callId = event.toolCallId;
  if (typeof callId !== "string" || callId === "") return undefined;
  if (event.type === "tool_execution_start") {
    return { kind: "tool_progress", callId, status: "running" };
  }
  if (event.type !== "tool_execution_end") return undefined;
  const summary = toolOutputSummary(event.result);
  return {
    kind: "tool_progress",
    callId,
    status: event.isError === true ? "failed" : "completed",
    ...(summary === undefined ? {} : { outputSummary: summary }),
  };
}

/**
 * A tool result's text, bounded by the projection rather than serialized.
 *
 * Strings and output fields are retained verbatim; native text-content blocks
 * are joined with newlines, ignoring non-text blocks. Arrays without extracted
 * text are described by count; other values have no summary.
 */
export function toolOutputSummary(result: unknown): string | undefined {
  const text = piShellResultText(result);
  if (text !== undefined) return text;
  return Array.isArray(result) ? `${result.length} results` : undefined;
}

/** What the widget shows a Run doing, from the tool call it just began. */
export function piActivity(event: unknown): RunObservation | undefined {
  if (!isRecord(event) || event.type !== "tool_execution_start") {
    return undefined;
  }
  const name = event.toolName;
  if (typeof name !== "string" || name === "") return undefined;
  const args = isRecord(event.args) ? event.args : undefined;
  return { kind: "activity", activity: toolActivity(name, args) };
}

/**
 * A message's identity, for telling a repeat apart from a rebuild.
 *
 * Content plus the metadata that would differ between two genuinely different
 * messages. Used only against the *baseline*, where reference identity is not
 * available because the retained session may have rebuilt its list while
 * compacting or retrying.
 */
function messageIdentity(message: unknown): string {
  if (!isRecord(message)) return JSON.stringify(message) ?? "";
  return JSON.stringify({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  });
}
