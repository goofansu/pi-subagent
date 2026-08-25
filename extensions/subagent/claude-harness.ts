import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Harness,
  HarnessDiagnostic,
  HarnessRun,
  ParentModel,
} from "./harness.ts";
import { effortField, stringField, unknownFields } from "./harness.ts";
import type { Fact, FactPart, SubagentTask } from "./run.ts";
import type { AgentConfig } from "./types.ts";

const CLAUDE_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  fable: "claude-fable-5",
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
  if (typeof content === "string") return [{ type: "text", text: content }];
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

  const resultParts =
    typeof wire.result === "string" ? contentParts(wire.result) : [];
  const modelUsage = isRecord(wire.modelUsage) ? wire.modelUsage : undefined;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const reportedCost =
    typeof wire.total_cost_usd === "number" ? wire.total_cost_usd : undefined;
  let cost = reportedCost ?? 0;
  let model = typeof wire.model === "string" ? wire.model : undefined;
  if (modelUsage) {
    for (const [modelId, value] of Object.entries(modelUsage)) {
      if (!isRecord(value)) continue;
      model ??= modelId;
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
  const errorMessage =
    wire.is_error &&
    Array.isArray(wire.errors) &&
    typeof wire.errors[0] === "string"
      ? wire.errors[0]
      : wire.is_error && wire.subtype === "success"
        ? "Claude query reported an error despite its success subtype"
        : wire.is_error && typeof wire.subtype === "string"
          ? `Claude query reported an error (${wire.subtype})`
          : wire.is_error
            ? "Claude query reported an error"
            : undefined;
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

export function resolveClaudeModel(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return MODEL_ALIASES[value.toLowerCase()] ?? value;
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
    (task.config.fields?.appendSystemPrompt ??
      task.config.appendSystemPrompt) !== false;
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
        effortField(profile, filePath, CLAUDE_EFFORTS);
        stringField(profile, "tools", filePath);
        const append =
          profile.fields?.appendSystemPrompt ?? profile.appendSystemPrompt;
        if (append !== undefined && typeof append !== "boolean") {
          throw new Error(
            `appendSystemPrompt must be true or false in ${filePath}`,
          );
        }
        if (model && resolveClaudeModel(model) === undefined)
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
      const effort = effortField(task.config, "profile", CLAUDE_EFFORTS);
      return {
        model,
        effort,
        execute: async (run) => {
          const controller = new AbortController();
          let stream: Query | undefined;
          let streamEnded = false;
          let abortRequested = run.signal?.aborted ?? false;
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
            let errorMessage: string | undefined;
            for await (const message of stream) {
              for (const fact of translateClaudeMessage(message)) {
                if (fact.errorMessage) errorMessage = fact.errorMessage;
                run.report.message(fact);
              }
            }
            streamEnded = true;
            if (abortRequested) return { stopReason: "aborted" };
            return errorMessage
              ? { exitCode: 1, stopReason: "error", errorMessage }
              : { exitCode: 0 };
          } catch (error) {
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
