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
import {
  DEPTH_ENV_KEY,
  type Fact,
  type FactPart,
  type ParentModel,
  type SubagentTask,
} from "./run.ts";
import { type AgentConfig, EFFORTS } from "./types.ts";

/**
 * The SDK documents these family aliases and resolves each to its current
 * default ID itself, so no local alias→ID mapping or full-ID allowlist is
 * kept — both went stale in practice as models shipped. Only aliases are
 * accepted: a full or dated ID would need such an allowlist to validate
 * deterministically at session start, and profiles here always want the
 * current model of a family. Canonical model provenance on the run record
 * comes from the child's streamed facts, which are authoritative over this
 * baseline.
 */
export const CLAUDE_MODEL_ALIASES: readonly string[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
];
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
    const model =
      typeof wire.message.model === "string" ? wire.message.model : undefined;
    // Thinking-only and empty assistant messages still carry model
    // provenance. Keep those metadata-bearing facts even when no content
    // block can cross the harness seam.
    if (parts.length === 0 && !model) return [];
    return [
      {
        role: "assistant",
        parts,
        // Claude reports total turns on its terminal result. Streamed
        // assistant messages are progress, not additional turns.
        usage: { turns: 0 },
        ...(model ? { model } : {}),
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
  const modelUsageEntries = modelUsage ? Object.entries(modelUsage) : [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const reportedCost =
    typeof wire.total_cost_usd === "number" ? wire.total_cost_usd : undefined;
  let cost = reportedCost ?? 0;
  // The SDK result has no model field in some versions. A single usage entry
  // is an unambiguous answer; multiple entries may include auxiliary models,
  // so never pick whichever happens to be first.
  const model =
    typeof wire.model === "string"
      ? wire.model
      : modelUsageEntries.length === 1
        ? modelUsageEntries[0]?.[0]
        : undefined;
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
  return CLAUDE_MODEL_ALIASES.includes(value.toLowerCase());
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
    disallowedTools: ["Agent", "Task"],
    // The SDK's `env` replaces the subprocess environment entirely rather
    // than merging, so spread process.env to keep the ADR-0008 inheritance.
    // The depth key closes the other half of the Depth constraint:
    // disallowedTools stops in-SDK spawning, this stops a Bash-launched
    // grandchild pi from starting at depth zero.
    env: { ...process.env, [DEPTH_ENV_KEY]: String(task.childDepth) },
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
          throw new Error(
            `invalid Claude model '${model}' (expected one of: ${CLAUDE_MODEL_ALIASES.join(", ")})`,
          );
      } catch (error) {
        diagnostics.push({
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return diagnostics;
    },
    prepare(task: SubagentTask, _parentModel?: ParentModel): HarnessRun {
      // The alias is passed through as-is; the SDK resolves it to the
      // family's current default ID.
      const model = stringField(task.config, "model", "profile")?.toLowerCase();
      const effort = effortField(task.config, "profile", EFFORTS);
      return {
        model,
        effort,
        execute: async (run) => {
          const controller = new AbortController();
          let stream: Query | undefined;
          let streamEnded = false;
          let terminalResultReceived = false;
          let terminalResultBeforeAbort = false;
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
            // Loading the SDK is asynchronous. Cancellation can win that race;
            // in that case no provider query may be started.
            if (controller.signal.aborted) return { stopReason: "aborted" };
            const options = buildClaudeOptions(task, model, effort, controller);
            options.stderr = (data) => run.report.stderr(data);
            stream = query({ prompt: task.prompt, options });
            if (controller.signal.aborted) {
              stream.close();
              return { stopReason: "aborted" };
            }
            for await (const message of stream) {
              if (
                (message as { type?: string }).type === "result" &&
                !terminalResultReceived
              ) {
                terminalResultReceived = true;
                // Ordering is the cancellation contract: a result witnessed
                // before abort is authoritative, while a queued result after
                // abort cannot resurrect the run.
                terminalResultBeforeAbort = !abortRequested;
              }
              for (const fact of translateClaudeMessage(message)) {
                if (fact.errorMessage) errorMessage = fact.errorMessage;
                run.report.message(fact);
              }
            }
            streamEnded = true;
            if (abortRequested && !terminalResultBeforeAbort)
              return { stopReason: "aborted" };
            return errorMessage
              ? { exitCode: 1, stopReason: "error", errorMessage }
              : { exitCode: 0 };
          } catch (error) {
            if (terminalResultBeforeAbort) {
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
