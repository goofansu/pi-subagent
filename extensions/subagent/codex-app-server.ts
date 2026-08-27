import {
  type ChildProcess,
  spawn as defaultSpawn,
  type SpawnOptions,
} from "node:child_process";
import type { ChildProcessSpawn } from "./child-process.ts";
import type { OneShotSource } from "./one-shot.ts";
import { DEPTH_ENV_KEY } from "./run.ts";

const STDOUT_LINE_LIMIT = 32 * 1024 * 1024;
const RAW_STDOUT_TAIL_LIMIT = 2000;
const DEFAULT_KILL_ESCALATION_MS = 5000;
const CLIENT_INFO = {
  name: "pi-subagent",
  title: "pi-subagent",
  version: "1.0.0",
} as const;

type JsonObject = Record<string, unknown>;
type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export interface TurnError {
  message: string;
  codexErrorInfo: unknown | null;
  additionalDetails: string | null;
}

export type ThreadItem =
  | { type: "userMessage"; id: string; content: unknown[] }
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
      commandActions?: { type: string; command: string }[];
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

export type CodexAppServerEvent =
  | { method: "item/started"; params: ItemStartedParams; emittedAtMs: number }
  | {
      method: "item/completed";
      params: ItemCompletedParams;
      emittedAtMs: number;
    }
  | {
      method: "item/agentMessage/delta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
      emittedAtMs: number;
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
      emittedAtMs: number;
    }
  | {
      method: "thread/tokenUsage/updated";
      params: {
        threadId: string;
        turnId: string;
        tokenUsage: ThreadTokenUsage;
      };
      emittedAtMs: number;
    }
  | {
      method: "turn/completed";
      params: { threadId: string; turn: Turn };
      emittedAtMs: number;
    }
  | {
      method: "error";
      params: {
        error: TurnError;
        willRetry: boolean;
        threadId: string;
        turnId: string;
      };
      emittedAtMs: number;
    };

export interface CodexAppServerOptions {
  readonly cwd: string;
  readonly childDepth: number;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly spawn?: ChildProcessSpawn;
  readonly killEscalationMs?: number;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  if (
    !("codexErrorInfo" in value) ||
    !("additionalDetails" in value) ||
    (value.additionalDetails !== null &&
      typeof value.additionalDetails !== "string")
  ) {
    return undefined;
  }
  return {
    message: value.message,
    codexErrorInfo: value.codexErrorInfo,
    additionalDetails: value.additionalDetails,
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
      return Array.isArray(value.content) ? (value as ThreadItem) : undefined;
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
    case "reasoning":
      return Array.isArray(value.summary) &&
        value.summary.every((part) => typeof part === "string") &&
        Array.isArray(value.content) &&
        value.content.every((part) => typeof part === "string")
        ? (value as ThreadItem)
        : undefined;
    case "commandExecution":
      return typeof value.command === "string" &&
        typeof value.cwd === "string" &&
        (value.status === "inProgress" ||
          value.status === "completed" ||
          value.status === "failed" ||
          value.status === "declined") &&
        (value.aggregatedOutput === null ||
          typeof value.aggregatedOutput === "string") &&
        (value.exitCode === null || isNumber(value.exitCode)) &&
        (value.durationMs === null || isNumber(value.durationMs)) &&
        (value.commandActions === undefined ||
          (Array.isArray(value.commandActions) &&
            value.commandActions.every(
              (action) =>
                isRecord(action) &&
                typeof action.type === "string" &&
                typeof action.command === "string",
            )))
        ? (value as ThreadItem)
        : undefined;
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
      "cacheWriteInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
    ] as const;
    if (!fields.every((field) => isNumber(candidate[field]))) return undefined;
    return Object.fromEntries(
      fields.map((field) => [field, candidate[field]]),
    ) as unknown as TokenUsageBreakdown;
  };
  const total = breakdown(value.total);
  const last = breakdown(value.last);
  if (
    !total ||
    !last ||
    (value.modelContextWindow !== null && !isNumber(value.modelContextWindow))
  )
    return undefined;
  return { total, last, modelContextWindow: value.modelContextWindow };
}

function parseTurn(value: unknown): Turn | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isTurnStatus(value.status)
  )
    return undefined;
  const error = value.error === null ? null : parseTurnError(value.error);
  const nullableNumber = (candidate: unknown): candidate is number | null =>
    candidate === null || isNumber(candidate);
  if (
    (value.error !== null && !error) ||
    !Array.isArray(value.items) ||
    !nullableNumber(value.startedAt) ||
    !nullableNumber(value.completedAt) ||
    !nullableNumber(value.durationMs)
  )
    return undefined;
  const items = value.items.map(parseThreadItem);
  if (items.some((item) => item === undefined)) return undefined;
  return {
    id: value.id,
    items: items as ThreadItem[],
    status: value.status,
    error: error ?? null,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    durationMs: value.durationMs,
  };
}

function parseNotification(value: unknown): CodexAppServerEvent | undefined {
  if (
    !isRecord(value) ||
    typeof value.method !== "string" ||
    !isNumber(value.emittedAtMs)
  )
    return undefined;
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
        emittedAtMs: value.emittedAtMs,
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
      emittedAtMs: value.emittedAtMs,
    };
  }
  if (
    value.method === "item/agentMessage/delta" &&
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
      emittedAtMs: value.emittedAtMs,
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
      emittedAtMs: value.emittedAtMs,
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
          emittedAtMs: value.emittedAtMs,
        }
      : undefined;
  }
  if (value.method === "turn/completed") {
    const turn = parseTurn(params.turn);
    return turn
      ? {
          method: value.method,
          params: { threadId, turn },
          emittedAtMs: value.emittedAtMs,
        }
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
          emittedAtMs: value.emittedAtMs,
        }
      : undefined;
  }
  return undefined;
}

/** Keep provider identity out of the persisted stderr post-mortem. */
function redactProviderIds(value: string): string {
  return value.replace(
    /"(threadId|turnId|itemId|sessionId|id)"\s*:\s*("[^"]*"|-?\d+)/g,
    '"$1":"[redacted]"',
  );
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

/** Build one disposable Codex App Server conversation over stdio. */
export function createCodexAppServerSource(
  options: CodexAppServerOptions,
): OneShotSource<CodexAppServerEvent> {
  const {
    cwd,
    childDepth,
    prompt,
    spawn = defaultSpawn,
    killEscalationMs = DEFAULT_KILL_ESCALATION_MS,
  } = options;
  return async (sink, signal) => {
    if (signal.aborted) return { status: "clean" };
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn("codex", ["app-server"], spawnOptions(cwd, childDepth));
      } catch (error) {
        reject(error);
        return;
      }
      if (!proc.stdin || !proc.stdout || !proc.stderr) {
        try {
          let earlyClosed = false;
          let escalation: ReturnType<typeof setTimeout> | undefined;
          const onEarlyClose = (): void => {
            earlyClosed = true;
            if (escalation !== undefined) clearTimeout(escalation);
          };
          proc.once("close", onEarlyClose);
          proc.stdin?.end();
          proc.kill("SIGTERM");
          if (!earlyClosed) {
            escalation = setTimeout(() => {
              proc.removeListener("close", onEarlyClose);
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
        reject(new Error("Failed to open Codex App Server stdio pipes"));
        return;
      }

      let nextId = 1;
      let threadId: string | undefined;
      let turnId: string | undefined;
      let settled = false;
      let childClosed = false;
      let aborted = signal.aborted;
      let sawStderr = false;
      let sawTerminalAnswer = false;
      let rawStdoutTail = "";
      let lineBuffer = "";
      let droppingLine = false;
      let stdinEnded = false;
      let terminationStarted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pendingNotifications: CodexAppServerEvent[] = [];
      const pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();

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
      const rejectPending = (error: Error): void => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      };
      const finishCleanup = (): void => {
        clearTimer();
        signal.removeEventListener("abort", onAbort);
        detachStreams();
        detachProcess();
        rejectPending(new Error("Codex App Server transport closed"));
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
      const resolveAfterKill = (): void => {
        if (settled) return;
        settled = true;
        finishCleanup();
        resolve({ status: "clean" });
      };
      const scheduleKill = (stage: "SIGTERM" | "SIGKILL"): void => {
        clearTimer();
        timer = setTimeout(() => {
          timer = undefined;
          if (childClosed) return;
          kill(stage);
          if (stage === "SIGTERM") scheduleKill("SIGKILL");
          else if (settled) finishCleanup();
          else resolveAfterKill();
        }, killEscalationMs);
        timer.unref?.();
      };
      const beginTermination = (interrupt: boolean): void => {
        if (childClosed || terminationStarted) return;
        terminationStarted = true;
        const terminationMode =
          interrupt && threadId && turnId ? "interrupt" : "kill";
        if (terminationMode === "interrupt") {
          try {
            sendRequest("turn/interrupt", { threadId, turnId }).catch(() => {});
          } catch {
            // Escalation remains the fallback if the request cannot be sent.
          }
          if (settled) return;
          endStdin();
          scheduleKill("SIGTERM");
        } else {
          endStdin();
          kill("SIGTERM");
          scheduleKill("SIGKILL");
        }
      };
      const finish = (
        conclusion:
          | { status: "clean" }
          | { status: "failed"; errorMessage?: string },
        terminate: boolean,
      ): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        detachStreams();
        if (terminate) beginTermination(false);
        else {
          endStdin();
          clearTimer();
          detachProcess();
          rejectPending(new Error("Codex App Server transport settled"));
        }
        resolve(conclusion);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        detachStreams();
        beginTermination(false);
        reject(error);
      };
      const write = (value: JsonObject): void => {
        if (settled) return;
        proc.stdin?.write(`${JSON.stringify(value)}\n`, "utf8");
      };
      const sendNotification = (method: string, params?: JsonObject): void => {
        const value: JsonObject = { method };
        if (params) value.params = params;
        write(value);
      };
      function sendRequest(
        method: string,
        params: JsonObject,
      ): Promise<unknown> {
        const id = nextId++;
        const response = new Promise<unknown>(
          (requestResolve, requestReject) => {
            pending.set(id, { resolve: requestResolve, reject: requestReject });
          },
        );
        try {
          write({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          pending.delete(id);
          throw error;
        }
        return response;
      }
      const responseError = (value: unknown): string | undefined =>
        isRecord(value) && typeof value.message === "string"
          ? value.message
          : undefined;
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
          request.reject(
            new Error(
              responseError(value.error) ?? "Codex App Server request failed",
            ),
          );
        } else request.resolve(value.result);
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
        try {
          sawStderr = true;
          sink.stderr(
            `Codex App Server requested unsupported method '${value.method}'\n`,
          );
        } catch (error) {
          fail(error);
        }
      };
      const forwardNotification = (notification: CodexAppServerEvent): void => {
        if (settled) return;
        if (
          notification.method === "turn/completed" &&
          notification.params.turn.id !== turnId
        )
          return;
        if (
          "turnId" in notification.params &&
          notification.params.turnId !== turnId
        )
          return;
        try {
          if (sink.event(notification) === true) sawTerminalAnswer = true;
          if (notification.method === "turn/completed")
            finish({ status: "clean" }, !aborted);
        } catch (error) {
          fail(error);
        }
      };
      const processLine = (line: string): void => {
        if (!line.trim()) return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(value)) return;
        if (typeof value.method === "string") {
          if ("id" in value) handleServerRequest(value);
          else {
            const notification = parseNotification(value);
            if (
              !notification ||
              !threadId ||
              notification.params.threadId !== threadId
            )
              return;
            if (!turnId) {
              pendingNotifications.push(notification);
              return;
            }
            forwardNotification(notification);
          }
        } else handleResponse(value);
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
            if (settled) return;
          }
        }
      };
      function onStdoutData(data: Buffer | string): void {
        try {
          processChunk(data);
        } catch (error) {
          fail(error);
        }
      }
      function onStderrData(data: Buffer | string): void {
        sawStderr = true;
        try {
          sink.stderr(data.toString());
        } catch (error) {
          fail(error);
        }
      }
      function onStdinError(error: Error): void {
        sawStderr = true;
        try {
          sink.stderr(`stdin: ${error.message}\n`);
        } catch (sinkError) {
          fail(sinkError);
        }
      }
      function onProcessError(error: Error): void {
        if (settled) return;
        sawStderr = true;
        try {
          sink.stderr(`${error.message}\n`);
        } catch (sinkError) {
          fail(sinkError);
          return;
        }
        finish({ status: "failed" }, true);
      }
      function onClose(code: number | null): void {
        childClosed = true;
        clearTimer();
        rejectPending(new Error("Codex App Server exited before its response"));
        if (settled) {
          finishCleanup();
          return;
        }
        try {
          if (lineBuffer.length > 0 && lineBuffer.length <= STDOUT_LINE_LIMIT)
            processLine(lineBuffer);
          lineBuffer = "";
          if (settled) return;
          if (aborted) finish({ status: "clean" }, false);
          else if (code === 0) {
            if (!sawStderr && !sawTerminalAnswer) {
              const tail = redactProviderIds(rawStdoutTail.trim());
              sink.stderr(
                tail ? `Last stdout:\n${tail}` : "No stdout was captured.\n",
              );
            }
            finish({ status: "clean" }, false);
          } else {
            if (!sawStderr && !sawTerminalAnswer && rawStdoutTail.trim()) {
              sink.stderr(
                `Last stdout:\n${redactProviderIds(rawStdoutTail.trim())}`,
              );
            }
            finish(
              {
                status: "failed",
                errorMessage: `Child codex exited with code ${code ?? "unknown"}`,
              },
              false,
            );
          }
        } catch (error) {
          fail(error);
        }
      }
      const onAbort = (): void => {
        if (settled) return;
        aborted = true;
        beginTermination(Boolean(threadId && turnId));
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);
      proc.stdin.on("error", onStdinError);
      proc.on("error", onProcessError);
      proc.on("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });

      const start = async (): Promise<void> => {
        try {
          const initialize = await sendRequest(
            "initialize",
            initializeParams(),
          );
          if (!isInitializeResponse(initialize))
            throw new Error(
              "Codex App Server returned an invalid initialize response",
            );
          if (settled || signal.aborted) return;
          sendNotification("initialized");
          const thread = await sendRequest(
            "thread/start",
            threadStartParams(options),
          );
          if (
            !isRecord(thread) ||
            !isRecord(thread.thread) ||
            typeof thread.thread.id !== "string"
          )
            throw new Error(
              "Codex App Server returned an invalid thread/start response",
            );
          threadId = thread.thread.id;
          if (settled || signal.aborted) return;
          const turn = await sendRequest(
            "turn/start",
            turnStartParams(threadId, prompt),
          );
          if (
            !isRecord(turn) ||
            !isRecord(turn.turn) ||
            typeof turn.turn.id !== "string"
          )
            throw new Error(
              "Codex App Server returned an invalid turn/start response",
            );
          turnId = turn.turn.id;
          for (const notification of pendingNotifications.splice(0))
            forwardNotification(notification);
          if (signal.aborted) beginTermination(true);
        } catch (error) {
          if (!settled)
            finish(
              {
                status: "failed",
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
              true,
            );
        }
      };
      if (signal.aborted) onAbort();
      else void start();
    });
  };
}
