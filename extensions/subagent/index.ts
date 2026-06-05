import * as path from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getDefaultAgentsDir,
  loadLayeredAgentConfigsWithDiagnostics,
  validateAgentSkills,
} from "./agents.js";
import { registerAgentsCommand } from "./agents-command.js";
import { getFinalOutput } from "./messages.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { runSingleAgent } from "./runner.js";

// ── Agent config loading ──────────────────────────────────────────────────────

const agentConfigLoadResult = loadLayeredAgentConfigsWithDiagnostics([
  { dir: getDefaultAgentsDir(import.meta.url), source: "default" },
  { dir: path.join(getAgentDir(), "agents"), source: "user" },
  { dir: path.join(process.cwd(), ".pi", "agents"), source: "project" },
]);
const agentConfigs = agentConfigLoadResult.configs;

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const description = "Run a task in a specialized subagent";

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;

    if (agentConfigLoadResult.invalidFiles.length > 0) {
      const warning = formatInvalidAgentFilesWarning(
        agentConfigLoadResult.invalidFiles,
      );
      ctx.ui.notify(warning, "warning");
    }

    const skillWarnings = validateAgentSkills(agentConfigs, process.cwd());
    for (const warning of skillWarnings) {
      ctx.ui.notify(warning, "warning");
    }
  });

  registerAgentsCommand(pi, agentConfigs);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description,
    promptSnippet: description,
    promptGuidelines: formatAgentGuidelines(agentConfigs),
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
        ctx.model
          ? {
              provider: ctx.model.provider,
              id: ctx.model.id,
              thinkingLevel: pi.getThinkingLevel(),
            }
          : undefined,
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
