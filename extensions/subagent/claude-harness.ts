import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Harness, HarnessDiagnostic, HarnessRun } from "./harness.ts";
import {
  booleanField,
  effortField,
  stringField,
  unknownFields,
} from "./harness.ts";
import type { Fact, FactPart, ParentModel, SubagentTask } from "./run.ts";
import { type AgentConfig, EFFORTS } from "./types.ts";

/** The complete accepted vocabulary: aliases resolve to their full id; full ids resolve to themselves. */
const CLAUDE_MODELS: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "claude-opus-4-0": "claude-opus-4-0",
  "claude-opus-4-20250514": "claude-opus-4-20250514",
  "claude-opus-4-1": "claude-opus-4-1",
  "claude-opus-4-1-20250805": "claude-opus-4-1-20250805",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-opus-4-5-20251101": "claude-opus-4-5-20251101",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-3-7": "claude-sonnet-3-7",
  "claude-sonnet-3-7-20250219": "claude-sonnet-3-7-20250219",
  "claude-sonnet-4-0": "claude-sonnet-4-0",
  "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-3-5": "claude-haiku-3-5",
  "claude-haiku-3-5-20241022": "claude-haiku-3-5-20241022",
  "claude-haiku-4-5": "claude-haiku-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
};
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 512,
  low: 1_024,
  medium: 4_096,
  high: 8_192,
  xhigh: 16_384,
  max: 32_768,
};

export type ClaudeQuery = (params: {
  prompt: string;
  options?: Options;
}) => Query;
export type ClaudeQueryLoader = () => Promise<ClaudeQuery>;

const loadClaudeQuery: ClaudeQueryLoader = async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentParts(content: unknown): FactPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: FactPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      parts.push({
        type: "tool_call",
        name: block.name,
        ...(isRecord(block.input) ? { arguments: block.input } : {}),
      });
    } else if (block.type === "tool_result") {
      const text = typeof block.content === "string" ? block.content : "";
      if (text) parts.push({ type: "text", text });
    }
  }
  return parts;
}

/** Translate one SDK wire object into domain facts; SDK objects stop here. */
export function translateClaudeMessage(message: SDKMessage): Fact[] {
  const wire = message as unknown as Record<string, unknown>;
  if (wire.type === "assistant" && isRecord(wire.message)) {
    const parts = contentParts(wire.message.content);
    if (parts.length === 0) return [];
    return [
      {
        role: "assistant",
        parts,
        // Claude reports total turns on its terminal result. Streamed
        // assistant messages are progress, not additional turns.
        usage: { turns: 0 },
        ...(typeof wire.message.model === "string"
          ? { model: wire.message.model }
          : {}),
      },
    ];
  }
  if (wire.type === "user" && isRecord(wire.message)) {
    const content = wire.message.content;
    const isToolResult =
      Array.isArray(content) &&
      content.some((block) => isRecord(block) && block.type === "tool_result");
    const parts = contentParts(content);
    return parts.length > 0
      ? [{ role: isToolResult ? "tool" : "user", parts }]
      : [];
  }
  if (wire.type !== "result") return [];

  const isError = wire.is_error === true;
  const resultParts =
    !isError && typeof wire.result === "string"
      ? contentParts(wire.result)
      : [];
  const modelUsage = isRecord(wire.modelUsage) ? wire.modelUsage : undefined;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const reportedCost =
    typeof wire.total_cost_usd === "number" ? wire.total_cost_usd : undefined;
  let cost = reportedCost ?? 0;
  const model = typeof wire.model === "string" ? wire.model : undefined;
  if (modelUsage) {
    for (const value of Object.values(modelUsage)) {
      if (!isRecord(value)) continue;
      input += typeof value.inputTokens === "number" ? value.inputTokens : 0;
      output += typeof value.outputTokens === "number" ? value.outputTokens : 0;
      cacheRead +=
        typeof value.cacheReadInputTokens === "number"
          ? value.cacheReadInputTokens
          : 0;
      cacheWrite +=
        typeof value.cacheCreationInputTokens === "number"
          ? value.cacheCreationInputTokens
          : 0;
      if (reportedCost === undefined && typeof value.costUSD === "number")
        cost += value.costUSD;
    }
  }
  const resultErrorText =
    isError && typeof wire.result === "string" && wire.result.trim()
      ? wire.result
      : undefined;
  const listedErrorText =
    isError && Array.isArray(wire.errors) && typeof wire.errors[0] === "string"
      ? wire.errors[0]
      : undefined;
  const errorMessage =
    resultErrorText ??
    listedErrorText ??
    (isError && typeof wire.subtype === "string"
      ? `Claude query reported an error (${wire.subtype})`
      : isError
        ? "Claude query reported an error"
        : undefined);
  return [
    {
      role: "assistant",
      parts: resultParts,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        cost,
        turns: typeof wire.num_turns === "number" ? wire.num_turns : 1,
      },
      ...(model ? { model } : {}),
      ...(typeof wire.stop_reason === "string"
        ? { stopReason: wire.stop_reason }
        : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
  ];
}

function isClaudeModel(value: string): boolean {
  const normalized = value.toLowerCase();
  return Object.hasOwn(CLAUDE_MODELS, normalized);
}

export function resolveClaudeModel(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const alias = value.toLowerCase();
  return Object.hasOwn(CLAUDE_MODELS, alias) ? CLAUDE_MODELS[alias] : value;
}

export function claudeThinking(
  effort: string | undefined,
): Options["thinking"] {
  if (!effort || effort === "off")
    return effort === "off" ? { type: "disabled" } : undefined;
  return {
    type: "enabled",
    budgetTokens: THINKING_BUDGETS[effort] ?? THINKING_BUDGETS.high,
  };
}

export function buildClaudeOptions(
  task: SubagentTask,
  model: string | undefined,
  effort: string | undefined,
  abortController: AbortController,
): Options {
  const tools = stringField(task.config, "tools", "profile")
    ?.split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const append =
    booleanField(task.config, "appendSystemPrompt", "profile") !== false;
  const options: Options = {
    cwd: task.cwd,
    model,
    abortController,
    thinking: claudeThinking(effort),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: ["Agent"],
    ...(tools ? { tools } : {}),
    systemPrompt: append
      ? {
          type: "preset",
          preset: "claude_code",
          append: task.config.systemPrompt,
        }
      : task.config.systemPrompt,
  };
  return options;
}

export function createClaudeHarness(
  loadQuery: ClaudeQueryLoader = loadClaudeQuery,
): Harness {
  return {
    name: "claude",
    validate(profile: AgentConfig, filePath: string): HarnessDiagnostic[] {
      const diagnostics: HarnessDiagnostic[] = [];
      for (const field of unknownFields(profile, [
        "model",
        "effort",
        "tools",
        "appendSystemPrompt",
      ])) {
        diagnostics.push({
          reason: `Claude harness does not recognize field '${field}'`,
        });
      }
      try {
        const model = stringField(profile, "model", filePath);
        effortField(profile, filePath, EFFORTS);
        stringField(profile, "tools", filePath);
        booleanField(profile, "appendSystemPrompt", filePath);
        if (model && !isClaudeModel(model))
          throw new Error(`invalid Claude model '${model}'`);
      } catch (error) {
        diagnostics.push({
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return diagnostics;
    },
    prepare(task: SubagentTask, _parentModel?: ParentModel): HarnessRun {
      const configuredModel = stringField(task.config, "model", "profile");
      const model = resolveClaudeModel(configuredModel);
      const effort = effortField(task.config, "profile", EFFORTS);
      return {
        model,
        effort,
        execute: async (run) => {
          const controller = new AbortController();
          let stream: Query | undefined;
          let streamEnded = false;
          let terminalResultReceived = false;
          let abortRequested = run.signal?.aborted ?? false;
          let errorMessage: string | undefined;
          const abort = () => {
            if (streamEnded) return;
            abortRequested = true;
            controller.abort();
            stream?.close();
          };
          if (run.signal?.aborted) controller.abort();
          else run.signal?.addEventListener("abort", abort, { once: true });
          try {
            const query = await loadQuery();
            const options = buildClaudeOptions(task, model, effort, controller);
            options.stderr = (data) => run.report.stderr(data);
            stream = query({ prompt: task.prompt, options });
            if (controller.signal.aborted) {
              stream.close();
              return { stopReason: "aborted" };
            }
            for await (const message of stream) {
              if ((message as { type?: string }).type === "result") {
                terminalResultReceived = true;
              }
              for (const fact of translateClaudeMessage(message)) {
                if (fact.errorMessage) errorMessage = fact.errorMessage;
                run.report.message(fact);
              }
            }
            streamEnded = true;
            if (abortRequested && !terminalResultReceived)
              return { stopReason: "aborted" };
            return errorMessage
              ? { exitCode: 1, stopReason: "error", errorMessage }
              : { exitCode: 0 };
          } catch (error) {
            if (terminalResultReceived) {
              return errorMessage
                ? { exitCode: 1, stopReason: "error", errorMessage }
                : { exitCode: 0 };
            }
            if (
              abortRequested ||
              controller.signal.aborted ||
              run.signal?.aborted
            )
              return { stopReason: "aborted" };
            const message =
              error instanceof Error ? error.message : String(error);
            return { exitCode: 1, stopReason: "error", errorMessage: message };
          } finally {
            run.signal?.removeEventListener("abort", abort);
          }
        },
      };
    },
  };
}
