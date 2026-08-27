import path from "node:path";
import type {
  CodexAppServerEvent,
  CodexAppServerOptions,
} from "./codex-app-server.ts";
import { createCodexAppServerSource } from "./codex-app-server.ts";
import {
  effortField,
  type Harness,
  type HarnessDiagnostic,
  type HarnessRun,
  stringField,
} from "./harness.ts";
import { runOneShot, type Translation } from "./one-shot.ts";
import type { Fact, ParentModel, SubagentTask } from "./run.ts";
import { type AgentConfig, EFFORTS } from "./types.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collapsed(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function capped(value: string): string {
  return collapsed(value).slice(0, ACTIVITY_LIMIT);
}

function commandFromItem(item: Record<string, unknown>): string | undefined {
  const actions = item.commandActions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (isRecord(action) && typeof action.command === "string")
        return action.command;
    }
  }
  return typeof item.command === "string" ? item.command : undefined;
}

function relativePath(cwd: string, value: string): string {
  if (!path.isAbsolute(value)) return collapsed(value);
  const relative = path.relative(cwd, value);
  return collapsed(relative || path.basename(value));
}

function itemActivity(
  item: Record<string, unknown>,
  cwd: string,
): string | undefined {
  switch (item.type) {
    case "commandExecution": {
      const command = commandFromItem(item);
      return command ? capped(`$ ${command}`) : undefined;
    }
    case "fileChange": {
      const changes = item.changes;
      const first =
        Array.isArray(changes) && isRecord(changes[0])
          ? changes[0].path
          : undefined;
      return typeof first === "string"
        ? capped(`Editing ${relativePath(cwd, first)}`)
        : undefined;
    }
    case "reasoning":
      return "Thinking…";
    case "webSearch":
      return typeof item.query === "string"
        ? capped(`Searching: ${item.query}`)
        : undefined;
    case "mcpToolCall":
      return typeof item.tool === "string"
        ? `Calling ${item.tool}…`
        : undefined;
    default:
      return undefined;
  }
}

function usageDelta(
  current: Record<string, unknown>,
  previous: Record<string, number> | undefined,
): { fact: Fact; next: Record<string, number> } {
  const number = (key: string): number =>
    typeof current[key] === "number" ? current[key] : 0;
  const next = {
    totalTokens: number("totalTokens"),
    inputTokens: number("inputTokens"),
    cachedInputTokens: number("cachedInputTokens"),
    cacheWriteInputTokens: number("cacheWriteInputTokens"),
    outputTokens: number("outputTokens"),
    reasoningOutputTokens: number("reasoningOutputTokens"),
  };
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

function terminalTurnError(turn: unknown): string | undefined {
  if (!isRecord(turn) || !isRecord(turn.error)) return undefined;
  return typeof turn.error.message === "string"
    ? turn.error.message
    : undefined;
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
  let previousUsage: Record<string, number> | undefined;
  let completedAgentMessage = false;

  return (event) => {
    if (event.method === "item/started") {
      const item = event.params.item;
      if (!isRecord(item)) return undefined;
      const activity = itemActivity(item, cwd);
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
      if (!isRecord(item)) return undefined;
      if (item.type === "agentMessage") {
        completedAgentMessage = true;
        const text = typeof item.text === "string" ? item.text : "";
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
        return command
          ? {
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
            }
          : undefined;
      }
      return undefined;
    }

    if (event.method === "thread/tokenUsage/updated") {
      const tokenUsage = event.params.tokenUsage;
      if (!isRecord(tokenUsage) || !isRecord(tokenUsage.total))
        return undefined;
      const result = usageDelta(tokenUsage.total, previousUsage);
      previousUsage = result.next;
      return { facts: [result.fact] };
    }

    if (event.method === "error") {
      const error = isRecord(event.params.error)
        ? event.params.error.message
        : undefined;
      if (typeof error !== "string") return undefined;
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

/** Translate a single event for callers that do not need cumulative state. */
export function translateCodexJsonEvent(
  event: CodexAppServerEvent,
): Translation | undefined {
  return createCodexTranslator(process.cwd())(event);
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
