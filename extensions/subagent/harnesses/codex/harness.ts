import path from "node:path";
import { runOneShot, type Translation } from "../../one-shot.ts";
import type { Fact, ParentModel, SubagentTask } from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import {
  effortField,
  type Harness,
  type HarnessDiagnostic,
  type HarnessRun,
  stringField,
} from "../contract.ts";
import type {
  CodexAppServerEvent,
  CodexAppServerOptions,
  ThreadItem,
  TokenUsageBreakdown,
  Turn,
} from "./app-server.ts";
import { createCodexAppServerSource } from "./app-server.ts";

const CODEX_PROFILE_FIELDS = ["model", "effort"] as const;
const MISSING_CODEX_ANSWER =
  "Codex exited without a terminal agent message answer.";
const ACTIVITY_LIMIT = 120;

export interface CodexHarnessOptions {
  readonly spawn?: CodexAppServerOptions["spawn"];
  readonly killEscalationMs?: number;
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

function commandFromItem(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string {
  return (
    item.commandActions?.find((action) => action.command)?.command ??
    item.command
  );
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
  current: TokenUsageBreakdown,
  previous: TokenUsageBreakdown | undefined,
): { fact: Fact; next: TokenUsageBreakdown } {
  const next = { ...current };
  const diff = (key: keyof typeof next): number =>
    next[key] - (previous?.[key] ?? 0);
  return {
    fact: {
      role: "metadata",
      parts: [],
      usage: {
        input: diff("inputTokens"),
        cacheRead: diff("cachedInputTokens"),
        cacheWrite: diff("cacheWriteInputTokens"),
        output: diff("outputTokens") + diff("reasoningOutputTokens"),
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
): (event: CodexAppServerEvent) => Translation | undefined {
  const reasoning = new Map<string, string>();
  let previousUsage: TokenUsageBreakdown | undefined;
  let completedAgentMessage = false;

  return (event) => {
    if (event.method === "item/started") {
      const activity = itemActivity(event.params.item, cwd);
      return activity ? { activity } : undefined;
    }

    if (event.method === "item/agentMessage/delta") {
      return { activity: "Writing response…" };
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
      const result = usageDelta(event.params.tokenUsage.total, previousUsage);
      previousUsage = result.next;
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

function codexPrompt(task: SubagentTask): string {
  return task.config.systemPrompt
    ? `${task.config.systemPrompt}\n\n${task.prompt}`
    : task.prompt;
}

/** Create the Codex one-shot harness using the App Server transport. */
export function createCodexHarness(options: CodexHarnessOptions = {}): Harness {
  return {
    name: "codex",
    validate: validateCodexProfile,
    prepare(task: SubagentTask, _parentModel?: ParentModel): HarnessRun {
      const model = stringField(task.config, "model", "profile");
      const effort = codexEffort(effortField(task.config, "profile", EFFORTS));
      return {
        model,
        execute: (run) =>
          runOneShot({
            source: createCodexAppServerSource({
              cwd: task.cwd,
              childDepth: task.childDepth,
              prompt: codexPrompt(task),
              model,
              effort,
              ...(options.spawn ? { spawn: options.spawn } : {}),
              ...(options.killEscalationMs === undefined
                ? {}
                : { killEscalationMs: options.killEscalationMs }),
            }),
            translate: createCodexTranslator(task.cwd),
            report: run.report,
            signal: run.signal,
            missingAnswerMessage: MISSING_CODEX_ANSWER,
          }),
      };
    },
  };
}
