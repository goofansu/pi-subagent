import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { getDefaultAgentsDir, loadAgentConfigs } from "./agents.js";
import { formatToolCall, formatUsageStats } from "./formatting.js";
import { getDisplayItems, getFinalOutput } from "./messages.js";
import { runSingleAgent } from "./runner.js";
import type { DisplayItem, SubagentDetails } from "./types.js";

const COLLAPSED_ITEM_COUNT = 10;

// ── Agent config loading ──────────────────────────────────────────────────────

const agentConfigs = loadAgentConfigs(getDefaultAgentsDir(import.meta.url));

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const agentNames =
    agentConfigs.size > 0
      ? [...agentConfigs.keys()].join(", ")
      : "none configured";
  const toolDescription = `Delegate a task to a specialized subagent with an isolated context window. Available agents: ${agentNames}.`;

  pi.registerCommand("subagent", {
    description: "Delegate a task to a subagent.",
    handler: async (args, ctx) => {
      let task = args?.trim() || "";

      if (!task) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /subagent <task>", "error");
          return;
        }

        const input = await ctx.ui.editor(
          "What task should the subagent handle?",
        );

        if (!input?.trim()) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        task = input.trim();
      }

      await ctx.waitForIdle();
      pi.sendUserMessage(`Use the subagent tool for the task: ${task}`);
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: toolDescription,
    parameters: Type.Object({
      agent: Type.String({ description: "The agent to run the task" }),
      description: Type.String({ description: "Label for this specific call" }),
      prompt: Type.String({ description: "The full task brief" }),
    }),

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const header =
        theme.fg("toolTitle", theme.bold(args.agent)) +
        " " +
        theme.fg("muted", args.description);
      text.setText(`${header}\n${theme.fg("dim", args.prompt)}`);
      return text;
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      const r = details.results[0];
      const isRunning = r.exitCode === -1;
      const isError =
        !isRunning &&
        (r.exitCode !== 0 ||
          r.stopReason === "error" ||
          r.stopReason === "aborted");
      const icon = isRunning
        ? theme.fg("warning", "⏳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);
      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped =
          limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0)
          text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded
              ? item.text
              : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (expanded) {
        const container = new Container();
        let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
        if (r.description) header += ` ${theme.fg("muted", r.description)}`;
        if (isError && r.stopReason)
          header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        container.addChild(new Text(header, 0, 0));

        if (isError && r.errorMessage) {
          container.addChild(
            new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
          );
        }

        const toolCalls = displayItems.filter(
          (item) => item.type === "toolCall",
        );
        if (toolCalls.length > 0) {
          container.addChild(new Spacer(1));
          for (const item of toolCalls) {
            if (item.type === "toolCall") {
              container.addChild(
                new Text(
                  theme.fg("muted", "→ ") +
                    formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                  0,
                  0,
                ),
              );
            }
          }
        }

        if (finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
        } else if (!isError) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        }

        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      // Collapsed / running view
      let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
      if (r.description) text += ` ${theme.fg("muted", r.description)}`;
      if (isError && r.stopReason)
        text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

      if (isError && r.errorMessage) {
        text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
      } else if (displayItems.length === 0) {
        text += `\n${theme.fg("muted", isRunning ? "(running...)" : "(no output)")}`;
      } else {
        text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
      }

      const usageStr = formatUsageStats(r.usage, r.model);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      text += `\n${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`;

      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = agentConfigs.get(params.agent);
      if (!config) {
        throw new Error(
          `Unknown agent: "${params.agent}". Available: ${[...agentConfigs.keys()].join(", ") || "none"}`,
        );
      }

      const result = await runSingleAgent(
        config,
        params.description,
        params.prompt,
        signal,
        ctx.model,
        onUpdate,
      );

      const isError =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";

      if (isError) {
        const errorMsg =
          result.errorMessage ||
          result.stderr ||
          getFinalOutput(result.messages) ||
          "(no output)";
        return {
          content: [
            {
              type: "text",
              text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
            },
          ],
          details: { results: [result] },
          isError: true,
        };
      }

      const finalOutput = getFinalOutput(result.messages);
      if (!finalOutput && result.exitCode !== 0) {
        const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
        throw new Error(`Subagent "${params.agent}" failed: ${detail}`);
      }

      return {
        content: [
          {
            type: "text",
            text: finalOutput || `(exit code ${result.exitCode})`,
          },
        ],
        details: { results: [result] },
      };
    },
  });
}
