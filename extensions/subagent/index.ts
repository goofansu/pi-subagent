import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { getDefaultAgentsDir, loadAgentConfigs } from "./agents.js";
import { getFinalOutput } from "./messages.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { runSingleAgent } from "./runner.js";

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

    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,

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
