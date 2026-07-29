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
import type { BackendRegistry } from "./backend.ts";
import { getFinalOutput } from "./messages.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { defaultBackendRegistry, runSubagent } from "./runner.ts";
import type { AgentConfig, Harness } from "./types.ts";
import { resolveHarness } from "./types.ts";

export interface SubagentExtensionOptions {
  cwd?: string;
  agentDir?: string;
  configCwd?: string;
}

// Keep the public factory boundary independent of this package's local
// peer-dependency instance so embedders can use their own Pi version.
// biome-ignore lint/suspicious/noExplicitAny: Extension hosts provide the concrete Pi API at runtime.
export type SubagentExtension = (pi: any) => void;

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

    pi.on("session_start", async (event, ctx) => {
      if (event.reason !== "startup" && event.reason !== "reload") return;

      for (const warning of await findUnavailableHarnessWarnings(
        agentConfigs,
        defaultBackendRegistry,
      )) {
        ctx.ui.notify(warning, "warning");
      }

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

        const result = await runSubagent({
          config,
          description: params.description,
          prompt: params.prompt,
          signal,
          // Pi already decided whether this directory is trusted, and asked the
          // person if it had to. Reusing that decision is what keeps delegating
          // from granting a directory more than working in it already did.
          // Optional call: a host too old to report trust must read as
          // untrusted, not as trusting.
          projectTrusted: ctx.isProjectTrusted?.() ?? false,
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
          configCwd,
        });

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
