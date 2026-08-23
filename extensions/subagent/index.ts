import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getAgentsDir,
  loadAgentConfigsWithDiagnostics,
} from "./agents.ts";
import { registerAgentsCommand } from "./agents-command.ts";
import { getFinalOutput } from "./messages.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { getSubagentDepth, runSubagent } from "./runner.ts";
import type { AgentConfig } from "./types.ts";

export function registerSubagentFeatures(
  pi: ExtensionAPI,
  projectCwd: string,
  agentsDir: string,
  agentConfigs: Map<string, AgentConfig>,
  projectTrusted: boolean,
  runner: typeof runSubagent = runSubagent,
): void {
  registerAgentsCommand(pi, agentConfigs, agentsDir);

  const description = "Run a task in a specialized subagent";
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

      const result = await runner({
        config,
        description: params.description,
        prompt: params.prompt,
        signal,
        // Pi's own trust decision for this directory, taken once at session
        // start. Forwarding it is what makes a subagent see the project exactly
        // as the session that delegated to it does.
        projectTrusted,
        parentModel: ctx.model
          ? {
              provider: ctx.model.provider,
              id: ctx.model.id,
              thinkingLevel: pi.getThinkingLevel(),
            }
          : undefined,
        onUpdate,
        cwd: projectCwd,
      });

      const isError = result.status === "failed" || result.status === "aborted";

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

export default function subagentExtension(pi: ExtensionAPI) {
  // A Pi child loads installed extensions just like its parent. Keep this
  // extension entirely inert there so the model cannot see and repeatedly
  // attempt a tool that the dispatcher would reject anyway. The dispatcher's
  // depth check remains the backstop for direct calls.
  if (getSubagentDepth() > 0) return;

  const configuredAgentDir = getAgentDir();

  const agentsDir = getAgentsDir(configuredAgentDir);

  // Agents come only from user scope, so discovery reads nothing a working
  // directory controls and needs no trust decision of its own.
  //
  // A child pi is a different matter: it runs in the project directory and
  // resolves its own settings, resources, and packages there. Pi has already
  // decided whether this directory is trusted — see
  // https://pi.dev/docs/latest/security#project-trust — so read its answer and
  // forward it rather than deriving a second one. A child runs
  // non-interactively and could neither prompt nor see a session-only decision
  // on its own. A host that cannot report at all fails closed.
  //
  // The answer is taken once, here, and reused for the session.
  pi.on("session_start", (_event, ctx) => {
    const agentConfigLoadResult = loadAgentConfigsWithDiagnostics(agentsDir);
    const agentConfigs = agentConfigLoadResult.configs;

    registerSubagentFeatures(
      pi,
      ctx.cwd,
      agentsDir,
      agentConfigs,
      ctx.isProjectTrusted?.() ?? false,
    );

    if (agentConfigLoadResult.invalidFiles.length > 0) {
      ctx.ui.notify(
        formatInvalidAgentFilesWarning(agentConfigLoadResult.invalidFiles),
        "warning",
      );
    }
  });
}
