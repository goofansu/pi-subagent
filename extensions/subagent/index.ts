import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildAgentConfigLayers,
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  loadLayeredAgentConfigsWithDiagnostics,
  validateAgentSkills,
} from "./agents.ts";
import { registerAgentsCommand } from "./agents-command.ts";
import { getFinalOutput } from "./messages.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { runSingleAgent } from "./runner.ts";

export interface SubagentExtensionOptions {
  cwd?: string;
  agentDir?: string;
  configCwd?: string;
}

// Keep the public factory boundary independent of this package's local
// peer-dependency instance so embedders can use their own Pi version.
// biome-ignore lint/suspicious/noExplicitAny: Extension hosts provide the concrete Pi API at runtime.
export type SubagentExtension = (pi: any) => void;

// ── Extension ─────────────────────────────────────────────────────────────────

export function createSubagentExtension(
  options: SubagentExtensionOptions = {},
): SubagentExtension {
  return function subagentExtension(pi: ExtensionAPI) {
    const projectCwd = options.cwd ?? process.cwd();
    const configCwd = options.configCwd ?? projectCwd;
    const configuredAgentDir = options.agentDir ?? getAgentDir();
    const agentConfigLoadResult = loadLayeredAgentConfigsWithDiagnostics(
      buildAgentConfigLayers(
        projectCwd,
        configuredAgentDir,
        import.meta.url,
        configCwd,
      ),
    );
    const agentConfigs = agentConfigLoadResult.configs;
    const description = "Run a task in a specialized subagent";

    pi.on("session_start", (event, ctx) => {
      if (event.reason !== "startup" && event.reason !== "reload") return;

      if (agentConfigLoadResult.invalidFiles.length > 0) {
        const warning = formatInvalidAgentFilesWarning(
          agentConfigLoadResult.invalidFiles,
        );
        ctx.ui.notify(warning, "warning");
      }

      const skillWarnings = validateAgentSkills(
        agentConfigs,
        configCwd,
        configuredAgentDir,
      );
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
        description: Type.String({
          description: "Label for this specific call",
        }),
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
          projectCwd,
          configuredAgentDir,
          configCwd,
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
  };
}

export default createSubagentExtension();
