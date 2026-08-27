import type { SpawnOptions } from "node:child_process";
import { type ChildProcess, spawn as defaultSpawn } from "node:child_process";
import type { ChildProcessSpawn } from "./child-process.ts";
import type { OneShotSource } from "./one-shot.ts";
import { DEPTH_ENV_KEY } from "./run.ts";

const DEFAULT_KILL_ESCALATION_MS = 5_000;
const STDOUT_LINE_LIMIT = 32 * 1024 * 1024;
const RAW_STDOUT_TAIL_LIMIT = 2_000;
const OVERSIZED_LINE_MESSAGE =
  "[... oversized stdout line dropped; resyncing at the next newline ...]\n";

export interface AppServerClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface CodexAppServerOptions {
  cwd: string;
  childDepth: number;
  prompt: string;
  model?: string;
  effort?: string;
  spawn?: ChildProcessSpawn;
  killEscalationMs?: number;
  clientInfo?: AppServerClientInfo;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PinnedEvent {
  method:
    | "item/started"
    | "item/completed"
    | "item/agentMessage/delta"
    | "item/reasoning/summaryTextDelta"
    | "thread/tokenUsage/updated"
    | "turn/completed"
    | "error";
  params: Record<string, unknown>;
}

export type CodexAppServerEvent = PinnedEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function hasStrings(
  value: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

function isTokenBreakdown(value: unknown): boolean {
  return (
    isRecord(value) &&
    [
      "totalTokens",
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
    ].every((key) => typeof value[key] === "number")
  );
}

function isPinnedEvent(value: unknown): value is PinnedEvent {
  if (!isRecord(value) || typeof value.method !== "string") return false;
  const params = value.params;
  if (!isRecord(params)) return false;
  if (value.method === "item/started" || value.method === "item/completed") {
    return (
      hasStrings(params, "threadId", "turnId") &&
      isRecord(params.item) &&
      typeof params.item.type === "string"
    );
  }
  if (value.method === "item/agentMessage/delta") {
    return hasStrings(params, "threadId", "turnId", "itemId", "delta");
  }
  if (value.method === "item/reasoning/summaryTextDelta") {
    return (
      hasStrings(params, "threadId", "turnId", "itemId", "delta") &&
      typeof params.summaryIndex === "number"
    );
  }
  if (value.method === "thread/tokenUsage/updated") {
    return (
      hasStrings(params, "threadId", "turnId") &&
      isRecord(params.tokenUsage) &&
      isTokenBreakdown(params.tokenUsage.total) &&
      isTokenBreakdown(params.tokenUsage.last)
    );
  }
  if (value.method === "turn/completed") {
    return (
      hasStrings(params, "threadId") &&
      isRecord(params.turn) &&
      hasStrings(params.turn, "id", "status")
    );
  }
  if (value.method === "error") {
    return (
      hasStrings(params, "threadId", "turnId") &&
      typeof params.willRetry === "boolean" &&
      isRecord(params.error) &&
      typeof params.error.message === "string"
    );
  }
  return false;
}

function spawnOptions(cwd: string, childDepth: number): SpawnOptions {
  return {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, [DEPTH_ENV_KEY]: String(childDepth) },
  };
}

interface LineParser {
  (chunk: string): void;
  flush(): void;
}

function lineParser(
  onLine: (line: string) => void,
  onOversized: () => void,
): LineParser {
  let buffer = "";
  let dropping = false;
  const parse = ((chunk: string): void => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (dropping) {
        dropping = false;
      } else if (line.length <= STDOUT_LINE_LIMIT) {
        onLine(line);
      } else {
        onOversized();
      }
    }
    if (!dropping && buffer.length > STDOUT_LINE_LIMIT) {
      dropping = true;
      buffer = "";
      onOversized();
    }
  }) as LineParser;
  parse.flush = (): void => {
    if (dropping) return;
    const trailing = buffer;
    buffer = "";
    if (trailing.trim()) {
      if (trailing.length <= STDOUT_LINE_LIMIT) onLine(trailing);
      else onOversized();
    }
  };
  return parse;
}

function requestError(response: JsonRpcResponse): Error {
  return new Error(
    response.error?.message ??
      `Codex App Server rejected request ${response.id}`,
  );
}

/** App Server diagnostics cannot turn wire identities into run state. */
function redactProviderIds(value: string): string {
  return value.replace(
    /"(threadId|turnId|itemId|sessionId|id)"\s*:\s*("[^"]*"|-?\d+)/g,
    '"$1":"[redacted]"',
  );
}

/**
 * Run one disposable App Server conversation. JSON-RPC ids and provider ids
 * are consumed here and never enter the harness translator or run facts.
 */
export function createCodexAppServerSource(
  options: CodexAppServerOptions,
): OneShotSource<CodexAppServerEvent> {
  const {
    cwd,
    childDepth,
    prompt,
    model,
    effort,
    spawn = defaultSpawn,
    killEscalationMs = DEFAULT_KILL_ESCALATION_MS,
    clientInfo = {
      name: "pi-subagent",
      title: "pi-subagent",
      version: "1.0.0",
    },
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
        reject(new Error("Failed to open Codex App Server stdio pipes"));
        return;
      }

      let nextId = 1;
      let threadId: string | undefined;
      let turnId: string | undefined;
      let processClosed = false;
      let processError = false;
      let semanticallySettled = false;
      let aborted = signal.aborted;
      let sawTerminalAnswer = false;
      let sawStderr = false;
      let rawStdoutTail = "";
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let terminationRequested = false;
      const pending = new Map<
        string,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();

      const clearEscalation = (): void => {
        if (escalation !== undefined) {
          clearTimeout(escalation);
          escalation = undefined;
        }
      };
      const terminate = (immediate = true): void => {
        if (processClosed || terminationRequested) return;
        terminationRequested = true;
        const killTerm = (): void => {
          if (processClosed) return;
          try {
            proc.kill("SIGTERM");
          } catch {
            // The child can exit between the event and cleanup.
          }
          escalation = setTimeout(() => {
            escalation = undefined;
            if (!processClosed) {
              try {
                proc.kill("SIGKILL");
              } catch {
                // The process may have exited between escalation stages.
              }
            }
          }, killEscalationMs);
          escalation.unref?.();
        };
        if (immediate) killTerm();
        else {
          escalation = setTimeout(() => {
            escalation = undefined;
            killTerm();
          }, killEscalationMs);
          escalation.unref?.();
        }
      };
      const removeListeners = (keepClose = false): void => {
        signal.removeEventListener("abort", onAbort);
        proc.stdin?.removeListener("error", onStdinError);
        proc.stdout?.removeListener("data", onStdoutData);
        proc.stderr?.removeListener("data", onStderrData);
        proc.removeListener("error", onProcessError);
        if (!keepClose) proc.removeListener("close", onClose);
      };
      const cleanup = (kill: boolean): void => {
        clearEscalation();
        removeListeners();
        try {
          proc.stdin?.end();
        } catch {
          // Closing an already closed pipe is harmless cleanup.
        }
        if (kill) terminate();
      };
      const settle = (
        conclusion:
          | { status: "clean" }
          | { status: "failed"; errorMessage?: string },
        kill: boolean,
      ): void => {
        if (semanticallySettled) return;
        semanticallySettled = true;
        for (const waiter of pending.values())
          waiter.reject(new Error("Codex App Server source settled"));
        pending.clear();
        cleanup(kill);
        resolve(conclusion);
      };
      const fail = (error: unknown): void => {
        if (semanticallySettled) return;
        semanticallySettled = true;
        for (const waiter of pending.values())
          waiter.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        pending.clear();
        cleanup(true);
        reject(error);
      };
      const stdin = proc.stdin;
      const write = (value: unknown): void => {
        stdin.write(`${JSON.stringify(value)}\n`, "utf8");
      };
      const request = (method: string, params: unknown): Promise<unknown> => {
        const id = nextId++;
        return new Promise((resolveRequest, rejectRequest) => {
          pending.set(String(id), {
            resolve: resolveRequest,
            reject: rejectRequest,
          });
          try {
            write({ jsonrpc: "2.0", id, method, params });
          } catch (error) {
            pending.delete(String(id));
            rejectRequest(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        });
      };
      const earlyEvents: PinnedEvent[] = [];
      const forwardEvent = (value: PinnedEvent): void => {
        const params = value.params;
        if (params.threadId !== threadId) return;
        if (
          value.method !== "turn/completed" &&
          params.turnId !== undefined &&
          params.turnId !== turnId
        )
          return;
        try {
          if (sink.event(value)) sawTerminalAnswer = true;
          if (
            value.method === "turn/completed" &&
            isRecord(params.turn) &&
            params.turn.id === turnId
          ) {
            settle({ status: "clean" }, true);
          }
        } catch (error) {
          fail(error);
        }
      };
      const stdout = lineParser(
        (line) => {
          if (!line.trim()) return;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            return;
          }
          if (!isRecord(value)) return;
          if (isId(value.id) && ("result" in value || "error" in value)) {
            const waiter = pending.get(String(value.id));
            if (!waiter) return;
            pending.delete(String(value.id));
            const response = value as unknown as JsonRpcResponse;
            if (isRecord(response.error)) waiter.reject(requestError(response));
            else waiter.resolve(response.result);
            return;
          }
          if (typeof value.method === "string" && isId(value.id)) {
            // No approval request is expected under the fixed policy, but a
            // response prevents an accidental server-side deadlock.
            try {
              write({
                jsonrpc: "2.0",
                id: value.id,
                error: {
                  code: -32601,
                  message: "Method not supported by pi-subagent",
                },
              });
              sink.stderr(
                `Unsupported Codex App Server request: ${value.method}\n`,
              );
            } catch (error) {
              fail(error);
            }
            return;
          }
          if (isPinnedEvent(value)) {
            // A server may flush item events in the same turn as the
            // turn/start response. The response continuation has not assigned
            // turnId yet, so retain those events until it does.
            if (value.params.threadId === threadId && turnId === undefined)
              earlyEvents.push(value);
            else forwardEvent(value);
          }
        },
        () => {
          sawStderr = true;
          try {
            sink.stderr(OVERSIZED_LINE_MESSAGE);
          } catch (error) {
            fail(error);
          }
        },
      );
      const onStdoutData = (data: Buffer | string): void => {
        try {
          const chunk = data.toString();
          rawStdoutTail = `${rawStdoutTail}${chunk}`.slice(
            -RAW_STDOUT_TAIL_LIMIT,
          );
          stdout(chunk);
        } catch (error) {
          fail(error);
        }
      };
      const onStderrData = (data: Buffer | string): void => {
        sawStderr = true;
        try {
          sink.stderr(data.toString());
        } catch (error) {
          fail(error);
        }
      };
      const onStdinError = (error: Error): void => {
        sawStderr = true;
        try {
          sink.stderr(`stdin: ${error.message}\n`);
        } catch (sinkError) {
          fail(sinkError);
        }
      };
      const onProcessError = (error: Error): void => {
        if (semanticallySettled) return;
        processError = true;
        sawStderr = true;
        try {
          sink.stderr(`${error.message}\n`);
          settle({ status: "failed" }, true);
        } catch (sinkError) {
          fail(sinkError);
        }
      };
      const postMortem = (): void => {
        if (aborted || sawStderr || sawTerminalAnswer) return;
        const tail = redactProviderIds(rawStdoutTail.trim());
        try {
          sink.stderr(
            tail ? `Last stdout:\n${tail}` : "No stdout was captured.",
          );
        } catch (error) {
          fail(error);
        }
      };
      const onClose = (code: number | null): void => {
        processClosed = true;
        clearEscalation();
        try {
          stdout.flush();
        } catch (error) {
          fail(error);
          return;
        }
        if (semanticallySettled) {
          removeListeners();
          return;
        }
        try {
          if (processError) {
            settle({ status: "failed" }, false);
          } else if (code === 0) {
            postMortem();
            settle({ status: "clean" }, false);
          } else {
            postMortem();
            settle(
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
      };
      const onAbort = (): void => {
        if (semanticallySettled) return;
        aborted = true;
        if (threadId && turnId) {
          // Claim the escalation slot before writing: the fake and a real
          // server can answer synchronously while this callback is running.
          // A completed notification then clears the pending timer.
          terminate(false);
          request("turn/interrupt", { threadId, turnId }).catch(() => {});
        } else {
          terminate();
        }
      };

      proc.stdin.on("error", onStdinError);
      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);
      proc.on("error", onProcessError);
      proc.on("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      const protocol = async (): Promise<void> => {
        try {
          await request("initialize", { clientInfo, capabilities: null });
          if (semanticallySettled) return;
          write({ method: "initialized" });
          const threadParams: Record<string, unknown> = {
            cwd,
            ephemeral: true,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          };
          if (model !== undefined) threadParams.model = model;
          if (effort !== undefined)
            threadParams.config = { model_reasoning_effort: effort };
          const threadResult = await request("thread/start", threadParams);
          if (!isRecord(threadResult) || !isRecord(threadResult.thread))
            throw new Error("Codex App Server returned an invalid thread");
          if (typeof threadResult.thread.id !== "string")
            throw new Error("Codex App Server returned a thread without an id");
          threadId = threadResult.thread.id;
          const turnResult = await request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
          });
          if (
            !isRecord(turnResult) ||
            !isRecord(turnResult.turn) ||
            typeof turnResult.turn.id !== "string"
          )
            throw new Error("Codex App Server returned an invalid turn");
          turnId = turnResult.turn.id;
          for (const earlyEvent of earlyEvents.splice(0))
            forwardEvent(earlyEvent);
          if (aborted) onAbort();
        } catch (error) {
          if (!semanticallySettled) {
            if (aborted) settle({ status: "clean" }, true);
            else fail(error);
          }
        }
      };
      void protocol();
    });
  };
}

/** Short alias for callers that name sources rather than factories. */
export const codexAppServerSource = createCodexAppServerSource;
