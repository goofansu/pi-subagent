import {
  type ChildProcess,
  spawn as defaultSpawn,
  type SpawnOptions,
} from "node:child_process";
import type { ChildProcessSpawn } from "../../child-process.ts";
import type { ControlAdmission, ControlSource } from "../../control-source.ts";
import type { Translation } from "../../one-shot.ts";
import {
  DEPTH_ENV_KEY,
  type Fact,
  type RunEnding,
  type RunReporter,
} from "../../run.ts";

const STDOUT_LINE_LIMIT = 32 * 1024 * 1024;
const RAW_STDOUT_TAIL_LIMIT = 2000;
const STEERING_DIAGNOSTIC_LIMIT = 1024;
const RESULT_DIAGNOSTIC_LIMIT = 1024;
const DEFAULT_KILL_ESCALATION_MS = 5000;
const CLIENT_INFO = {
  name: "pi-subagent",
  title: "pi-subagent",
  version: "1.0.0",
} as const;

type JsonObject = Record<string, unknown>;
type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface CodexAppServerJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A request rejected by the App Server itself. */
export class CodexAppServerRequestError extends Error {
  readonly kind = "server-request" as const;
  readonly code: number;
  readonly data: unknown;

  constructor(readonly jsonRpcError: CodexAppServerJsonRpcError) {
    super(jsonRpcError.message);
    this.name = "CodexAppServerRequestError";
    this.code = jsonRpcError.code;
    this.data = jsonRpcError.data;
  }
}

export type CodexAppServerTransportRejectionReason =
  | "semantic-settled"
  | "transport-settled"
  | "child-exited";

/** A request rejected because this transport reached a lifecycle boundary. */
export class CodexAppServerTransportError extends Error {
  readonly kind = "transport-lifecycle" as const;

  constructor(readonly reason: CodexAppServerTransportRejectionReason) {
    super(
      reason === "semantic-settled"
        ? "Codex App Server transport settled"
        : reason === "transport-settled"
          ? "Codex App Server transport closed"
          : "Codex App Server exited before its response",
    );
    this.name = "CodexAppServerTransportError";
  }
}

export interface TurnError {
  message: string;
  codexErrorInfo: unknown | null;
  additionalDetails: string | null;
}

export type ThreadItem =
  | {
      type: "userMessage";
      id: string;
      clientId?: string | null;
      content: unknown[];
    }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase?: "commentary" | "final_answer" | null;
    }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: "inProgress" | "completed" | "failed" | "declined";
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
      commandActions: { type: string; command: string }[];
    }
  | {
      type: "fileChange";
      id: string;
      changes: {
        path: string;
        kind:
          | { type: "add" }
          | { type: "delete" }
          | { type: "update"; move_path: string | null };
        diff: string;
      }[];
      status: unknown;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: unknown;
    }
  | { type: "webSearch"; id: string; query: string };

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface ItemStartedParams {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  startedAtMs: number;
}

interface ItemCompletedParams {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  completedAtMs: number;
}

/**
 * The notifications this transport consumes, shaped by the generated App
 * Server protocol schema (`codex app-server generate-json-schema`, verified
 * against codex-cli 0.150.1 and a live smoke run). The schema envelope is
 * `method` + `params` only; the live server also stamps an undeclared
 * `emittedAtMs`, which is ignored rather than required. Parsing demands only
 * schema-required fields and normalizes optional ones so a sparser server
 * payload never silently drops a notification.
 */
export type CodexAppServerEvent =
  | { method: "item/started"; params: ItemStartedParams }
  | { method: "item/completed"; params: ItemCompletedParams }
  | {
      method: "item/agentMessage/delta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
    }
  | {
      method: "item/commandExecution/outputDelta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
    }
  | {
      method: "item/reasoning/summaryTextDelta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        summaryIndex: number;
      };
    }
  | {
      method: "thread/tokenUsage/updated";
      params: {
        threadId: string;
        turnId: string;
        tokenUsage: ThreadTokenUsage;
      };
    }
  | { method: "turn/completed"; params: { threadId: string; turn: Turn } }
  | {
      method: "error";
      params: {
        error: TurnError;
        willRetry: boolean;
        threadId: string;
        turnId: string;
      };
    };

export interface CodexAppServerOptions {
  readonly cwd: string;
  readonly childDepth: number;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  /** Adapter-private provider Conversation identity to attach on this Attempt. */
  readonly continuationThreadId?: string;
  /** Retain an identity only after its current Turn has started successfully. */
  readonly onThreadAttached?: (threadId: string) => void;
  readonly onRequestRejection?: (error: Error) => void;
  readonly spawn?: ChildProcessSpawn;
  readonly killEscalationMs?: number;
}

export interface CodexAppServerRunOptions extends CodexAppServerOptions {
  readonly translate: (event: CodexAppServerEvent) => Translation | undefined;
  readonly report: RunReporter;
  readonly signal?: AbortSignal;
  readonly controls?: ControlSource;
  readonly missingAnswerMessage: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexAppServerResponseError(
  value: unknown,
): CodexAppServerJsonRpcError | undefined {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.code) ||
    typeof value.message !== "string"
  )
    return undefined;
  return {
    code: value.code as number,
    message: value.message,
    data: value.data,
  };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTurnStatus(value: unknown): value is TurnStatus {
  return (
    value === "completed" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "inProgress"
  );
}

function parseTurnError(value: unknown): TurnError | undefined {
  // Schema requires only `message`; the other fields default to null.
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  return {
    message: value.message,
    codexErrorInfo: value.codexErrorInfo ?? null,
    additionalDetails:
      typeof value.additionalDetails === "string"
        ? value.additionalDetails
        : null,
  };
}

function parseThreadItem(value: unknown): ThreadItem | undefined {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.id !== "string"
  )
    return undefined;
  switch (value.type) {
    case "userMessage":
      return Array.isArray(value.content) &&
        (value.clientId === undefined ||
          value.clientId === null ||
          typeof value.clientId === "string")
        ? (value as ThreadItem)
        : undefined;
    case "agentMessage":
      return typeof value.text === "string" &&
        (value.phase === undefined ||
          value.phase === null ||
          value.phase === "commentary" ||
          value.phase === "final_answer")
        ? (value as ThreadItem)
        : undefined;
    case "plan":
      return typeof value.text === "string" ? (value as ThreadItem) : undefined;
    case "reasoning": {
      // Schema defaults `summary` and `content` to empty arrays.
      const strings = (candidate: unknown): string[] | undefined =>
        candidate === undefined
          ? []
          : Array.isArray(candidate) &&
              candidate.every((part) => typeof part === "string")
            ? candidate
            : undefined;
      const summary = strings(value.summary);
      const content = strings(value.content);
      return summary && content
        ? { type: "reasoning", id: value.id, summary, content }
        : undefined;
    }
    case "commandExecution": {
      // aggregatedOutput/exitCode/durationMs are optional in the schema.
      const commandActions =
        value.commandActions === undefined
          ? []
          : Array.isArray(value.commandActions) &&
              value.commandActions.every(
                (action) =>
                  isRecord(action) &&
                  typeof action.type === "string" &&
                  typeof action.command === "string",
              )
            ? (value.commandActions as { type: string; command: string }[])
            : undefined;
      return typeof value.command === "string" &&
        typeof value.cwd === "string" &&
        (value.status === "inProgress" ||
          value.status === "completed" ||
          value.status === "failed" ||
          value.status === "declined") &&
        commandActions
        ? {
            type: "commandExecution",
            id: value.id,
            command: value.command,
            cwd: value.cwd,
            status: value.status,
            aggregatedOutput:
              typeof value.aggregatedOutput === "string"
                ? value.aggregatedOutput
                : null,
            exitCode: isNumber(value.exitCode) ? value.exitCode : null,
            durationMs: isNumber(value.durationMs) ? value.durationMs : null,
            commandActions,
          }
        : undefined;
    }
    case "fileChange":
      return "status" in value &&
        Array.isArray(value.changes) &&
        value.changes.every(
          (change) =>
            isRecord(change) &&
            typeof change.path === "string" &&
            typeof change.diff === "string" &&
            isRecord(change.kind) &&
            (change.kind.type === "add" ||
              change.kind.type === "delete" ||
              (change.kind.type === "update" &&
                (change.kind.move_path === null ||
                  typeof change.kind.move_path === "string"))),
        )
        ? (value as ThreadItem)
        : undefined;
    case "mcpToolCall":
      return "status" in value &&
        typeof value.server === "string" &&
        typeof value.tool === "string"
        ? (value as ThreadItem)
        : undefined;
    case "webSearch":
      return typeof value.query === "string"
        ? (value as ThreadItem)
        : undefined;
    default:
      return undefined;
  }
}

function parseThreadTokenUsage(value: unknown): ThreadTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const breakdown = (candidate: unknown): TokenUsageBreakdown | undefined => {
    if (!isRecord(candidate)) return undefined;
    const fields = [
      "totalTokens",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
    ] as const;
    if (!fields.every((field) => isNumber(candidate[field]))) return undefined;
    return {
      ...(Object.fromEntries(
        fields.map((field) => [field, candidate[field]]),
      ) as unknown as Omit<TokenUsageBreakdown, "cacheWriteInputTokens">),
      // Schema marks cacheWriteInputTokens optional with a default of 0.
      cacheWriteInputTokens: isNumber(candidate.cacheWriteInputTokens)
        ? candidate.cacheWriteInputTokens
        : 0,
    };
  };
  const total = breakdown(value.total);
  const last = breakdown(value.last);
  if (!total || !last) return undefined;
  return {
    total,
    last,
    modelContextWindow: isNumber(value.modelContextWindow)
      ? value.modelContextWindow
      : null,
  };
}

function parseTurn(value: unknown): Turn | undefined {
  // Schema requires only id/items/status; timestamps and error are optional.
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isTurnStatus(value.status) ||
    !Array.isArray(value.items)
  )
    return undefined;
  // The protocol carries item variants this adapter never consumes (hook
  // prompts, sub-agent activity, …). Skipping them keeps the authoritative
  // turn/completed settlement signal intact instead of rejecting the turn.
  const items = value.items
    .map(parseThreadItem)
    .filter((item): item is ThreadItem => item !== undefined);
  return {
    id: value.id,
    items,
    status: value.status,
    error: parseTurnError(value.error) ?? null,
    startedAt: isNumber(value.startedAt) ? value.startedAt : null,
    completedAt: isNumber(value.completedAt) ? value.completedAt : null,
    durationMs: isNumber(value.durationMs) ? value.durationMs : null,
  };
}

function parseNotification(value: unknown): CodexAppServerEvent | undefined {
  if (!isRecord(value) || typeof value.method !== "string") return undefined;
  const params = value.params;
  if (!isRecord(params)) return undefined;
  const threadId = params.threadId;
  if (typeof threadId !== "string") return undefined;
  if (value.method === "item/started" || value.method === "item/completed") {
    const item = parseThreadItem(params.item);
    const timestamp =
      value.method === "item/started"
        ? params.startedAtMs
        : params.completedAtMs;
    if (!item || typeof params.turnId !== "string" || !isNumber(timestamp))
      return undefined;
    if (value.method === "item/started") {
      return {
        method: value.method,
        params: {
          item,
          threadId,
          turnId: params.turnId,
          startedAtMs: timestamp,
        },
      };
    }
    return {
      method: value.method,
      params: {
        item,
        threadId,
        turnId: params.turnId,
        completedAtMs: timestamp,
      },
    };
  }
  if (
    (value.method === "item/agentMessage/delta" ||
      value.method === "item/commandExecution/outputDelta") &&
    typeof params.turnId === "string" &&
    typeof params.itemId === "string" &&
    typeof params.delta === "string"
  ) {
    return {
      method: value.method,
      params: {
        threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        delta: params.delta,
      },
    };
  }
  if (
    value.method === "item/reasoning/summaryTextDelta" &&
    typeof params.turnId === "string" &&
    typeof params.itemId === "string" &&
    typeof params.delta === "string" &&
    Number.isInteger(params.summaryIndex)
  ) {
    return {
      method: value.method,
      params: {
        threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        delta: params.delta,
        summaryIndex: params.summaryIndex as number,
      },
    };
  }
  if (
    value.method === "thread/tokenUsage/updated" &&
    typeof params.turnId === "string"
  ) {
    const tokenUsage = parseThreadTokenUsage(params.tokenUsage);
    return tokenUsage
      ? {
          method: value.method,
          params: { threadId, turnId: params.turnId, tokenUsage },
        }
      : undefined;
  }
  if (value.method === "turn/completed") {
    const turn = parseTurn(params.turn);
    return turn
      ? { method: value.method, params: { threadId, turn } }
      : undefined;
  }
  if (
    value.method === "error" &&
    typeof params.turnId === "string" &&
    typeof params.willRetry === "boolean"
  ) {
    const error = parseTurnError(params.error);
    return error
      ? {
          method: value.method,
          params: {
            error,
            willRetry: params.willRetry,
            threadId,
            turnId: params.turnId,
          },
        }
      : undefined;
  }
  return undefined;
}

/** Keep provider identity out of the persisted stderr post-mortem. */
function redactProviderIds(value: string): string {
  return value.replace(
    /"(clientUserMessageId|expectedTurnId|correlationId|conversationId|requestId|threadId|turnId|itemId|sessionId|clientId|id)"\s*:\s*("[^"]*"|-?\d+)/g,
    '"$1":"[redacted]"',
  );
}

function boundedRedactedDiagnostic(value: string): string {
  return redactProviderIds(value).slice(0, RESULT_DIAGNOSTIC_LIMIT);
}

function steeringDiagnostic(
  error: CodexAppServerRequestError,
  redact: (value: string) => string = redactProviderIds,
): string {
  const value = `Steering rejected: ${redact(error.message)}`;
  return `${value.slice(0, STEERING_DIAGNOSTIC_LIMIT - 1)}\n`;
}

function spawnOptions(cwd: string, childDepth: number): SpawnOptions {
  return {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, [DEPTH_ENV_KEY]: String(childDepth) },
  };
}

function initializeParams(): JsonObject {
  return { clientInfo: CLIENT_INFO, capabilities: null };
}

function isInitializeResponse(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.userAgent === "string" &&
    typeof value.codexHome === "string" &&
    typeof value.platformFamily === "string" &&
    typeof value.platformOs === "string"
  );
}

function threadStartParams(options: CodexAppServerOptions): JsonObject {
  const params: JsonObject = {
    cwd: options.cwd,
    ephemeral: false,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
  if (options.model) params.model = options.model;
  if (options.effort)
    params.config = { model_reasoning_effort: options.effort };
  return params;
}

function threadResumeParams(
  options: CodexAppServerOptions,
  threadId: string,
): JsonObject {
  const params: JsonObject = {
    threadId,
    cwd: options.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
  if (options.model) params.model = options.model;
  if (options.effort)
    params.config = { model_reasoning_effort: options.effort };
  return params;
}

function turnStartParams(threadId: string, prompt: string): JsonObject {
  return {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
  };
}

function turnSteerParams(
  threadId: string,
  turnId: string,
  text: string,
  clientUserMessageId: string,
): JsonObject {
  return {
    threadId,
    expectedTurnId: turnId,
    input: [{ type: "text", text, text_elements: [] }],
    clientUserMessageId,
  };
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

type CodexRunOccurrence =
  | { readonly type: "provider-message"; readonly value: JsonObject }
  | { readonly type: "control"; readonly admission: ControlAdmission }
  | { readonly type: "control-source-close" }
  | { readonly type: "steering-settled" }
  | { readonly type: "cancel" }
  | { readonly type: "stderr"; readonly chunk: string }
  | { readonly type: "stdin-error"; readonly error: Error }
  | { readonly type: "process-error"; readonly error: Error }
  | { readonly type: "process-close"; readonly code: number | null }
  | { readonly type: "escalation"; readonly stage: "SIGTERM" | "SIGKILL" };

interface OrderedOccurrence {
  readonly sequence: number;
  readonly occurrence: CodexRunOccurrence;
}

interface PendingRequest {
  readonly accept: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly settleOnTransport: boolean;
}

type SourceConclusion =
  | { readonly status: "clean" }
  | { readonly status: "failed"; readonly errorMessage?: string };

/**
 * Run one disposable Codex App Server conversation. All externally occurring
 * inputs receive an ingress sequence before this engine interprets them; this
 * function is also the sole producer of the executor's terminal Ending.
 */
export function runCodexAppServer(
  options: CodexAppServerRunOptions,
): Promise<RunEnding> {
  const {
    cwd,
    childDepth,
    prompt,
    translate,
    report,
    signal = new AbortController().signal,
    controls = {
      subscribe: (_onAdmission, onClose) => {
        onClose?.();
        return () => {};
      },
    },
    missingAnswerMessage,
    onRequestRejection,
    spawn = defaultSpawn,
    killEscalationMs = DEFAULT_KILL_ESCALATION_MS,
  } = options;
  if (signal.aborted) return Promise.resolve({ ending: "cancelled" });

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn("codex", ["app-server"], spawnOptions(cwd, childDepth));
    } catch (error) {
      resolve({
        ending: "failed",
        errorMessage: boundedRedactedDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return;
    }

    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      let earlyClosed = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const finishEarlyCleanup = (): void => {
        if (earlyClosed) return;
        earlyClosed = true;
        if (escalation !== undefined) clearTimeout(escalation);
        proc.removeListener("close", finishEarlyCleanup);
        resolve({
          ending: "failed",
          errorMessage: "Failed to open Codex App Server stdio pipes",
        });
      };
      proc.once("close", finishEarlyCleanup);
      try {
        proc.stdin?.end();
        proc.kill("SIGTERM");
        if (!earlyClosed) {
          escalation = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // The process may have exited after SIGTERM.
            }
          }, killEscalationMs);
          escalation.unref?.();
        }
      } catch {
        // The partially opened child may already have exited.
      }
      return;
    }

    let nextRequestId = 1;
    let nextSequence = 1;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let cancellationSequence: number | undefined;
    let endingSettled = false;
    let settledEnding: RunEnding | undefined;
    let settledError: unknown;
    let completionDelivered = false;
    let childClosed = false;
    let sawStderr = false;
    let terminalAnswer = false;
    let witnessedError: string | undefined;
    let rawStdoutTail = "";
    let lineBuffer = "";
    let droppingLine = false;
    let stdinEnded = false;
    let terminationStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draining = false;
    let framingStdout = false;
    let reducingSequence: number | undefined;
    const queue: OrderedOccurrence[] = [];
    const earlyNotifications: {
      readonly sequence: number;
      readonly notification: CodexAppServerEvent;
    }[] = [];
    const pending = new Map<number, PendingRequest>();
    const pendingSteeringCorrelations = new Set<string>();
    const consumedSteeringItems = new Set<string>();
    const providerIdentities = new Set<string>();
    if (options.continuationThreadId)
      providerIdentities.add(options.continuationThreadId);
    const queuedControls: ControlAdmission[] = [];
    let steeringInFlight = false;
    let controlsClosed = false;
    let unsubscribeControls = () => {};

    const notifyRequestRejection = (error: Error): void => {
      try {
        onRequestRejection?.(error);
      } catch {
        // Diagnostics must not become a second settlement path.
      }
    };
    const redactDiagnostic = (value: string): string => {
      let redacted = redactProviderIds(value);
      const identities = [...providerIdentities].sort(
        (left, right) => right.length - left.length,
      );
      for (const identity of identities) {
        if (identity) redacted = redacted.split(identity).join("[redacted]");
      }
      return redacted.slice(0, RESULT_DIAGNOSTIC_LIMIT);
    };
    const rejectPending = (error: Error): void => {
      const requests = [...pending.values()];
      pending.clear();
      for (const request of requests) {
        notifyRequestRejection(error);
        if (request.settleOnTransport) request.reject(error);
      }
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
    const closeAttemptState = (): void => {
      closeControlAdmissions();
      clearSteeringState();
    };
    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const detachProcess = (): void => {
      proc.removeListener("error", onProcessError);
      proc.removeListener("close", onClose);
    };
    const detachStreams = (): void => {
      proc.stdout?.removeListener("data", onStdoutData);
      proc.stderr?.removeListener("data", onStderrData);
      proc.stdin?.removeListener("error", onStdinError);
    };
    const completeAfterCleanup = (): void => {
      if (completionDelivered || !endingSettled) return;
      completionDelivered = true;
      if (settledError !== undefined) reject(settledError);
      else resolve(settledEnding as RunEnding);
    };
    const finishCleanup = (): void => {
      clearTimer();
      signal.removeEventListener("abort", onAbort);
      detachStreams();
      detachProcess();
      rejectPending(new CodexAppServerTransportError("transport-settled"));
      completeAfterCleanup();
    };
    const endStdin = (): void => {
      if (stdinEnded) return;
      stdinEnded = true;
      try {
        proc.stdin?.end();
      } catch {
        // The child may have closed stdin during teardown.
      }
    };
    const kill = (stage: "SIGTERM" | "SIGKILL"): void => {
      try {
        proc.kill(stage);
      } catch {
        // The child may have exited between escalation stages.
      }
    };
    const cancellationPrecedes = (sequence: number | undefined): boolean =>
      cancellationSequence !== undefined &&
      (sequence === undefined || cancellationSequence <= sequence);
    const endingFrom = (
      conclusion: SourceConclusion,
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
    const settle = (conclusion: SourceConclusion): void => {
      if (endingSettled) return;
      endingSettled = true;
      closeAttemptState();
      settledEnding = endingFrom(conclusion, reducingSequence);
      if (childClosed) finishCleanup();
    };
    const failExecution = (error: unknown): void => {
      if (endingSettled) return;
      endingSettled = true;
      settledError = error;
      closeAttemptState();
      signal.removeEventListener("abort", onAbort);
      detachStreams();
      beginTermination(false);
      rejectPending(new CodexAppServerTransportError("transport-settled"));
      if (childClosed) finishCleanup();
    };
    const scheduleKill = (stage: "SIGTERM" | "SIGKILL"): void => {
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        admit({ type: "escalation", stage });
      }, killEscalationMs);
      timer.unref?.();
    };
    const beginTermination = (interrupt: boolean): void => {
      if (childClosed || terminationStarted) return;
      terminationStarted = true;
      if (interrupt && threadId && turnId) {
        sendRequest(
          "turn/interrupt",
          { threadId, turnId },
          () => {},
          () => {},
        );
        if (!endingSettled) scheduleKill("SIGTERM");
        return;
      }
      endStdin();
      kill("SIGTERM");
      scheduleKill("SIGKILL");
    };
    const finish = (
      conclusion: SourceConclusion,
      terminate: boolean,
      requestSettlement: CodexAppServerTransportRejectionReason,
    ): void => {
      if (endingSettled) return;
      signal.removeEventListener("abort", onAbort);
      detachStreams();
      closeControlAdmissions();
      rejectPending(new CodexAppServerTransportError(requestSettlement));
      if (terminate) beginTermination(false);
      else if (!childClosed) endStdin();
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
    const write = (value: JsonObject): boolean => {
      if (endingSettled) return false;
      try {
        proc.stdin?.write(`${JSON.stringify(value)}\n`, "utf8");
        return true;
      } catch (error) {
        reportStderr(
          `stdin: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        finish({ status: "failed" }, true, "transport-settled");
        return false;
      }
    };
    const sendNotification = (method: string, params?: JsonObject): void => {
      const value: JsonObject = { method };
      if (params) value.params = params;
      write(value);
    };
    function sendRequest(
      method: string,
      params: JsonObject,
      accept: (value: unknown) => void,
      rejectRequest: (error: Error) => void,
      settleOnTransport = false,
    ): void {
      if (endingSettled) {
        rejectRequest(new CodexAppServerTransportError("transport-settled"));
        return;
      }
      const id = nextRequestId++;
      pending.set(id, { accept, reject: rejectRequest, settleOnTransport });
      if (!write({ jsonrpc: "2.0", id, method, params })) pending.delete(id);
    }
    const startNextControl = (): void => {
      if (
        controlsClosed ||
        endingSettled ||
        steeringInFlight ||
        !threadId ||
        !turnId
      )
        return;
      const admission = queuedControls.shift();
      if (!admission) return;
      admission.acknowledge();
      steeringInFlight = true;
      const clientUserMessageId = globalThis.crypto.randomUUID();
      pendingSteeringCorrelations.add(clientUserMessageId);
      providerIdentities.add(clientUserMessageId);
      sendRequest(
        "turn/steer",
        turnSteerParams(
          threadId,
          turnId,
          admission.control.text,
          clientUserMessageId,
        ),
        () => {
          queueMicrotask(() => admit({ type: "steering-settled" }));
        },
        (error) => {
          pendingSteeringCorrelations.delete(clientUserMessageId);
          if (error instanceof CodexAppServerRequestError)
            reportStderr(steeringDiagnostic(error, redactDiagnostic));
          queueMicrotask(() => admit({ type: "steering-settled" }));
        },
        true,
      );
    };
    const responseError = (value: unknown): string | undefined =>
      isRecord(value) && typeof value.message === "string"
        ? value.message
        : undefined;
    const startupFailure = (error: Error): void => {
      finish(
        { status: "failed", errorMessage: redactDiagnostic(error.message) },
        true,
        "transport-settled",
      );
    };
    const startTurn = (): void => {
      if (!threadId || endingSettled || cancellationSequence !== undefined)
        return;
      const attachedThreadId = threadId;
      sendRequest(
        "turn/start",
        turnStartParams(attachedThreadId, prompt),
        (turn) => {
          if (
            !isRecord(turn) ||
            !isRecord(turn.turn) ||
            typeof turn.turn.id !== "string"
          ) {
            startupFailure(
              new Error(
                "Codex App Server returned an invalid turn/start response",
              ),
            );
            return;
          }
          turnId = turn.turn.id;
          providerIdentities.add(turnId);
          try {
            options.onThreadAttached?.(attachedThreadId);
          } catch (error) {
            failExecution(error);
            return;
          }
          flushEarlyNotifications();
          startNextControl();
        },
        startupFailure,
      );
    };
    const attachThread = (
      method: "thread/start" | "thread/resume",
      params: JsonObject,
      expectedThreadId?: string,
    ): void => {
      if (endingSettled || cancellationSequence !== undefined) return;
      sendRequest(
        method,
        params,
        (thread) => {
          if (
            !isRecord(thread) ||
            !isRecord(thread.thread) ||
            typeof thread.thread.id !== "string" ||
            (expectedThreadId !== undefined &&
              thread.thread.id !== expectedThreadId)
          ) {
            startupFailure(
              new Error(
                `Codex App Server returned an invalid ${method} response`,
              ),
            );
            return;
          }
          threadId = thread.thread.id;
          providerIdentities.add(threadId);
          startTurn();
        },
        startupFailure,
      );
    };
    const startThread = (): void => {
      const continuation = options.continuationThreadId;
      if (continuation) {
        attachThread(
          "thread/resume",
          threadResumeParams(options, continuation),
          continuation,
        );
      } else {
        attachThread("thread/start", threadStartParams(options));
      }
    };
    const start = (): void => {
      sendRequest(
        "initialize",
        initializeParams(),
        (initialize) => {
          if (!isInitializeResponse(initialize)) {
            startupFailure(
              new Error(
                "Codex App Server returned an invalid initialize response",
              ),
            );
            return;
          }
          if (endingSettled || cancellationSequence !== undefined) return;
          sendNotification("initialized");
          startThread();
        },
        startupFailure,
      );
    };
    const handleResponse = (value: JsonObject): void => {
      if (
        !Number.isInteger(value.id) ||
        (!("result" in value) && !("error" in value))
      )
        return;
      const request = pending.get(value.id as number);
      if (!request) return;
      pending.delete(value.id as number);
      if ("error" in value) {
        const jsonRpcError = parseCodexAppServerResponseError(value.error);
        const rejection = jsonRpcError
          ? new CodexAppServerRequestError(jsonRpcError)
          : new Error(
              responseError(value.error) ?? "Codex App Server request failed",
            );
        notifyRequestRejection(rejection);
        request.reject(rejection);
      } else request.accept(value.result);
    };
    const handleServerRequest = (value: JsonObject): void => {
      const id = value.id;
      if (
        (typeof id !== "number" && typeof id !== "string") ||
        (typeof id === "number" && !Number.isInteger(id)) ||
        typeof value.method !== "string"
      )
        return;
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: "Method not supported by pi-subagent",
        },
      });
      reportStderr(
        `Codex App Server requested unsupported method '${value.method}'\n`,
      );
    };
    const applyTranslation = (
      sequence: number,
      notification: CodexAppServerEvent,
    ): void => {
      let translation: Translation | undefined;
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
        translation = translate(notification);
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
    const matchesRunIdentity = (notification: CodexAppServerEvent): boolean => {
      if (!threadId || notification.params.threadId !== threadId) return false;
      if (!turnId) return false;
      return notification.method === "turn/completed"
        ? notification.params.turn.id === turnId
        : notification.params.turnId === turnId;
    };
    const forwardNotification = (
      sequence: number,
      notification: CodexAppServerEvent,
    ): void => {
      if (endingSettled || !matchesRunIdentity(notification)) return;
      applyTranslation(sequence, notification);
      if (!endingSettled && notification.method === "turn/completed")
        finish(
          { status: "clean" },
          !cancellationPrecedes(sequence),
          "semantic-settled",
        );
    };
    function flushEarlyNotifications(): void {
      if (!threadId || !turnId || endingSettled) return;
      const retained = earlyNotifications.splice(0);
      for (const entry of retained) {
        forwardNotification(entry.sequence, entry.notification);
        if (endingSettled) return;
      }
    }
    const handleProviderMessage = (
      sequence: number,
      value: JsonObject,
    ): void => {
      if (typeof value.method === "string") {
        if ("id" in value) {
          handleServerRequest(value);
          return;
        }
        const notification = parseNotification(value);
        if (!notification) return;
        if (!threadId || !turnId) {
          earlyNotifications.push({ sequence, notification });
          return;
        }
        forwardNotification(sequence, notification);
        return;
      }
      handleResponse(value);
    };
    const handleProcessClose = (
      sequence: number,
      code: number | null,
    ): void => {
      childClosed = true;
      clearTimer();
      rejectPending(new CodexAppServerTransportError("child-exited"));
      if (endingSettled) {
        finishCleanup();
        return;
      }
      if (cancellationPrecedes(sequence)) {
        finish({ status: "clean" }, false, "child-exited");
        return;
      }
      if (code === 0) {
        if (!sawStderr && !terminalAnswer) {
          const tail = redactProviderIds(rawStdoutTail.trim());
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
      if (!sawStderr && !terminalAnswer && rawStdoutTail.trim()) {
        if (
          !reportStderr(
            `Last stdout:\n${redactProviderIds(rawStdoutTail.trim())}`,
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
          handleProviderMessage(sequence, occurrence.value);
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
          beginTermination(Boolean(threadId && turnId));
          return;
        case "stderr":
          reportStderr(occurrence.chunk);
          return;
        case "stdin-error":
          reportStderr(`stdin: ${occurrence.error.message}\n`);
          return;
        case "process-error":
          if (!reportStderr(`${occurrence.error.message}\n`)) return;
          finish({ status: "failed" }, true, "transport-settled");
          return;
        case "process-close":
          handleProcessClose(sequence, occurrence.code);
          return;
        case "escalation":
          if (childClosed) return;
          kill(occurrence.stage);
          if (occurrence.stage === "SIGTERM") scheduleKill("SIGKILL");
          else endStdin();
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
    function admit(occurrence: CodexRunOccurrence): void {
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
    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (isRecord(value)) admit({ type: "provider-message", value });
    };
    const processChunk = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      rawStdoutTail = (rawStdoutTail + text).slice(-RAW_STDOUT_TAIL_LIMIT);
      let rest = text;
      while (rest) {
        if (droppingLine) {
          const newline = rest.indexOf("\n");
          if (newline < 0) return;
          droppingLine = false;
          rest = rest.slice(newline + 1);
          continue;
        }
        lineBuffer += rest;
        rest = "";
        while (true) {
          const newline = lineBuffer.indexOf("\n");
          if (newline < 0) {
            if (lineBuffer.length > STDOUT_LINE_LIMIT) {
              lineBuffer = "";
              droppingLine = true;
            }
            return;
          }
          const line = lineBuffer.slice(0, newline);
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line.length <= STDOUT_LINE_LIMIT) processLine(line);
          if (endingSettled) return;
        }
      }
    };
    function onStdoutData(data: Buffer | string): void {
      framingStdout = true;
      try {
        processChunk(data);
      } catch (error) {
        failExecution(error);
      } finally {
        framingStdout = false;
        drainQueue();
      }
    }
    function onStderrData(data: Buffer | string): void {
      admit({ type: "stderr", chunk: data.toString() });
    }
    function onStdinError(error: Error): void {
      admit({ type: "stdin-error", error });
    }
    function onProcessError(error: Error): void {
      admit({ type: "process-error", error });
    }
    function onClose(code: number | null): void {
      framingStdout = true;
      try {
        if (!endingSettled) {
          if (lineBuffer.length > 0 && lineBuffer.length <= STDOUT_LINE_LIMIT)
            processLine(lineBuffer);
          lineBuffer = "";
        }
        admit({ type: "process-close", code });
      } finally {
        framingStdout = false;
        drainQueue();
      }
    }
    function onAbort(): void {
      admit({ type: "cancel" });
    }

    proc.stdout.on("data", onStdoutData);
    proc.stderr.on("data", onStderrData);
    proc.stdin.on("error", onStdinError);
    proc.on("error", onProcessError);
    proc.on("close", onClose);
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
    if (signal.aborted) onAbort();
    else start();
  });
}
