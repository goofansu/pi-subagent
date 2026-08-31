import path from "node:path";
import type { ControlAdmission, ControlSource } from "../../control-source.ts";
import type { Fact, RunEnding, RunReporter } from "../../run.ts";
import type {
  CodexAppServerEvent,
  CodexAppServerTransport,
  CodexAppServerTransportRejectionReason,
  CodexTransportMessage,
  CodexTransportObserver,
  CodexTransportOccurrence,
  CodexTransportTurn,
  ThreadItem,
  ThreadTokenUsage,
  Turn,
} from "./app-server.ts";

const ACTIVITY_LIMIT = 120;
// Leave room after the command for its latest output line in the activity.
const COMMAND_PREFIX_LIMIT = 60;
// Only the tail of a command's output can become live activity.
const OUTPUT_TAIL_LIMIT = 2048;
// Cap memory and keep each streamed-message delta's preview work constant.
const AGENT_MESSAGE_TAIL_LIMIT = 2048;
const STEERING_DIAGNOSTIC_LIMIT = 1024;
const RESULT_DIAGNOSTIC_LIMIT = 1024;

export interface CodexTranslation {
  facts?: Fact[];
  transcript?: Fact[];
  /** Live UI activity: absent leaves it unchanged, null clears it. */
  activity?: string | null;
  terminal?: boolean;
  errorMessage?: string;
}

interface CodexConversationCapability
  extends Pick<
    CodexAppServerTransport,
    | "stdoutTail"
    | "beginTurn"
    | "attach"
    | "detach"
    | "start"
    | "startTurn"
    | "normalizeTurnUsage"
    | "redactDiagnostic"
    | "settlePending"
    | "terminate"
    | "escalate"
  > {}

interface CodexAttemptOptions {
  readonly conversation: CodexConversationCapability;
  readonly cwd: string;
  readonly prompt: string;
  readonly translate?: (
    event: CodexAppServerEvent,
  ) => CodexTranslation | undefined;
  readonly report: RunReporter;
  readonly signal?: AbortSignal;
  readonly controls?: ControlSource;
  readonly missingAnswerMessage: string;
}

type CodexAttemptOccurrence =
  | CodexTransportOccurrence
  | { readonly type: "control"; readonly admission: ControlAdmission }
  | { readonly type: "control-source-close" }
  | { readonly type: "steering-settled" }
  | { readonly type: "cancel" };

interface OrderedOccurrence {
  readonly sequence: number;
  readonly occurrence: CodexAttemptOccurrence;
}

type CodexProcessConclusion =
  | { readonly status: "clean" }
  | { readonly status: "failed"; readonly errorMessage?: string };

function collapsed(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function capped(value: string): string {
  return collapsed(value).slice(0, ACTIVITY_LIMIT);
}

function cappedTail(value: string): string {
  // Deltas extend agent messages, so a tail cap keeps the preview current;
  // reasoning summaries are headlines, so their head cap preserves the lead.
  return collapsed(value).slice(-ACTIVITY_LIMIT);
}

function appendTail(tail: string, delta: string, limit: number): string {
  return (tail + delta.slice(-limit)).slice(-limit);
}

function commandFromItem(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string {
  return (
    item.commandActions.find((action) => action.command)?.command ??
    item.command
  );
}

/** The latest non-blank line, honoring carriage-return progress. */
function lastNonBlankLine(tail: string): string | undefined {
  const lines = tail.split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
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

function messagePreview(tail: string): string | undefined {
  const line = lastNonBlankLine(tail);
  if (!line || /^(```|~~~)/.test(line)) return undefined;
  // Whitespace after the terminator prevents decimals and versions splitting.
  const fragments = line.split(/(?<=[.!?])\s+/);
  let sentence: string | undefined;
  for (let index = fragments.length - 1; index >= 0; index--) {
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

function itemActivity(item: ThreadItem, cwd: string): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return capped(`$ ${commandFromItem(item)}`);
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

function usageFact(tokenUsage: ThreadTokenUsage): Fact {
  const delta = tokenUsage.total;
  return {
    role: "metadata",
    parts: [],
    usage: {
      input: delta.inputTokens,
      cacheRead: delta.cachedInputTokens,
      cacheWrite: delta.cacheWriteInputTokens,
      output: delta.outputTokens + delta.reasoningOutputTokens,
      // The latest provider request's total is the context-size gauge; the
      // schema's modelContextWindow is capacity, not occupancy.
      contextTokens: tokenUsage.last.totalTokens,
      turns: 1,
    },
  };
}

function terminalTurnError(turn: Turn): string | undefined {
  return turn.error?.message;
}

function reasoningHeadline(summary: string): string | undefined {
  const firstLine = summary.split("\n", 1)[0] ?? "";
  const plain = firstLine.replace(/[*_~`]/g, "").trim();
  return plain ? capped(plain) : undefined;
}

/** Create the fresh stateful translator for one Codex Attempt. */
export function createCodexTranslator(
  cwd: string,
): (event: CodexAppServerEvent) => CodexTranslation | undefined {
  const reasoning = new Map<string, string>();
  const commands = new Map<string, string>();
  const outputTails = new Map<string, string>();
  const agentMessageTails = new Map<string, string>();
  let completedAgentMessage = false;

  return (event) => {
    if (event.method === "item/started") {
      const item = event.params.item;
      if (item.type === "commandExecution")
        commands.set(item.id, commandFromItem(item));
      const activity = itemActivity(item, cwd);
      return activity ? { activity } : undefined;
    }

    if (event.method === "item/agentMessage/delta") {
      const itemId = event.params.itemId;
      const tail = appendTail(
        agentMessageTails.get(itemId) ?? "",
        event.params.delta,
        AGENT_MESSAGE_TAIL_LIMIT,
      );
      agentMessageTails.set(itemId, tail);
      return { activity: messagePreview(tail) ?? "Writing response…" };
    }

    if (event.method === "item/commandExecution/outputDelta") {
      const itemId = event.params.itemId;
      const tail = appendTail(
        outputTails.get(itemId) ?? "",
        event.params.delta,
        OUTPUT_TAIL_LIMIT,
      );
      outputTails.set(itemId, tail);
      const line = lastNonBlankLine(tail);
      return line
        ? { activity: commandProgress(commands.get(itemId), line) }
        : undefined;
    }

    if (event.method === "item/reasoning/summaryTextDelta") {
      const itemId = event.params.itemId;
      const delta = event.params.delta;
      if (typeof itemId !== "string" || typeof delta !== "string")
        return undefined;
      const summary = (reasoning.get(itemId) ?? "") + delta;
      reasoning.set(itemId, summary);
      return { activity: reasoningHeadline(summary) ?? "Thinking…" };
    }

    if (event.method === "item/completed") {
      const item = event.params.item;
      if (item.type === "agentMessage") {
        agentMessageTails.delete(item.id);
        completedAgentMessage = true;
        const text = item.text;
        const phase = item.phase;
        return {
          facts: [
            {
              role: "assistant",
              parts: text ? [{ type: "text", text }] : [],
              usage: { turns: 0 },
            },
          ],
          // Older servers omitted phase; anything other than commentary is
          // terminal so the final answer still wins after an abort.
          terminal: phase !== "commentary",
        };
      }
      if (item.type === "commandExecution") {
        commands.delete(item.id);
        outputTails.delete(item.id);
        const command = commandFromItem(item);
        return {
          facts: [
            {
              role: "assistant",
              parts: [
                {
                  type: "tool_call",
                  name: "command_execution",
                  arguments: { command },
                },
              ],
              usage: { turns: 0 },
            },
          ],
        };
      }
      return undefined;
    }

    if (event.method === "thread/tokenUsage/updated") {
      return { facts: [usageFact(event.params.tokenUsage)] };
    }

    if (event.method === "error") {
      const error = event.params.error.message;
      if (event.params.willRetry === true)
        return { activity: "Retrying after a provider error…" };
      return {
        facts: [{ role: "metadata", parts: [], errorMessage: error }],
        errorMessage: error,
      };
    }

    if (event.method === "turn/completed") {
      const turn = event.params.turn;
      const errorMessage = terminalTurnError(turn);
      const status = turn.status;
      return {
        ...(errorMessage
          ? {
              facts: [{ role: "metadata", parts: [], errorMessage }],
              errorMessage,
            }
          : {}),
        ...(status === "completed" && completedAgentMessage
          ? { terminal: true }
          : {}),
        activity: null,
      };
    }

    return undefined;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function correlatedSteeringFact(
  event: CodexAppServerEvent,
  pendingCorrelations: ReadonlySet<string>,
  consumedItems: ReadonlySet<string>,
):
  | {
      readonly correlation: string;
      readonly itemId: string;
      readonly fact: Fact;
    }
  | undefined {
  if (event.method !== "item/started" && event.method !== "item/completed")
    return undefined;
  const item = event.params.item;
  if (
    item.type !== "userMessage" ||
    consumedItems.has(item.id) ||
    typeof item.clientId !== "string" ||
    !pendingCorrelations.has(item.clientId)
  )
    return undefined;
  const parts = item.content.flatMap((content) =>
    isRecord(content) &&
    content.type === "text" &&
    typeof content.text === "string"
      ? [{ type: "text" as const, text: content.text }]
      : [],
  );
  return parts.length > 0
    ? {
        correlation: item.clientId,
        itemId: item.id,
        fact: { role: "user", parts },
      }
    : undefined;
}

function isServerRequestError(error: unknown): error is Error {
  return (
    error instanceof Error && "kind" in error && error.kind === "server-request"
  );
}

function steeringDiagnostic(error: Error, redact: (value: string) => string) {
  const value = `Steering rejected: ${redact(error.message)}`;
  return `${value.slice(0, STEERING_DIAGNOSTIC_LIMIT - 1)}\n`;
}

/**
 * Execute one fresh Codex Turn against a retained App Server Conversation.
 * All externally occurring inputs receive an ingress sequence before this
 * reducer interprets them; this Attempt is the sole producer of its candidate
 * Ending and does not finish until its Turn-local resources are detached.
 */
export function runCodexAttempt(
  options: CodexAttemptOptions,
): Promise<RunEnding> {
  const {
    conversation,
    cwd,
    prompt,
    translate = createCodexTranslator(cwd),
    report,
    signal = new AbortController().signal,
    controls = {
      subscribe: (_onAdmission, onClose) => {
        onClose?.();
        return () => {};
      },
    },
    missingAnswerMessage,
  } = options;
  if (signal.aborted) return Promise.resolve({ ending: "cancelled" });
  conversation.beginTurn();
  return new Promise((resolve, reject) => {
    let nextSequence = 1;
    let turn: CodexTransportTurn | undefined;
    let cancellationSequence: number | undefined;
    let endingSettled = false;
    let sawStderr = false;
    let terminalAnswer = false;
    let witnessedError: string | undefined;
    let firstUsageUpdate = true;
    let draining = false;
    let framingStdout = false;
    let reducingSequence: number | undefined;
    const queue: OrderedOccurrence[] = [];
    const earlyNotifications: {
      readonly sequence: number;
      readonly notification: CodexAppServerEvent;
    }[] = [];
    const pendingSteeringCorrelations = new Set<string>();
    const consumedSteeringItems = new Set<string>();
    const providerIdentities = new Set<string>();
    const queuedControls: ControlAdmission[] = [];
    let steeringInFlight = false;
    let controlsClosed = false;
    let unsubscribeControls = () => {};
    let observer: CodexTransportObserver;

    const redactDiagnostic = (value: string): string => {
      return conversation
        .redactDiagnostic(value, providerIdentities)
        .slice(0, RESULT_DIAGNOSTIC_LIMIT);
    };
    const closeControlAdmissions = (): void => {
      if (controlsClosed) return;
      controlsClosed = true;
      for (const admission of queuedControls) admission.acknowledge();
      queuedControls.length = 0;
      unsubscribeControls();
    };
    const clearSteeringState = (): void => {
      steeringInFlight = false;
      pendingSteeringCorrelations.clear();
      consumedSteeringItems.clear();
    };
    const closeTurnState = (): void => {
      closeControlAdmissions();
      clearSteeringState();
    };
    const cancellationPrecedes = (sequence: number | undefined): boolean =>
      cancellationSequence !== undefined &&
      (sequence === undefined || cancellationSequence <= sequence);
    const endingFrom = (
      conclusion: CodexProcessConclusion,
      conclusionSequence: number | undefined,
    ): RunEnding => {
      if (terminalAnswer) return { ending: "answered" };
      if (cancellationPrecedes(conclusionSequence))
        return { ending: "cancelled" };
      if (conclusion.status === "failed") {
        const errorMessage = witnessedError ?? conclusion.errorMessage;
        return {
          ending: "failed",
          ...(errorMessage === undefined ? {} : { errorMessage }),
        };
      }
      return {
        ending: "failed",
        errorMessage: witnessedError ?? missingAnswerMessage,
      };
    };
    const settle = (conclusion: CodexProcessConclusion): void => {
      if (endingSettled) return;
      endingSettled = true;
      closeTurnState();
      signal.removeEventListener("abort", onAbort);
      conversation.detach(observer);
      resolve(endingFrom(conclusion, reducingSequence));
    };
    const failExecution = (error: unknown): void => {
      if (endingSettled) return;
      endingSettled = true;
      closeTurnState();
      signal.removeEventListener("abort", onAbort);
      conversation.detach(observer);
      conversation.terminate();
      conversation.settlePending("transport-settled");
      reject(error);
    };
    const finish = (
      conclusion: CodexProcessConclusion,
      terminate: boolean,
      requestSettlement: CodexAppServerTransportRejectionReason,
    ): void => {
      if (endingSettled) return;
      closeControlAdmissions();
      conversation.settlePending(requestSettlement);
      if (terminate && conclusion.status === "failed") conversation.terminate();
      settle(conclusion);
    };
    const reportStderr = (chunk: string): boolean => {
      sawStderr = true;
      try {
        report.stderr(redactDiagnostic(chunk));
        return true;
      } catch (error) {
        finish(
          {
            status: "failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          true,
          "transport-settled",
        );
        return false;
      }
    };
    const startNextControl = (): void => {
      if (controlsClosed || endingSettled || steeringInFlight || !turn) return;
      const admission = queuedControls.shift();
      if (!admission) return;
      admission.acknowledge();
      steeringInFlight = true;
      const clientUserMessageId = globalThis.crypto.randomUUID();
      pendingSteeringCorrelations.add(clientUserMessageId);
      providerIdentities.add(clientUserMessageId);
      turn.steer(
        admission.control.text,
        clientUserMessageId,
        () => {
          queueMicrotask(() => admit({ type: "steering-settled" }));
        },
        (error) => {
          pendingSteeringCorrelations.delete(clientUserMessageId);
          if (isServerRequestError(error))
            reportStderr(steeringDiagnostic(error, redactDiagnostic));
          queueMicrotask(() => admit({ type: "steering-settled" }));
        },
      );
    };
    const startupFailure = (error: Error): void => {
      finish(
        { status: "failed", errorMessage: redactDiagnostic(error.message) },
        true,
        "transport-settled",
      );
    };
    const start = (): void => {
      if (endingSettled || cancellationSequence !== undefined) return;
      conversation.startTurn(
        prompt,
        (attachedTurn) => {
          turn = attachedTurn;
          flushEarlyNotifications();
          startNextControl();
        },
        startupFailure,
      );
    };
    const applyTranslation = (
      sequence: number,
      notification: CodexAppServerEvent,
    ): void => {
      let translation: CodexTranslation | undefined;
      if (notification.method === "turn/completed") {
        providerIdentities.add(notification.params.turn.id);
        for (const item of notification.params.turn.items)
          providerIdentities.add(item.id);
      } else {
        providerIdentities.add(notification.params.turnId);
        if (
          notification.method === "item/started" ||
          notification.method === "item/completed"
        )
          providerIdentities.add(notification.params.item.id);
        else if (
          notification.method === "item/agentMessage/delta" ||
          notification.method === "item/commandExecution/outputDelta" ||
          notification.method === "item/reasoning/summaryTextDelta"
        )
          providerIdentities.add(notification.params.itemId);
      }
      const steering = correlatedSteeringFact(
        notification,
        pendingSteeringCorrelations,
        consumedSteeringItems,
      );
      try {
        let currentNotification = notification;
        if (notification.method === "thread/tokenUsage/updated") {
          const tokenUsage = conversation.normalizeTurnUsage(
            notification.params.tokenUsage,
            firstUsageUpdate,
          );
          firstUsageUpdate = false;
          currentNotification = {
            ...notification,
            params: { ...notification.params, tokenUsage },
          };
        }
        translation = translate(currentNotification);
      } catch (error) {
        failExecution(error);
        return;
      }
      if (translation) {
        translation = {
          ...translation,
          ...(translation.errorMessage === undefined
            ? {}
            : { errorMessage: redactDiagnostic(translation.errorMessage) }),
          ...(translation.facts
            ? {
                facts: translation.facts.map((fact) =>
                  fact.errorMessage === undefined
                    ? fact
                    : {
                        ...fact,
                        errorMessage: redactDiagnostic(fact.errorMessage),
                      },
                ),
              }
            : {}),
        };
      }
      if ((!translation && !steering) || endingSettled) return;
      if (
        translation?.terminal === true &&
        (cancellationSequence === undefined || sequence < cancellationSequence)
      )
        terminalAnswer = true;
      if (translation?.errorMessage !== undefined)
        witnessedError = translation.errorMessage;
      try {
        if (steering) {
          report.message(steering.fact);
          pendingSteeringCorrelations.delete(steering.correlation);
          consumedSteeringItems.add(steering.itemId);
        }
        for (const fact of translation?.facts ?? []) report.message(fact);
        if (translation?.transcript !== undefined)
          report.transcript(translation.transcript);
        if (translation?.activity !== undefined)
          report.activity(translation.activity ?? undefined);
      } catch (error) {
        finish(
          {
            status: "failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          true,
          "transport-settled",
        );
      }
    };
    const matchesAttemptIdentity = (
      notification: CodexAppServerEvent,
    ): boolean => turn?.matches(notification) ?? false;
    const forwardNotification = (
      sequence: number,
      notification: CodexAppServerEvent,
    ): void => {
      if (endingSettled || !matchesAttemptIdentity(notification)) return;
      applyTranslation(sequence, notification);
      if (!endingSettled && notification.method === "turn/completed") {
        if (cancellationPrecedes(sequence)) turn?.completeInterruption();
        finish(
          { status: "clean" },
          !cancellationPrecedes(sequence),
          "semantic-settled",
        );
      }
    };
    function flushEarlyNotifications(): void {
      if (!turn || endingSettled) return;
      const retained = earlyNotifications.splice(0);
      for (const entry of retained) {
        forwardNotification(entry.sequence, entry.notification);
        if (endingSettled) return;
      }
    }
    const handleProviderMessage = (
      sequence: number,
      message: CodexTransportMessage,
    ): void => {
      const consumed = message.consume();
      if (typeof consumed === "string") {
        reportStderr(consumed);
        return;
      }
      if (!consumed) return;
      if (!turn) {
        earlyNotifications.push({ sequence, notification: consumed });
        return;
      }
      forwardNotification(sequence, consumed);
    };
    const handleProcessClose = (
      sequence: number,
      code: number | null,
    ): void => {
      if (endingSettled) return;
      if (cancellationPrecedes(sequence)) {
        finish({ status: "clean" }, false, "child-exited");
        return;
      }
      if (code === 0) {
        if (!sawStderr && !terminalAnswer) {
          const tail = redactDiagnostic(conversation.stdoutTail.trim());
          if (
            !reportStderr(
              tail ? `Last stdout:\n${tail}` : "No stdout was captured.",
            )
          )
            return;
        }
        finish({ status: "clean" }, false, "child-exited");
        return;
      }
      if (!sawStderr && !terminalAnswer && conversation.stdoutTail.trim()) {
        if (
          !reportStderr(
            `Last stdout:\n${redactDiagnostic(conversation.stdoutTail.trim())}`,
          )
        )
          return;
      }
      finish(
        {
          status: "failed",
          errorMessage: `Child codex exited with code ${code ?? "unknown"}`,
        },
        false,
        "child-exited",
      );
    };
    const reduce = ({ sequence, occurrence }: OrderedOccurrence): void => {
      if (
        endingSettled &&
        occurrence.type !== "process-close" &&
        occurrence.type !== "escalation"
      )
        return;
      switch (occurrence.type) {
        case "provider-message":
          handleProviderMessage(sequence, occurrence.message);
          return;
        case "control":
          if (controlsClosed || endingSettled) {
            occurrence.admission.acknowledge();
            return;
          }
          queuedControls.push(occurrence.admission);
          startNextControl();
          return;
        case "control-source-close":
          closeControlAdmissions();
          return;
        case "steering-settled":
          steeringInFlight = false;
          startNextControl();
          return;
        case "cancel":
          closeControlAdmissions();
          if (turn) turn.interrupt();
          else conversation.terminate();
          return;
        case "stderr":
          reportStderr(occurrence.chunk);
          return;
        case "stdin-error":
          reportStderr(`stdin: ${occurrence.error.message}\n`);
          return;
        case "stdin-write-error":
          reportStderr(`stdin: ${occurrence.error.message}\n`);
          finish({ status: "failed" }, true, "transport-settled");
          return;
        case "process-error": {
          const errorMessage = redactDiagnostic(occurrence.error.message);
          if (!reportStderr(`${errorMessage}\n`)) return;
          finish({ status: "failed", errorMessage }, true, "transport-settled");
          return;
        }
        case "process-close":
          handleProcessClose(sequence, occurrence.code);
          return;
        case "escalation":
          conversation.escalate(occurrence.stage);
      }
    };
    function drainQueue(): void {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) {
            reducingSequence = next.sequence;
            reduce(next);
          }
        }
      } finally {
        reducingSequence = undefined;
        draining = false;
      }
    }
    function admit(occurrence: CodexAttemptOccurrence): void {
      if (
        endingSettled &&
        occurrence.type !== "process-close" &&
        occurrence.type !== "escalation"
      ) {
        if (occurrence.type === "control") occurrence.admission.acknowledge();
        return;
      }
      const ordered = { sequence: nextSequence++, occurrence };
      if (occurrence.type === "cancel" && cancellationSequence === undefined)
        cancellationSequence = ordered.sequence;
      queue.push(ordered);
      if (!framingStdout) drainQueue();
    }
    function onAbort(): void {
      admit({ type: "cancel" });
    }

    observer = {
      admit,
      beginFrame: () => {
        framingStdout = true;
      },
      endFrame: () => {
        framingStdout = false;
        drainQueue();
      },
    };
    conversation.attach(observer);
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribeControls = controls.subscribe(
      (admission) => {
        if (controlsClosed) {
          admission.acknowledge();
          return;
        }
        admit({ type: "control", admission });
      },
      () => {
        if (!controlsClosed) admit({ type: "control-source-close" });
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    const processStart = conversation.start();
    if (processStart.status === "failed") {
      finish(
        { status: "failed", errorMessage: processStart.errorMessage },
        true,
        "transport-settled",
      );
      return;
    }
    start();
  });
}
