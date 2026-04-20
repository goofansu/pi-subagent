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
import type { Message } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import {
  type TaskDetails,
  formatToolCall,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
} from "./utils.js";

const COLLAPSED_ITEM_COUNT = 10;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "worker",
    label: "worker",
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
        theme.fg("toolTitle", theme.bold("worker ")) + theme.fg("dim", preview),
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

      const renderDisplayItems = (items: typeof displayItems, limit?: number) => {
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

        let header = `${icon} ${theme.fg("toolTitle", theme.bold("worker"))}`;
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
      let text = `${icon} ${theme.fg("toolTitle", theme.bold("worker"))}`;
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
