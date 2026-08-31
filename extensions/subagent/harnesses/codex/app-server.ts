import {
  type ChildProcess,
  spawn as defaultSpawn,
  type SpawnOptions,
} from "node:child_process";
import type { ControlAdmission, ControlSource } from "../../control-source.ts";
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
const TOKEN_USAGE_COUNTERS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const satisfies readonly (keyof TokenUsageBreakdown)[];
const CLIENT_INFO = {
  name: "pi-subagent",
  title: "pi-subagent",
  version: "1.0.0",
} as const;

type JsonObject = Record<string, unknown>;
type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type ChildProcessSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CodexTranslation {
  facts?: Fact[];
  transcript?: Fact[];
  /** Live UI activity: absent leaves it unchanged, null clears it. */
  activity?: string | null;
  terminal?: boolean;
  errorMessage?: string;
}

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

export interface CodexAppServerSessionOptions {
  readonly cwd: string;
  readonly childDepth: number;
  readonly model?: string;
  readonly effort?: string;
  readonly onRequestRejection?: (error: Error) => void;
  readonly spawn?: ChildProcessSpawn;
  readonly killEscalationMs?: number;
}

export interface CodexAppServerTurnOptions {
  readonly prompt: string;
  readonly translate: (
    event: CodexAppServerEvent,
  ) => CodexTranslation | undefined;
  readonly report: RunReporter;
  readonly signal?: AbortSignal;
  readonly controls?: ControlSource;
  readonly missingAnswerMessage: string;
}

export interface CodexAppServerSession {
  /** Whether the same in-memory Conversation can accept a later Turn. */
  readonly continuationAvailable: boolean;
  /** Whether this session has written a provider `turn/start` request. */
  readonly hasIssuedTurn: boolean;
  runNextTurn(options: CodexAppServerTurnOptions): Promise<RunEnding>;
  close(): Promise<void>;
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

function threadStartParams(options: CodexAppServerSessionOptions): JsonObject {
  const params: JsonObject = {
    cwd: options.cwd,
    ephemeral: true,
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

interface CodexTransportMessage {
  consume(): CodexAppServerEvent | string | undefined;
}

type CodexTransportOccurrence =
  | {
      readonly type: "provider-message";
      readonly message: CodexTransportMessage;
    }
  | { readonly type: "stderr"; readonly chunk: string }
  | { readonly type: "stdin-error"; readonly error: Error }
  | { readonly type: "stdin-write-error"; readonly error: Error }
  | { readonly type: "process-error"; readonly error: Error }
  | { readonly type: "process-close"; readonly code: number | null }
  | { readonly type: "escalation"; readonly stage: "SIGTERM" | "SIGKILL" };

type CodexRunOccurrence =
  | CodexTransportOccurrence
  | { readonly type: "control"; readonly admission: ControlAdmission }
  | { readonly type: "control-source-close" }
  | { readonly type: "steering-settled" }
  | { readonly type: "cancel" };

interface OrderedOccurrence {
  readonly sequence: number;
  readonly occurrence: CodexRunOccurrence;
}

interface PendingRequest {
  readonly accept: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly settleOnTransport: boolean;
}

type CodexProcessConclusion =
  | { readonly status: "clean" }
  | { readonly status: "failed"; readonly errorMessage?: string };

interface CodexTransportObserver {
  readonly admit: (occurrence: CodexTransportOccurrence) => void;
  readonly beginFrame: () => void;
  readonly endFrame: () => void;
}

type ProcessStartResult =
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly errorMessage: string };

interface CodexTransportTurn {
  steer(
    text: string,
    clientUserMessageId: string,
    accept: () => void,
    reject: (error: Error) => void,
  ): void;
  matches(event: CodexAppServerEvent): boolean;
  interrupt(): void;
  completeInterruption(): void;
}

interface CodexAppServerTransport {
  readonly continuationAvailable: boolean;
  readonly hasIssuedTurn: boolean;
  readonly stdoutTail: string;
  beginTurn(): void;
  attach(observer: CodexTransportObserver): void;
  detach(observer: CodexTransportObserver): void;
  start(): ProcessStartResult;
  startTurn(
    prompt: string,
    accept: (turn: CodexTransportTurn) => void,
    reject: (error: Error) => void,
  ): void;
  normalizeTurnUsage(
    tokenUsage: ThreadTokenUsage,
    allowBaselineReset: boolean,
  ): ThreadTokenUsage;
  redactDiagnostic(
    value: string,
    additionalIdentities?: ReadonlySet<string>,
  ): string;
  rejectPending(error: Error): void;
  terminate(): void;
  escalate(stage: "SIGTERM" | "SIGKILL"): void;
  close(): Promise<void>;
}

interface CodexAppServerRunOptions extends CodexAppServerTurnOptions {
  readonly connection: CodexAppServerTransport;
}

/** Process-scoped state retained by one App Server session. */
class CodexAppServerConnection implements CodexAppServerTransport {
  private proc: ChildProcess | undefined;
  private observer: CodexTransportObserver | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private rootThreadId: string | undefined;
  private currentTurnId: string | undefined;
  private issuedTurn = false;
  private initialized = false;
  private terminal = false;
  private childClosed = false;
  private rawStdoutTail = "";
  private cumulativeUsage: TokenUsageBreakdown | undefined;
  private lineBuffer = "";
  private droppingLine = false;
  private stdinEnded = false;
  private terminationState: "none" | "interrupting" | "terminating" = "none";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private processDone: Promise<void> = Promise.resolve();
  private resolveProcessDone: (() => void) | undefined;

  constructor(private readonly options: CodexAppServerSessionOptions) {}

  get threadId(): string | undefined {
    return this.rootThreadId;
  }

  get isChildClosed(): boolean {
    return this.childClosed;
  }

  get stdoutTail(): string {
    return this.rawStdoutTail;
  }

  get continuationAvailable(): boolean {
    return !this.terminal && this.terminationState !== "terminating";
  }

  get hasIssuedTurn(): boolean {
    return this.issuedTurn;
  }

  beginTurn(): void {
    this.rawStdoutTail = "";
    this.currentTurnId = undefined;
  }

  attach(observer: CodexTransportObserver): void {
    this.observer = observer;
  }

  detach(observer: CodexTransportObserver): void {
    if (this.observer === observer) this.observer = undefined;
  }

  start(): ProcessStartResult {
    if (this.proc)
      return this.terminal || this.terminationState === "terminating"
        ? {
            status: "failed",
            errorMessage: "Codex App Server session is closed",
          }
        : { status: "ready" };
    if (this.terminal)
      return {
        status: "failed",
        errorMessage: "Codex App Server session is closed",
      };

    let proc: ChildProcess;
    try {
      proc = (this.options.spawn ?? defaultSpawn)(
        "codex",
        ["app-server"],
        spawnOptions(this.options.cwd, this.options.childDepth),
      );
    } catch (error) {
      this.terminal = true;
      return {
        status: "failed",
        errorMessage: boundedRedactedDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }

    this.proc = proc;
    this.processDone = new Promise<void>((resolve) => {
      this.resolveProcessDone = resolve;
    });
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      this.terminatePartiallyOpenedProcess();
      return {
        status: "failed",
        errorMessage: "Failed to open Codex App Server stdio pipes",
      };
    }

    proc.stdout.on("data", this.onStdoutData);
    proc.stderr.on("data", this.onStderrData);
    proc.stdin.on("error", this.onStdinError);
    proc.on("error", this.onProcessError);
    proc.on("close", this.onClose);
    return { status: "ready" };
  }

  ensureThread(
    accept: (threadId: string) => void,
    reject: (error: Error) => void,
  ): void {
    if (this.initialized && this.rootThreadId) {
      accept(this.rootThreadId);
      return;
    }
    this.sendRequest(
      "initialize",
      initializeParams(),
      (initialize) => {
        if (!isInitializeResponse(initialize)) {
          reject(
            new Error(
              "Codex App Server returned an invalid initialize response",
            ),
          );
          return;
        }
        this.initialized = true;
        this.sendNotification("initialized");
        this.startThread(accept, reject);
      },
      reject,
    );
  }

  startTurn(
    prompt: string,
    accept: (turn: CodexTransportTurn) => void,
    reject: (error: Error) => void,
  ): void {
    this.ensureThread((threadId) => {
      this.sendRequest(
        "turn/start",
        turnStartParams(threadId, prompt),
        (turn) => {
          if (
            !isRecord(turn) ||
            !isRecord(turn.turn) ||
            typeof turn.turn.id !== "string"
          ) {
            reject(
              new Error(
                "Codex App Server returned an invalid turn/start response",
              ),
            );
            return;
          }
          const turnId = turn.turn.id;
          this.currentTurnId = turnId;
          accept({
            steer: (text, clientUserMessageId, onAccept, onReject) => {
              this.sendRequest(
                "turn/steer",
                turnSteerParams(threadId, turnId, text, clientUserMessageId),
                onAccept,
                onReject,
                true,
              );
            },
            matches: (event) =>
              event.params.threadId === threadId &&
              (event.method === "turn/completed"
                ? event.params.turn.id === turnId
                : event.params.turnId === turnId),
            interrupt: () => this.interrupt(threadId, turnId),
            completeInterruption: () => this.completeInterruption(),
          });
        },
        reject,
      );
    }, reject);
  }

  redactDiagnostic(
    value: string,
    additionalIdentities: ReadonlySet<string> = new Set(),
  ): string {
    let redacted = redactProviderIds(value);
    const identities = [
      this.rootThreadId,
      this.currentTurnId,
      ...additionalIdentities,
    ]
      .filter((identity): identity is string => Boolean(identity))
      .sort((left, right) => right.length - left.length);
    for (const identity of identities) {
      redacted = redacted.split(identity).join("[redacted]");
    }
    return redacted;
  }

  sendNotification(method: string, params?: JsonObject): void {
    const value: JsonObject = { method };
    if (params) value.params = params;
    this.write(value);
  }

  sendRequest(
    method: string,
    params: JsonObject,
    accept: (value: unknown) => void,
    rejectRequest: (error: Error) => void,
    settleOnTransport = false,
  ): void {
    if (this.terminal || this.childClosed) {
      rejectRequest(new CodexAppServerTransportError("transport-settled"));
      return;
    }
    const id = this.nextRequestId++;
    this.pending.set(id, {
      accept,
      reject: rejectRequest,
      settleOnTransport,
    });
    if (!this.write({ jsonrpc: "2.0", id, method, params }))
      this.pending.delete(id);
    else if (method === "turn/start") this.issuedTurn = true;
  }

  consumeProviderMessage(
    value: JsonObject,
  ): CodexAppServerEvent | string | undefined {
    if (typeof value.method === "string") {
      if ("id" in value) return this.handleServerRequest(value);
      return parseNotification(value);
    }
    this.handleResponse(value);
    return undefined;
  }

  normalizeTurnUsage(
    tokenUsage: ThreadTokenUsage,
    allowBaselineReset: boolean,
  ): ThreadTokenUsage {
    const next = { ...tokenUsage.total };
    const baseline =
      allowBaselineReset &&
      this.cumulativeUsage &&
      TOKEN_USAGE_COUNTERS.some(
        (key) => next[key] < (this.cumulativeUsage?.[key] ?? 0),
      )
        ? undefined
        : this.cumulativeUsage;
    const delta = { ...next };
    for (const key of TOKEN_USAGE_COUNTERS)
      delta[key] = Math.max(0, next[key] - (baseline?.[key] ?? 0));
    this.cumulativeUsage = next;
    return {
      ...tokenUsage,
      total: delta,
      last: { ...tokenUsage.last },
    };
  }

  rejectPending(error: Error): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) {
      this.notifyRequestRejection(error);
      if (request.settleOnTransport) request.reject(error);
    }
  }

  interrupt(threadId: string, turnId: string): void {
    if (this.childClosed || this.terminationState !== "none") return;
    this.terminationState = "interrupting";
    this.sendRequest(
      "turn/interrupt",
      { threadId, turnId },
      () => {},
      () => {},
    );
    this.scheduleKill("SIGTERM");
  }

  completeInterruption(): void {
    if (this.terminationState !== "interrupting") return;
    this.clearTimer();
    this.terminationState = "none";
  }

  terminate(): void {
    if (this.childClosed || this.terminationState === "terminating") return;
    this.clearTimer();
    this.terminationState = "terminating";
    if (!this.proc) return;
    this.endStdin();
    this.kill("SIGTERM");
    this.scheduleKill("SIGKILL");
  }

  async close(): Promise<void> {
    if (!this.proc || this.childClosed) {
      this.clearTimer();
      return;
    }
    this.endStdin();
    if (this.terminationState === "none") {
      this.terminationState = "terminating";
      this.scheduleKill("SIGTERM");
    }
    await this.processDone;
  }

  escalate(stage: "SIGTERM" | "SIGKILL"): void {
    if (this.childClosed) return;
    this.terminationState = "terminating";
    this.kill(stage);
    if (stage === "SIGTERM") this.scheduleKill("SIGKILL");
    else this.endStdin();
  }

  private write(value: JsonObject): boolean {
    if (this.terminal || this.childClosed) return false;
    try {
      this.proc?.stdin?.write(`${JSON.stringify(value)}\n`, "utf8");
      return true;
    } catch (error) {
      this.observer?.admit({
        type: "stdin-write-error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return false;
    }
  }

  private startThread(
    accept: (threadId: string) => void,
    reject: (error: Error) => void,
  ): void {
    this.sendRequest(
      "thread/start",
      threadStartParams(this.options),
      (thread) => {
        if (
          !isRecord(thread) ||
          !isRecord(thread.thread) ||
          typeof thread.thread.id !== "string"
        ) {
          reject(
            new Error(
              "Codex App Server returned an invalid thread/start response",
            ),
          );
          return;
        }
        this.rootThreadId = thread.thread.id;
        accept(thread.thread.id);
      },
      reject,
    );
  }

  private handleResponse(value: JsonObject): void {
    if (
      !Number.isInteger(value.id) ||
      (!("result" in value) && !("error" in value))
    )
      return;
    const request = this.pending.get(value.id as number);
    if (!request) return;
    this.pending.delete(value.id as number);
    if ("error" in value) {
      const jsonRpcError = parseCodexAppServerResponseError(value.error);
      const rejection = jsonRpcError
        ? new CodexAppServerRequestError(jsonRpcError)
        : new Error(
            isRecord(value.error) && typeof value.error.message === "string"
              ? value.error.message
              : "Codex App Server request failed",
          );
      this.notifyRequestRejection(rejection);
      request.reject(rejection);
    } else request.accept(value.result);
  }

  private handleServerRequest(value: JsonObject): string | undefined {
    const id = value.id;
    if (
      (typeof id !== "number" && typeof id !== "string") ||
      (typeof id === "number" && !Number.isInteger(id)) ||
      typeof value.method !== "string"
    )
      return undefined;
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Method not supported by pi-subagent",
      },
    });
    return `Codex App Server requested unsupported method '${value.method}'\n`;
  }

  private notifyRequestRejection(error: Error): void {
    try {
      this.options.onRequestRejection?.(error);
    } catch {
      // Diagnostics must not become a second settlement path.
    }
  }

  private processLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    if (this.observer) {
      this.observer.admit({
        type: "provider-message",
        message: { consume: () => this.consumeProviderMessage(value) },
      });
    } else this.consumeProviderMessage(value);
  }

  private processChunk(chunk: Buffer | string): void {
    const text = chunk.toString();
    this.rawStdoutTail = (this.rawStdoutTail + text).slice(
      -RAW_STDOUT_TAIL_LIMIT,
    );
    let rest = text;
    while (rest) {
      if (this.droppingLine) {
        const newline = rest.indexOf("\n");
        if (newline < 0) return;
        this.droppingLine = false;
        rest = rest.slice(newline + 1);
        continue;
      }
      this.lineBuffer += rest;
      rest = "";
      while (true) {
        const newline = this.lineBuffer.indexOf("\n");
        if (newline < 0) {
          if (this.lineBuffer.length > STDOUT_LINE_LIMIT) {
            this.lineBuffer = "";
            this.droppingLine = true;
          }
          return;
        }
        const line = this.lineBuffer.slice(0, newline);
        this.lineBuffer = this.lineBuffer.slice(newline + 1);
        if (line.length <= STDOUT_LINE_LIMIT) this.processLine(line);
      }
    }
  }

  private readonly onStdoutData = (data: Buffer | string): void => {
    const observer = this.observer;
    observer?.beginFrame();
    try {
      this.processChunk(data);
    } finally {
      observer?.endFrame();
    }
  };

  private readonly onStderrData = (data: Buffer | string): void => {
    this.observer?.admit({ type: "stderr", chunk: data.toString() });
  };

  private readonly onStdinError = (error: Error): void => {
    this.observer?.admit({ type: "stdin-error", error });
  };

  private readonly onProcessError = (error: Error): void => {
    if (this.terminal || this.childClosed) return;
    this.terminal = true;
    this.rejectPending(new CodexAppServerTransportError("transport-settled"));
    const observer = this.observer;
    if (observer) observer.admit({ type: "process-error", error });
    else this.terminate();
  };

  private readonly onClose = (code: number | null): void => {
    if (this.childClosed) return;
    this.childClosed = true;
    this.terminal = true;
    this.clearTimer();
    this.rejectPending(new CodexAppServerTransportError("child-exited"));
    const observer = this.observer;
    observer?.beginFrame();
    try {
      if (
        this.lineBuffer.length > 0 &&
        this.lineBuffer.length <= STDOUT_LINE_LIMIT
      )
        this.processLine(this.lineBuffer);
      this.lineBuffer = "";
      observer?.admit({ type: "process-close", code });
    } finally {
      observer?.endFrame();
      this.detachProcess();
      this.resolveProcessDone?.();
      this.resolveProcessDone = undefined;
    }
  };

  private terminatePartiallyOpenedProcess(): void {
    const proc = this.proc;
    if (!proc) return;
    this.terminationState = "terminating";
    const finish = (): void => {
      if (this.childClosed) return;
      this.childClosed = true;
      this.terminal = true;
      this.clearTimer();
      proc.removeListener("close", finish);
      this.resolveProcessDone?.();
      this.resolveProcessDone = undefined;
    };
    proc.once("close", finish);
    try {
      proc.stdin?.end();
      proc.kill("SIGTERM");
      this.timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process may have exited after SIGTERM.
        }
      }, this.options.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS);
      this.timer.unref?.();
    } catch {
      finish();
    }
  }

  private scheduleKill(stage: "SIGTERM" | "SIGKILL"): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.observer) this.observer.admit({ type: "escalation", stage });
      else this.escalate(stage);
    }, this.options.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private endStdin(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    try {
      this.proc?.stdin?.end();
    } catch {
      // The child may have closed stdin during teardown.
    }
  }

  private kill(stage: "SIGTERM" | "SIGKILL"): void {
    try {
      this.proc?.kill(stage);
    } catch {
      // The child may have exited between escalation stages.
    }
  }

  private detachProcess(): void {
    const proc = this.proc;
    if (!proc) return;
    proc.stdout?.removeListener("data", this.onStdoutData);
    proc.stderr?.removeListener("data", this.onStderrData);
    proc.stdin?.removeListener("error", this.onStdinError);
    proc.removeListener("error", this.onProcessError);
    proc.removeListener("close", this.onClose);
  }
}

/** Own one App Server session and at most one active Run-scoped Turn. */
class CodexAppServerSessionOwner implements CodexAppServerSession {
  private active:
    | {
        readonly controller: AbortController;
        readonly promise: Promise<RunEnding>;
      }
    | undefined;
  private closed = false;
  private started = false;
  private closePromise: Promise<void> | undefined;
  private readonly connection: CodexAppServerTransport;

  constructor(
    sessionOptions: CodexAppServerSessionOptions,
    connection: CodexAppServerTransport = new CodexAppServerConnection(
      sessionOptions,
    ),
  ) {
    this.connection = connection;
  }

  get continuationAvailable(): boolean {
    return !this.closed && this.connection.continuationAvailable;
  }

  get hasIssuedTurn(): boolean {
    return this.connection.hasIssuedTurn;
  }

  runNextTurn(turnOptions: CodexAppServerTurnOptions): Promise<RunEnding> {
    if (this.closed)
      return this.started
        ? Promise.resolve({
            ending: "failed",
            errorMessage: "Codex App Server session is closed",
          })
        : Promise.resolve({ ending: "cancelled" });
    if (this.active)
      return Promise.resolve({
        ending: "failed",
        errorMessage: "Codex App Server session already has an active Turn",
      });

    this.started = true;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (turnOptions.signal?.aborted) controller.abort();
    else
      turnOptions.signal?.addEventListener("abort", forwardAbort, {
        once: true,
      });
    const promise = runCodexAppServerTurn({
      ...turnOptions,
      connection: this.connection,
      signal: controller.signal,
    }).finally(() => {
      turnOptions.signal?.removeEventListener("abort", forwardAbort);
    });
    const current = { controller, promise };
    this.active = current;
    void promise.then(
      () => {
        if (this.active === current) this.active = undefined;
      },
      () => {
        if (this.active === current) this.active = undefined;
      },
    );
    return promise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const current = this.active;
    current?.controller.abort();
    this.closePromise = (async () => {
      await current?.promise.catch(() => {});
      await this.connection.close();
    })();
    return this.closePromise;
  }
}

/**
 * TODO(ticket 04): this unchanged ordered Turn reducer is the temporary
 * contraction surface for extraction into the Codex Attempt module.
 *
 * Execute one fresh Turn for the session owner. All externally occurring
 * inputs receive an ingress sequence before this reducer interprets them; the
 * Turn is the sole producer of its terminal Ending.
 */
function runCodexAppServerTurn(
  options: CodexAppServerRunOptions,
): Promise<RunEnding> {
  const {
    connection,
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
  } = options;
  if (signal.aborted) return Promise.resolve({ ending: "cancelled" });
  connection.beginTurn();
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
      return connection
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
      connection.detach(observer);
      resolve(endingFrom(conclusion, reducingSequence));
    };
    const failExecution = (error: unknown): void => {
      if (endingSettled) return;
      endingSettled = true;
      closeTurnState();
      signal.removeEventListener("abort", onAbort);
      connection.detach(observer);
      connection.terminate();
      connection.rejectPending(
        new CodexAppServerTransportError("transport-settled"),
      );
      reject(error);
    };
    const finish = (
      conclusion: CodexProcessConclusion,
      terminate: boolean,
      requestSettlement: CodexAppServerTransportRejectionReason,
    ): void => {
      if (endingSettled) return;
      closeControlAdmissions();
      connection.rejectPending(
        new CodexAppServerTransportError(requestSettlement),
      );
      if (terminate && conclusion.status === "failed") connection.terminate();
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
          if (error instanceof CodexAppServerRequestError)
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
      connection.startTurn(
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
          const tokenUsage = connection.normalizeTurnUsage(
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
    const matchesRunIdentity = (notification: CodexAppServerEvent): boolean => {
      return turn?.matches(notification) ?? false;
    };
    const forwardNotification = (
      sequence: number,
      notification: CodexAppServerEvent,
    ): void => {
      if (endingSettled || !matchesRunIdentity(notification)) return;
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
          const tail = redactProviderIds(connection.stdoutTail.trim());
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
      if (!sawStderr && !terminalAnswer && connection.stdoutTail.trim()) {
        if (
          !reportStderr(
            `Last stdout:\n${redactProviderIds(connection.stdoutTail.trim())}`,
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
          else connection.terminate();
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
        case "process-error":
          {
            const errorMessage = redactDiagnostic(occurrence.error.message);
            if (!reportStderr(`${errorMessage}\n`)) return;
            finish(
              { status: "failed", errorMessage },
              true,
              "transport-settled",
            );
          }
          return;
        case "process-close":
          handleProcessClose(sequence, occurrence.code);
          return;
        case "escalation":
          connection.escalate(occurrence.stage);
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
    connection.attach(observer);
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
    const processStart = connection.start();
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

/**
 * Create the Codex-owned lifecycle module behind the Harness Adapter seam.
 * One instance owns one retained ephemeral root Conversation until close or
 * terminal process loss.
 */
export function createCodexAppServerSession(
  options: CodexAppServerSessionOptions,
  transport?: CodexAppServerTransport,
): CodexAppServerSession {
  return new CodexAppServerSessionOwner(options, transport);
}
