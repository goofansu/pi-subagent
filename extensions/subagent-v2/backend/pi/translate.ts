/**
 * Pi's native messages and events, as Run observations. Pure, and total.
 *
 * Everything in this module is a function of its arguments. It reads no
 * session, holds no state across a Run, and never throws: a shape it does not
 * recognize produces nothing rather than a failure, because a provider that
 * adds a content block should not be able to fail a Run.
 *
 * It takes `unknown` and checks, rather than taking Pi's declared types and
 * trusting them. That is not distrust of the SDK — it is that a retained
 * session's message list is rebuilt during compaction and retry, arrives
 * through an untyped event payload, and is the one place a provider's own
 * vocabulary would otherwise cross the boundary. Checking here is what makes
 * "no Pi type leaks into the runtime" true of the values as well as the types.
 *
 * The three rules worth naming, all of them v1's, all of them earned:
 *
 * - **The initial goal is omitted.** Pi echoes the prompt back as the Run's
 *   first user message. Reporting it would put the caller's own brief in the
 *   transcript of every Run, and in a *resumed* Run it would look like new
 *   input.
 * - **Messages are deduplicated by identity, not by content.** Two consumed
 *   Controls can carry identical text, and treating equal content as the same
 *   event would silently drop the second one.
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
  type TerminalReconciliation,
  type TranscriptItem,
  type UsageDelta,
} from "../../domain/index.ts";

/** What a confined provider diagnostic says instead of provider text. */
export const PI_DIAGNOSTIC_REDACTED = "[redacted]";

/**
 * Report that something Pi authored went wrong, without keeping what it said.
 *
 * The category is the adapter's own and is the useful part at the seam; the
 * provider's string stays here, unread. v1's provider-diagnostic confinement,
 * expressed in v2's typed diagnostic.
 */
export function confined(what: string): RunDiagnostic {
  return runDiagnostic("backend-failure", `${what}: ${PI_DIAGNOSTIC_REDACTED}`);
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
      ? { diagnostic: confined("Pi reported a failed message") }
      : {}),
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

/** One native message as a transcript item, for a terminal snapshot. */
export function piTranscriptItem(message: unknown): TranscriptItem | undefined {
  const facts = piMessageFacts(message);
  if (!facts) return undefined;
  return {
    role: facts.role,
    parts: facts.parts,
    ...(facts.model === undefined ? {} : { model: facts.model }),
  };
}

/**
 * One native session event, read once, into something with no wire in it.
 *
 * This function and {@link piMessageFacts} are the **only** consumers of Pi's
 * wire shape in the whole tree — the definition-of-done's rule for the v1
 * adapter, kept for v2's. Everything downstream branches on `kind`, so an
 * event Pi renames or re-shapes changes this file and nothing else.
 *
 * A message is handed on unread because what to do with it depends on Run
 * state the translator does not have: whether the brief has already been
 * echoed back, and whether this exact event object has been seen before.
 */
export type PiEventReading =
  /** A message the session emitted. The caller decides whether to keep it. */
  | { readonly kind: "message"; readonly message: unknown }
  /** A tool call starting or finishing, already translated. */
  | { readonly kind: "tool"; readonly observations: readonly RunObservation[] }
  /** The non-retrying terminal frame, with the messages it carried. */
  | { readonly kind: "terminal"; readonly messages: readonly unknown[] }
  /** Anything else Pi emits, which this adapter has no use for. */
  | { readonly kind: "other" };

const IGNORED: PiEventReading = { kind: "other" };

export function readPiEvent(event: unknown): PiEventReading {
  if (!isRecord(event)) return IGNORED;
  if (event.type === "message_end" && event.message !== undefined) {
    return { kind: "message", message: event.message };
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
 * A tool result, as one line a reader can scan.
 *
 * A provider tool result is an arbitrary value, and the projection bounds the
 * text anyway — but a JSON blob of a file read is not a summary of anything,
 * so a string result is taken as it is and everything else is described rather
 * than serialized.
 */
export function toolOutputSummary(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (isRecord(result) && typeof result.output === "string") {
    return result.output;
  }
  if (result === undefined || result === null) return undefined;
  return Array.isArray(result) ? `${result.length} results` : undefined;
}

/** What the widget shows a Run doing, from the tool call it just began. */
export function piActivity(event: unknown): RunObservation | undefined {
  if (!isRecord(event) || event.type !== "tool_execution_start") {
    return undefined;
  }
  const name = event.toolName;
  if (typeof name !== "string" || name === "") return undefined;
  return { kind: "activity", activity: name };
}

/**
 * A message's identity, for telling a repeat apart from a rebuild.
 *
 * Content plus the metadata that would differ between two genuinely different
 * messages. Used only against the *baseline*, where reference identity is not
 * available because the retained session may have rebuilt its list while
 * compacting or retrying.
 */
export function messageIdentity(message: unknown): string {
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

/**
 * The messages this Run added, given what was there when it started.
 *
 * Counted rather than sliced by length: the retained session rebuilds message
 * objects while compacting, so positions move. Counting preserves genuinely
 * repeated identical messages the current Run added, which slicing by a set
 * would drop.
 */
export function currentRunMessages(
  messages: readonly unknown[],
  baseline: readonly unknown[],
): readonly unknown[] {
  const before = new Map<string, number>();
  for (const message of baseline) {
    const key = messageIdentity(message);
    before.set(key, (before.get(key) ?? 0) + 1);
  }
  return messages.filter((message) => {
    const key = messageIdentity(message);
    const remaining = before.get(key) ?? 0;
    if (remaining === 0) return true;
    before.set(key, remaining - 1);
    return false;
  });
}

/** Whether this message is the user text the Run was started with. */
export function isPiUserText(message: unknown, text: string): boolean {
  if (!isRecord(message) || message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return content === text;
  if (!Array.isArray(content)) return false;
  return (
    content
      .filter((part) => isRecord(part) && part.type === "text")
      .map((part) => (part as Record<string, unknown>).text)
      .join("") === text
  );
}

/** The same list with the first echo of the brief removed. */
export function withoutInitialGoal(
  messages: readonly unknown[],
  prompt: string,
): readonly unknown[] {
  let omitted = false;
  return messages.filter((message) => {
    if (!omitted && isPiUserText(message, prompt)) {
      omitted = true;
      return false;
    }
    return true;
  });
}

/**
 * Everything a terminal snapshot replaces, recomputed from its own messages.
 *
 * A {@link TerminalReconciliation} rather than a shape of its own, because
 * that is exactly what it is: every field present replaces what was streamed,
 * and every field absent retains it. Returning the domain type means the
 * execution hands the snapshot straight to the bundle instead of copying it
 * field by field into the type it was already.
 */
export function piTerminalSnapshot(
  messages: readonly unknown[],
): TerminalReconciliation {
  const transcript: TranscriptItem[] = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let turns = 0;
  let context: ContextGauge | undefined;
  let model: string | undefined;
  for (const message of messages) {
    const facts = piMessageFacts(message);
    if (!facts) continue;
    transcript.push({
      role: facts.role,
      parts: facts.parts,
      ...(facts.model === undefined ? {} : { model: facts.model }),
    });
    if (facts.model !== undefined) model = facts.model;
    if (facts.role === "assistant") turns += 1;
    if (facts.usage) {
      totals.input += facts.usage.input ?? 0;
      totals.output += facts.usage.output ?? 0;
      totals.cacheRead += facts.usage.cacheRead ?? 0;
      totals.cacheWrite += facts.usage.cacheWrite ?? 0;
      totals.cost += facts.usage.cost ?? 0;
    }
    if (facts.context) context = facts.context;
  }
  return {
    transcript,
    usage: totals,
    turns,
    ...(context === undefined ? {} : { context }),
    ...(model === undefined ? {} : { model }),
  };
}
