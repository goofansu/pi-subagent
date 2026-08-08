/**
 * Codex backend — runs one agent through `codex app-server --stdio`.
 *
 * App server is used instead of `codex exec --json` because its protocol has
 * first-class fields for base/developer instructions, reasoning effort,
 * approvals, sandboxing, and ephemeral threads. That keeps profile fields
 * out of shell arguments and lets the existing subagent UI receive structured
 * tool calls and progress.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  SubagentBackend,
  SubagentRunContext,
  SubagentTask,
} from "../backend.ts";
import { appendStderr, DEPTH_ENV_KEY, settleAborted } from "../backend.ts";
import type { AgentConfig, Effort, SingleResult } from "../types.ts";
import { resolveAppendSystemPrompt } from "../types.ts";

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

interface AppServerMessage extends JsonObject {
  id?: RequestId;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (result: JsonObject) => void;
  reject: (cause: Error) => void;
}

interface CodexItem extends JsonObject {
  type: string;
  id: string;
}

interface CodexTranslationState {
  assistantMessages: Map<string, AssistantMessage>;
  toolCalls: Set<string>;
  toolResults: Set<string>;
  sawUsage: boolean;
}

export interface CodexInheritedIntegrations {
  mcpServers: string[];
  apps: string[];
}

/** `off` is named `none` by Codex; the rest of the neutral scale is native. */
export function resolveCodexEffort(
  effort: Effort | undefined,
): string | undefined {
  return effort === "off" ? "none" : effort;
}

export function resolveCodexModel(config: AgentConfig): string | undefined {
  return config.model;
}

function tomlString(value: string): string {
  // JSON strings are valid TOML basic strings for the path/value shapes here.
  return JSON.stringify(value);
}

/**
 * Arguments that make a headless Codex run safe to delegate to.
 *
 * Multi-agent is disabled at feature registration time rather than merely
 * discouraged in the prompt, so Codex cannot hide another generation of
 * delegation below the extension's one-level nesting guard.
 *
 * Pi's trust decision is authoritative. For an untrusted checkout, hooks,
 * plugins, and apps are disabled before the project is loaded. MCP servers and
 * app entries are disabled individually in the thread config after reading the
 * effective config, because an empty table is only a merge overlay in Codex.
 */
export function buildCodexAppServerArgs(task: SubagentTask): string[] {
  const trust = task.projectTrusted ? "trusted" : "untrusted";
  const args = [
    "app-server",
    "--stdio",
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "-c",
    `projects.${tomlString(task.cwd)}.trust_level=${tomlString(trust)}`,
  ];
  if (!task.projectTrusted) {
    args.push(
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "--disable",
      "apps",
    );
  }
  return args;
}

export function getCodexSpawnOptions(task: SubagentTask): SpawnOptions {
  return {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: task.cwd,
    env: {
      ...process.env,
      [DEPTH_ENV_KEY]: String(task.depth + 1),
    },
  };
}

export interface CodexThreadStartParams extends JsonObject {
  model?: string;
  cwd?: string;
  approvalPolicy: "never";
  sandbox: "danger-full-access";
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral: true;
  config: JsonObject;
}

export function buildCodexThreadStartParams(
  task: SubagentTask,
  inherited: CodexInheritedIntegrations = { mcpServers: [], apps: [] },
): CodexThreadStartParams {
  const params: CodexThreadStartParams = {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ephemeral: true,
    // Defense in depth for versions that read feature values from thread
    // config after process startup.
    config: task.projectTrusted
      ? { features: { multi_agent: false, multi_agent_v2: false } }
      : {
          features: {
            multi_agent: false,
            multi_agent_v2: false,
            hooks: false,
            plugins: false,
            apps: false,
          },
          mcp_servers: Object.fromEntries(
            inherited.mcpServers.map((name) => [name, { enabled: false }]),
          ),
          apps: Object.fromEntries(
            inherited.apps.map((name) => [name, { enabled: false }]),
          ),
        },
  };
  // App server persists an explicitly supplied cwd as trusted when paired with
  // workspace-write or full access. The child process already starts in this
  // directory, so omitting cwd preserves the runtime cwd without mutating the
  // user's trust config for an untrusted task.
  if (task.projectTrusted) params.cwd = task.cwd;
  const model = resolveCodexModel(task.config);
  if (model) params.model = model;
  if (resolveAppendSystemPrompt(task.config)) {
    params.developerInstructions = task.config.systemPrompt;
  } else {
    params.baseInstructions = task.config.systemPrompt;
  }
  return params;
}

function integrationNames(
  value: unknown,
  key: "mcp_servers" | "apps",
): string[] {
  return Object.keys(asObject(asObject(value)[key]));
}

/**
 * Collect inherited integration names from the effective config only.
 * Layer-only entries may be disabled or shadowed; emitting a name-only
 * `{ enabled: false }` overlay for one can fail Codex's transport validation.
 */
export function collectCodexInheritedIntegrations(
  configReadResult: JsonObject,
): CodexInheritedIntegrations {
  const config = configReadResult.config;
  return {
    mcpServers: integrationNames(config, "mcp_servers").sort(),
    apps: integrationNames(config, "apps").sort(),
  };
}

export function buildCodexTurnStartParams(
  threadId: string,
  task: SubagentTask,
): JsonObject {
  const params: JsonObject = {
    threadId,
    input: [{ type: "text", text: task.prompt, text_elements: [] }],
  };
  const effort = resolveCodexEffort(task.config.effort);
  if (effort) params.effort = effort;
  return params;
}

function emptyAssistantUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistantMessage(
  result: SingleResult,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: result.model ?? "codex",
    usage: emptyAssistantUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function itemTool(item: CodexItem): {
  name: string;
  args: JsonObject;
  output: string;
  isError: boolean;
} | null {
  switch (item.type) {
    case "commandExecution": {
      const status = asString(item.status);
      const exitCode =
        typeof item.exitCode === "number" ? item.exitCode : undefined;
      return {
        name: "bash",
        args: {
          command: asString(item.command) ?? "",
          cwd: asString(item.cwd) ?? "",
        },
        output:
          asString(item.aggregatedOutput) ??
          (exitCode === undefined ? (status ?? "") : `Exit code: ${exitCode}`),
        isError:
          status === "failed" ||
          status === "declined" ||
          (exitCode !== undefined && exitCode !== 0),
      };
    }
    case "fileChange": {
      const status = asString(item.status);
      return {
        name: "apply_patch",
        args: { changes: item.changes ?? [] },
        output: status ? `File changes: ${status}` : "File changes completed",
        isError: status === "failed" || status === "declined",
      };
    }
    case "mcpToolCall": {
      const server = asString(item.server) ?? "mcp";
      const tool = asString(item.tool) ?? "tool";
      const error = item.error;
      return {
        name: `${server}/${tool}`,
        args: asObject(item.arguments),
        output: error ? stringify(error) : stringify(item.result),
        isError: Boolean(error) || item.status === "failed",
      };
    }
    case "dynamicToolCall": {
      const namespace = asString(item.namespace);
      const tool = asString(item.tool) ?? "tool";
      return {
        name: namespace ? `${namespace}/${tool}` : tool,
        args: asObject(item.arguments),
        output: stringify(item.contentItems),
        isError: item.success === false || item.status === "failed",
      };
    }
    case "webSearch":
      return {
        name: "web_search",
        args: { query: asString(item.query) ?? "" },
        output: `Search completed: ${asString(item.query) ?? ""}`,
        isError: false,
      };
    case "imageView":
      return {
        name: "view_image",
        args: { path: asString(item.path) ?? "" },
        output: "Image viewed",
        isError: false,
      };
    case "imageGeneration":
      return {
        name: "image_generation",
        args: {},
        output: stringify(item.result),
        isError: item.status === "failed",
      };
    case "sleep":
      return {
        name: "sleep",
        args: { durationMs: item.durationMs },
        output: "Sleep completed",
        isError: false,
      };
    default:
      return null;
  }
}

function ensureToolCall(
  item: CodexItem,
  result: SingleResult,
  state: CodexTranslationState,
): boolean {
  const tool = itemTool(item);
  if (!tool || state.toolCalls.has(item.id)) return false;
  state.toolCalls.add(item.id);
  result.messages.push(
    createAssistantMessage(result, [
      {
        type: "toolCall",
        id: item.id,
        name: tool.name,
        arguments: tool.args,
      },
    ]),
  );
  return true;
}

function completeTool(
  item: CodexItem,
  result: SingleResult,
  state: CodexTranslationState,
): boolean {
  const tool = itemTool(item);
  if (!tool || state.toolResults.has(item.id)) return false;
  ensureToolCall(item, result, state);
  state.toolResults.add(item.id);
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: item.id,
    toolName: tool.name,
    content: [{ type: "text", text: tool.output }],
    isError: tool.isError,
    timestamp: Date.now(),
  };
  result.messages.push(message);
  return true;
}

function applyAgentDelta(
  params: JsonObject,
  result: SingleResult,
  state: CodexTranslationState,
): boolean {
  const itemId = asString(params.itemId);
  const delta = asString(params.delta);
  if (!itemId || delta === undefined) return false;
  let message = state.assistantMessages.get(itemId);
  if (!message) {
    message = createAssistantMessage(result, [{ type: "text", text: "" }]);
    state.assistantMessages.set(itemId, message);
    result.messages.push(message);
  }
  const block = message.content[0];
  if (block?.type === "text") block.text += delta;
  return true;
}

function applyCompletedItem(
  item: CodexItem,
  result: SingleResult,
  state: CodexTranslationState,
): boolean {
  if (item.type === "agentMessage") {
    const text = asString(item.text) ?? "";
    const existing = state.assistantMessages.get(item.id);
    if (existing) {
      existing.content = [{ type: "text", text }];
    } else {
      const message = createAssistantMessage(result, [{ type: "text", text }]);
      state.assistantMessages.set(item.id, message);
      result.messages.push(message);
    }
    return true;
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string")
      : [];
    const content = Array.isArray(item.content)
      ? item.content.filter((part): part is string => typeof part === "string")
      : [];
    const thinking = [...summary, ...content].join("\n");
    if (!thinking) return false;
    result.messages.push(
      createAssistantMessage(result, [{ type: "thinking", thinking }]),
    );
    return true;
  }
  return completeTool(item, result, state);
}

function applyTokenUsage(
  params: JsonObject,
  result: SingleResult,
  state: CodexTranslationState,
): boolean {
  const tokenUsage = asObject(params.tokenUsage);
  const total = asObject(tokenUsage.total);
  const last = asObject(tokenUsage.last);
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  result.usage.input = number(total.inputTokens);
  result.usage.output = number(total.outputTokens);
  result.usage.cacheRead = number(total.cachedInputTokens);
  result.usage.cacheWrite = 0;
  result.usage.contextTokens = number(last.totalTokens);
  state.sawUsage = true;
  return true;
}

export function createCodexTranslationState(): CodexTranslationState {
  return {
    assistantMessages: new Map(),
    toolCalls: new Set(),
    toolResults: new Set(),
    sawUsage: false,
  };
}

/** Fold one app-server notification into the shared result shape. */
export function applyCodexNotification(
  message: AppServerMessage,
  result: SingleResult,
  state: CodexTranslationState,
): boolean {
  const params = message.params ?? {};
  switch (message.method) {
    case "turn/started":
      result.usage.turns = Math.max(result.usage.turns, 1);
      return true;
    case "thread/tokenUsage/updated":
      return applyTokenUsage(params, result, state);
    case "item/agentMessage/delta":
      return applyAgentDelta(params, result, state);
    case "item/started": {
      const item = params.item as CodexItem | undefined;
      return item ? ensureToolCall(item, result, state) : false;
    }
    case "item/completed": {
      const item = params.item as CodexItem | undefined;
      return item ? applyCompletedItem(item, result, state) : false;
    }
    case "warning": {
      const warning = asString(params.message);
      if (!warning) return false;
      result.stderr = appendStderr(
        result.stderr,
        `Codex warning: ${warning}\n`,
      );
      return true;
    }
    case "error": {
      const error = asObject(params.error);
      const text = asString(error.message);
      if (text && params.willRetry !== true) {
        result.errorMessage = text;
        result.stopReason = "error";
      }
      return Boolean(text);
    }
    case "turn/completed": {
      const turn = asObject(params.turn);
      const status = asString(turn.status);
      if (status === "completed") {
        result.exitCode = 0;
        result.stopReason = "stop";
      } else {
        result.exitCode = 1;
        result.stopReason = status === "interrupted" ? "aborted" : "error";
        const error = asObject(turn.error);
        result.errorMessage ??=
          asString(error.message) ??
          `Codex turn ${status ?? "ended without a status"}`;
      }
      return true;
    }
    default:
      return false;
  }
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the Codex executable from PATH without starting a process. */
export function findCodexExecutable(
  envPath: string = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const extensions =
    platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of envPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(
        directory,
        platform === "win32" ? `codex${extension.toLowerCase()}` : "codex",
      );
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

const REQUIRED_CODEX_FEATURES = ["multi_agent", "multi_agent_v2"] as const;

interface CodexProbeResult {
  ok: boolean;
  stdout: string;
}

function runCodexProbe(
  executable: string,
  args: string[],
  spawnProcess: typeof spawn,
): Promise<CodexProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout });
    };

    try {
      const proc = spawnProcess(executable, args, {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.once("error", () => settle(false));
      proc.once("close", (code) => settle(code === 0));
    } catch {
      settle(false);
    }
  });
}

export function codexFeatureListSupportsBackend(output: string): boolean {
  const features = new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 1)[0])
      .filter(Boolean),
  );
  return REQUIRED_CODEX_FEATURES.every((feature) => features.has(feature));
}

/**
 * Confirm that the installed CLI exposes app server and every feature gate the
 * backend must disable. `app-server --help` alone accepts unknown feature names,
 * so it cannot establish compatibility with the arguments used for real runs.
 */
export async function hasCodexAppServer(
  executable: string | undefined = findCodexExecutable(),
  spawnProcess: typeof spawn = spawn,
): Promise<boolean> {
  if (!executable) return false;
  const appServer = await runCodexProbe(
    executable,
    ["app-server", "--help"],
    spawnProcess,
  );
  if (!appServer.ok) return false;
  const features = await runCodexProbe(
    executable,
    ["features", "list"],
    spawnProcess,
  );
  return features.ok && codexFeatureListSupportsBackend(features.stdout);
}

function respondToServerRequest(
  message: AppServerMessage,
  write: (message: AppServerMessage) => void,
): void {
  if (message.id === undefined || !message.method) return;
  switch (message.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      write({ id: message.id, result: { decision: "decline" } });
      return;
    case "item/tool/requestUserInput":
      write({ id: message.id, result: { answers: {} } });
      return;
    case "mcpServer/elicitation/request":
      write({
        id: message.id,
        result: { action: "cancel", content: null, _meta: null },
      });
      return;
    case "currentTime/read":
      write({
        id: message.id,
        result: { currentTimeAt: Math.floor(Date.now() / 1000) },
      });
      return;
    default:
      write({
        id: message.id,
        error: {
          code: -32601,
          message: `pi-subagent does not implement '${message.method}'`,
        },
      });
  }
}

export async function runCodexAgent(
  ctx: SubagentRunContext,
  spawnProcess: typeof spawn = spawn,
  executable: string = findCodexExecutable() ?? "codex",
): Promise<SingleResult> {
  const { task, result, emit, signal } = ctx;
  if (signal?.aborted) {
    settleAborted(result);
    return result;
  }

  const proc = spawnProcess(
    executable,
    buildCodexAppServerArgs(task),
    getCodexSpawnOptions(task),
  );
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = "Failed to open Codex app-server stdio pipes";
    proc.kill("SIGTERM");
    return result;
  }
  const stdin = proc.stdin;
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  const pending = new Map<RequestId, PendingRequest>();
  const state = createCodexTranslationState();
  let nextId = 1;
  let buffer = "";
  let turnId: string | undefined;
  let threadId: string | undefined;
  let wasAborted = false;
  let finished = false;
  let completionFailure: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  let finishTurn!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });

  const write = (message: AppServerMessage) => {
    if (!stdin.writable) {
      throw new Error("Codex app server stdin closed");
    }
    stdin.write(`${JSON.stringify(message)}\n`, (cause) => {
      if (cause) rejectOutstanding(cause);
    });
  };

  // Progress callbacks belong to the host UI and must not be able to strand
  // the child turn if a renderer or embedder throws.
  const publish = () => {
    try {
      emit();
    } catch (cause) {
      result.stderr = appendStderr(
        result.stderr,
        `Codex progress callback failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }\n`,
      );
    }
  };

  const request = (method: string, params: JsonObject) => {
    const id = nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        write({ id, method, params });
      } catch (cause) {
        pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  };

  const rejectOutstanding = (cause: Error) => {
    for (const entry of pending.values()) entry.reject(cause);
    pending.clear();
    if (!finished) {
      finished = true;
      completionFailure = cause;
      finishTurn();
    }
  };
  stdin.on("error", (cause) => rejectOutstanding(cause));

  const processMessage = (message: AppServerMessage) => {
    if (message.id !== undefined && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) {
        entry.reject(
          new Error(
            message.error.message ??
              `Codex request ${message.id} failed without a message`,
          ),
        );
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      respondToServerRequest(message, write);
      return;
    }
    if (applyCodexNotification(message, result, state)) publish();
    if (message.method === "turn/completed") {
      const params = message.params ?? {};
      const completedTurn = asObject(params.turn);
      if (!turnId || asString(completedTurn.id) === turnId) {
        finished = true;
        finishTurn();
      }
    }
  };

  stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        processMessage(JSON.parse(line) as AppServerMessage);
      } catch (cause) {
        result.stderr = appendStderr(
          result.stderr,
          `Invalid Codex app-server message: ${
            cause instanceof Error ? cause.message : String(cause)
          }\n`,
        );
      }
    }
  });
  stderr.on("data", (data) => {
    result.stderr = appendStderr(result.stderr, data.toString());
  });
  proc.on("error", (cause) => rejectOutstanding(cause));
  proc.on("close", (code) => {
    if (buffer.trim()) {
      try {
        processMessage(JSON.parse(buffer) as AppServerMessage);
      } catch {
        /* stderr and the exit diagnostic below are more useful */
      }
    }
    rejectOutstanding(
      new Error(
        `Codex app server exited with code ${code ?? "unknown"} before the turn completed`,
      ),
    );
  });

  const abort = () => {
    if (finished) return;
    wasAborted = true;
    if (threadId && turnId && stdin.writable) {
      void request("turn/interrupt", { threadId, turnId }).catch(() => {});
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
    } else {
      proc.kill("SIGTERM");
    }
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const initialized = await request("initialize", {
      clientInfo: {
        name: "pi-subagent",
        title: "Pi Subagent",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    void initialized;
    write({ method: "initialized" });

    const inherited = task.projectTrusted
      ? { mcpServers: [], apps: [] }
      : collectCodexInheritedIntegrations(
          await request("config/read", {
            cwd: task.cwd,
            includeLayers: false,
          }),
        );
    const started = await request(
      "thread/start",
      buildCodexThreadStartParams(task, inherited),
    );
    const thread = asObject(started.thread);
    threadId = asString(thread.id);
    if (!threadId) throw new Error("Codex thread/start returned no thread id");
    result.model =
      asString(started.model) ?? resolveCodexModel(task.config) ?? "codex";
    publish();

    const turnStarted = await request(
      "turn/start",
      buildCodexTurnStartParams(threadId, task),
    );
    turnId = asString(asObject(turnStarted.turn).id);
    if (!turnId) throw new Error("Codex turn/start returned no turn id");
    result.usage.turns = Math.max(result.usage.turns, 1);
    await turnFinished;
    if (completionFailure) throw completionFailure;
  } catch (cause) {
    if (!wasAborted) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage =
        cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    if (!proc.killed) proc.kill("SIGTERM");
  }

  if (wasAborted) settleAborted(result);
  if (result.exitCode !== 0 && !state.sawUsage) {
    result.usage.outputUnreported = true;
  }
  return result;
}

export const codexBackend: SubagentBackend = {
  name: "codex",
  isAvailable: hasCodexAppServer,
  run: runCodexAgent,
};
