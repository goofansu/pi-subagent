import path from "node:path";
import type { Translation } from "../../one-shot.ts";
import type {
  Fact,
  RunEnding,
  SubagentContext,
  SubagentTask,
} from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import {
  effortField,
  type Harness,
  type HarnessAdapter,
  type HarnessDiagnostic,
  stringField,
} from "../contract.ts";
import type {
  CodexAppServerEvent,
  CodexAppServerOptions,
  ThreadItem,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  Turn,
} from "./app-server.ts";
import { runCodexAppServer } from "./app-server.ts";

const CODEX_PROFILE_FIELDS = ["model", "effort"] as const;
const MISSING_CODEX_ANSWER =
  "Codex exited without a terminal agent message answer.";
const ACTIVITY_LIMIT = 120;
// Leave room after the command for its latest output line in the activity.
const COMMAND_PREFIX_LIMIT = 60;
// Only the tail of a command's output can become live activity.
const OUTPUT_TAIL_LIMIT = 2048;
// Cap memory and keep each streamed-message delta's preview work constant.
const AGENT_MESSAGE_TAIL_LIMIT = 2048;

export interface CodexHarnessOptions {
  readonly spawn?: CodexAppServerOptions["spawn"];
  readonly killEscalationMs?: number;
}

interface CodexTranslatorOptions {
  readonly previousUsage?: TokenUsageBreakdown;
  readonly onUsage?: (usage: TokenUsageBreakdown) => void;
}

export function codexEffort(effort: string | undefined): string | undefined {
  return effort === "off" ? "none" : effort;
}

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

function usageDelta(
  tokenUsage: ThreadTokenUsage,
  previous: TokenUsageBreakdown | undefined,
  allowBaselineReset: boolean,
): { fact: Fact; next: TokenUsageBreakdown } {
  const next = { ...tokenUsage.total };
  const counterKeys = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;
  // App Server releases have exposed both Conversation-cumulative and
  // attachment-local counters. A first current-Turn update below the retained
  // Conversation baseline is the latter and must be translated from zero.
  const baseline =
    allowBaselineReset &&
    previous &&
    counterKeys.some((key) => next[key] < previous[key])
      ? undefined
      : previous;
  const diff = (key: keyof typeof next): number =>
    Math.max(0, next[key] - (baseline?.[key] ?? 0));
  return {
    fact: {
      role: "metadata",
      parts: [],
      usage: {
        input: diff("inputTokens"),
        cacheRead: diff("cachedInputTokens"),
        cacheWrite: diff("cacheWriteInputTokens"),
        output: diff("outputTokens") + diff("reasoningOutputTokens"),
        // The latest provider request's total is the context-size gauge; the
        // schema's modelContextWindow is capacity, not occupancy.
        contextTokens: tokenUsage.last.totalTokens,
        turns: 1,
      },
    },
    next,
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

/** Create the stateful translator for one disposable App Server turn. */
export function createCodexTranslator(
  cwd: string,
  options: CodexTranslatorOptions = {},
): (event: CodexAppServerEvent) => Translation | undefined {
  const reasoning = new Map<string, string>();
  const commands = new Map<string, string>();
  const outputTails = new Map<string, string>();
  const agentMessageTails = new Map<string, string>();
  let previousUsage = options.previousUsage;
  let firstUsageUpdate = true;
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
      const result = usageDelta(
        event.params.tokenUsage,
        previousUsage,
        firstUsageUpdate,
      );
      firstUsageUpdate = false;
      previousUsage = result.next;
      options.onUsage?.(result.next);
      return { facts: [result.fact] };
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

function validateCodexProfile(
  profile: AgentConfig,
  filePath: string,
): HarnessDiagnostic[] {
  const diagnostics = Object.keys(profile.fields ?? {})
    .filter(
      (field) => !(CODEX_PROFILE_FIELDS as readonly string[]).includes(field),
    )
    .map((field) => ({
      reason: `Codex harness does not recognize field '${field}'`,
    }));
  try {
    stringField(profile, "model", filePath);
    effortField(profile, filePath, EFFORTS);
  } catch (error) {
    diagnostics.push({
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return diagnostics;
}

function codexPrompt(context: SubagentContext, task: SubagentTask): string {
  return context.config.systemPrompt
    ? `${context.config.systemPrompt}\n\n${task.prompt}`
    : task.prompt;
}

/** Create the Codex one-shot harness using the ordered App Server Run. */
export function createCodexHarness(options: CodexHarnessOptions = {}): Harness {
  return {
    name: "codex",
    validate: validateCodexProfile,
    prepare(context: SubagentContext): HarnessAdapter {
      const model = stringField(context.config, "model", "profile");
      const effort = codexEffort(
        effortField(context.config, "profile", EFFORTS),
      );
      let continuation:
        | { threadId: string; usage?: TokenUsageBreakdown }
        | undefined;
      let activeAttempt:
        | {
            readonly controller: AbortController;
            readonly promise: Promise<RunEnding>;
          }
        | undefined;
      let closed = false;
      return {
        capabilities: { resume: true },
        model,
        prepareRun: (task) => ({
          supportedControls: ["steer"],
          execute: async (run) => {
            if (closed) {
              return {
                ending: "failed",
                errorMessage: "Codex adapter is closed",
              };
            }
            if (activeAttempt) {
              return {
                ending: "failed",
                errorMessage: "Codex adapter already has an active Attempt",
              };
            }
            const controller = new AbortController();
            const forwardAbort = (): void => controller.abort();
            if (run.signal?.aborted) controller.abort();
            else
              run.signal?.addEventListener("abort", forwardAbort, {
                once: true,
              });
            const attached = continuation;
            // Yield once so activeAttempt is installed before spawning. Close
            // can then own cancellation even when provider callbacks re-enter
            // Session shutdown during synchronous fixture I/O.
            const promise = (async (): Promise<RunEnding> => {
              await Promise.resolve();
              try {
                return await runCodexAppServer({
                  cwd: context.cwd,
                  childDepth: context.childDepth,
                  prompt: attached ? task.prompt : codexPrompt(context, task),
                  model,
                  effort,
                  ...(attached
                    ? { continuationThreadId: attached.threadId }
                    : {}),
                  onThreadAttached: (threadId) => {
                    continuation ??= { threadId };
                  },
                  translate: createCodexTranslator(context.cwd, {
                    ...(attached?.usage
                      ? { previousUsage: attached.usage }
                      : {}),
                    onUsage: (usage) => {
                      if (continuation) continuation.usage = usage;
                    },
                  }),
                  report: run.report,
                  signal: controller.signal,
                  controls: run.controls,
                  missingAnswerMessage: MISSING_CODEX_ANSWER,
                  ...(options.spawn ? { spawn: options.spawn } : {}),
                  ...(options.killEscalationMs === undefined
                    ? {}
                    : { killEscalationMs: options.killEscalationMs }),
                });
              } finally {
                run.signal?.removeEventListener("abort", forwardAbort);
              }
            })();
            const attempt = { controller, promise };
            activeAttempt = attempt;
            try {
              return await promise;
            } finally {
              if (activeAttempt === attempt) activeAttempt = undefined;
            }
          },
        }),
        close: async () => {
          closed = true;
          const attempt = activeAttempt;
          attempt?.controller.abort();
          await attempt?.promise.catch(() => {});
        },
      };
    },
  };
}
