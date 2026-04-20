/**
 * Task Tool - Spawn an isolated pi subagent process
 *
 * Accepts a prompt, model, and cwd. Spawns `pi --mode json -p --no-session`,
 * streams output, returns the final assistant text.
 *
 * Orchestration (chaining, parallel, loops) is left to the parent LLM,
 * guided by skills/prompt templates.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import { Type } from "@mariozechner/pi-ai";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

const COLLAPSED_ITEM_COUNT = 10;

// --- Formatting helpers ---

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

// --- Types ---

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface TaskDetails {
  task: string;
  model?: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

// --- Message helpers ---

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Delegate a task to an isolated subagent. Spawns a separate pi process with its own context window. Returns the agent's final output.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task prompt for the subagent" }),
      model: Type.Optional(Type.String({ description: "Model to use (e.g. claude-sonnet-4-5, claude-haiku-4-5)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      if (params.model) args.push("--model", params.model);
      args.push(params.prompt);

      const details: TaskDetails = {
        task: params.prompt,
        model: params.model,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      };

      let wasAborted = false;

      const emitUpdate = () => {
        if (onUpdate) {
          onUpdate({
            content: [{ type: "text", text: getFinalOutput(details.messages) || "(running...)" }],
            details: { ...details },
          });
        }
      };

      const exitCode = await new Promise<number>((resolve) => {
        const proc = spawn("pi", args, {
          cwd: params.cwd ?? ctx.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let buffer = "";

        const processLine = (line: string) => {
          if (!line.trim()) return;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }

          if (event.type === "message_end" && event.message) {
            const msg = event.message as Message;
            details.messages.push(msg);

            if (msg.role === "assistant") {
              details.usage.turns++;
              const usage = msg.usage;
              if (usage) {
                details.usage.input += usage.input || 0;
                details.usage.output += usage.output || 0;
                details.usage.cacheRead += usage.cacheRead || 0;
                details.usage.cacheWrite += usage.cacheWrite || 0;
                details.usage.cost += usage.cost?.total || 0;
                details.usage.contextTokens = usage.totalTokens || 0;
              }
              if (!details.model && msg.model) details.model = msg.model;
              if (msg.stopReason) details.stopReason = msg.stopReason;
              if (msg.errorMessage) details.errorMessage = msg.errorMessage;
            }
            emitUpdate();
          }

          if (event.type === "tool_result_end" && event.message) {
            details.messages.push(event.message as Message);
            emitUpdate();
          }
        };

        proc.stdout.on("data", (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) processLine(line);
        });

        proc.stderr.on("data", (data: Buffer) => {
          details.stderr += data.toString();
        });

        proc.on("close", (code: number | null) => {
          if (buffer.trim()) processLine(buffer);
          resolve(code ?? 1);
        });

        proc.on("error", () => resolve(1));

        if (signal) {
          const kill = () => {
            wasAborted = true;
            proc.kill("SIGTERM");
            setTimeout(() => {
              if (!proc.killed) proc.kill("SIGKILL");
            }, 5000);
          };
          if (signal.aborted) kill();
          else signal.addEventListener("abort", kill, { once: true });
        }
      });

      details.exitCode = exitCode;

      if (wasAborted) {
        return {
          content: [{ type: "text", text: "Task aborted." }],
          details,
          isError: true,
        };
      }

      const output = getFinalOutput(details.messages);
      const isError = exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted";

      return {
        content: [{ type: "text", text: isError ? (details.stderr || output || "(task failed)") : (output || "(no output)") }],
        details,
        isError: isError || undefined,
      };
    },

    renderCall(args, theme) {
      const preview = args.prompt.length > 80 ? `${args.prompt.slice(0, 80)}...` : args.prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("task ")) + theme.fg("dim", preview),
        0, 0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as TaskDetails | undefined;
      if (!details || details.messages.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const isError = details.exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const displayItems = getDisplayItems(details.messages);
      const finalOutput = getFinalOutput(details.messages);

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      // --- Expanded view ---
      if (expanded) {
        const mdTheme = getMarkdownTheme();
        const container = new Container();

        let header = `${icon} ${theme.fg("toolTitle", theme.bold("task"))}`;
        if (details.model) header += theme.fg("muted", ` [${details.model}]`);
        if (isError && details.stopReason) header += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
        container.addChild(new Text(header, 0, 0));

        if (isError && details.errorMessage)
          container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));

        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", details.task), 0, 0));

        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));

        if (displayItems.length === 0 && !finalOutput) {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        } else {
          for (const item of displayItems) {
            if (item.type === "toolCall")
              container.addChild(
                new Text(
                  theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                  0, 0,
                ),
              );
          }
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }
        }

        const usageStr = formatUsageStats(details.usage, details.model);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      // --- Collapsed view ---
      let text = `${icon} ${theme.fg("toolTitle", theme.bold("task"))}`;
      if (details.model) text += theme.fg("muted", ` [${details.model}]`);
      if (isError && details.stopReason) text += ` ${theme.fg("error", `[${details.stopReason}]`)}`;

      if (isError && details.errorMessage) {
        text += `\n${theme.fg("error", `Error: ${details.errorMessage}`)}`;
      } else if (displayItems.length === 0) {
        text += `\n${theme.fg("muted", "(no output)")}`;
      } else {
        text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
        if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      }

      const usageStr = formatUsageStats(details.usage, details.model);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      return new Text(text, 0, 0);
    },
  });
}
