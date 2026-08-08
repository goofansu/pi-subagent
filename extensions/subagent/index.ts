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
} from "./agents.ts";
import { registerAgentsCommand } from "./agents-command.ts";
import type { BackendRegistry } from "./backend.ts";
import { getFinalOutput } from "./messages.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import {
  defaultBackendRegistry,
  getSubagentDepth,
  runSubagent,
} from "./runner.ts";
import type { AgentConfig, Harness } from "./types.ts";
import { resolveHarness } from "./types.ts";

/**
 * Report harnesses that configured agents ask for but that cannot run here —
 * an unregistered harness, or one whose SDK or binary is missing. Surfacing
 * this at session start beats failing the first delegation.
 */
export async function findUnavailableHarnessWarnings(
  agentConfigs: ReadonlyMap<string, AgentConfig>,
  registry: BackendRegistry,
): Promise<string[]> {
  const agentsByHarness = new Map<Harness, string[]>();
  for (const config of agentConfigs.values()) {
    const harness = resolveHarness(config);
    const names = agentsByHarness.get(harness) ?? [];
    names.push(config.name);
    agentsByHarness.set(harness, names);
  }

  const warnings: string[] = [];
  for (const [harness, names] of agentsByHarness) {
    const backend = registry.get(harness);
    const available = backend ? await backend.isAvailable() : false;
    if (available) continue;
    warnings.push(
      `Harness '${harness}' is not available; these agents cannot run: ${names.join(", ")}.` +
        (harness === "claude"
          ? ` '@anthropic-ai/claude-agent-sdk' and the per-platform CLI binary it drives are optional dependencies of pi-subagent; reinstall the package, without '--omit=optional', to restore them.`
          : harness === "codex"
            ? ` Install or update the Codex CLI, make sure the 'codex' command is on PATH, and verify it supports app server plus the 'multi_agent' and 'multi_agent_v2' feature gates.`
            : ""),
    );
  }
  return warnings;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export function registerSubagentFeatures(
  pi: ExtensionAPI,
  projectCwd: string,
  configuredAgentDir: string,
  agentConfigs: Map<string, AgentConfig>,
  projectTrusted: boolean,
  runner: typeof runSubagent = runSubagent,
): void {
  registerAgentsCommand(pi, agentConfigs);

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
        // Pi already decided whether this directory is trusted, and asked the
        // person if it had to. Reusing that decision is what keeps delegating
        // from granting a directory more than working in it already did.
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
        agentDir: configuredAgentDir,
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
  // depth check remains the backstop for external harnesses and direct calls.
  if (getSubagentDepth() > 0) return;

  const configuredAgentDir = getAgentDir();

  // Project trust is resolved before session_start. Defer every discovery read
  // until then so an unknown host fails closed and an untrusted checkout cannot
  // contribute .pi/agents.
  pi.on("session_start", async (_event, ctx) => {
    const projectCwd = ctx.cwd;
    const projectTrusted = ctx.isProjectTrusted?.() ?? false;
    const agentConfigLoadResult = loadLayeredAgentConfigsWithDiagnostics(
      buildAgentConfigLayers(projectCwd, configuredAgentDir, projectTrusted),
    );
    const agentConfigs = agentConfigLoadResult.configs;

    registerSubagentFeatures(
      pi,
      projectCwd,
      configuredAgentDir,
      agentConfigs,
      projectTrusted,
    );

    for (const warning of await findUnavailableHarnessWarnings(
      agentConfigs,
      defaultBackendRegistry,
    )) {
      ctx.ui.notify(warning, "warning");
    }

    if (agentConfigLoadResult.invalidFiles.length > 0) {
      ctx.ui.notify(
        formatInvalidAgentFilesWarning(agentConfigLoadResult.invalidFiles),
        "warning",
      );
    }
  });
}
