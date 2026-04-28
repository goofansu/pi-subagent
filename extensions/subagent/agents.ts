import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./types.js";

export interface InvalidAgentConfig {
  filePath: string;
  reason: string;
}

export interface AgentConfigLoadResult {
  configs: Map<string, AgentConfig>;
  invalidFiles: InvalidAgentConfig[];
}

export class AgentConfigValidationError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
  ) {
    super(message);
    this.name = "AgentConfigValidationError";
  }
}

export function parseAgentConfig(filePath: string): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<{
    description?: string;
    model?: string;
    tools?: string;
  }>(content);
  const description = frontmatter.description?.trim();
  const systemPrompt = body.trim();
  if (!description) {
    throw new AgentConfigValidationError(
      "missing required description frontmatter",
      filePath,
    );
  }
  if (!systemPrompt) {
    throw new AgentConfigValidationError(
      "missing required prompt body",
      filePath,
    );
  }

  return {
    name: path.basename(filePath, path.extname(filePath)),
    description,
    model: frontmatter.model,
    tools: frontmatter.tools,
    systemPrompt,
  };
}

export function getDefaultAgentsDir(moduleUrl: string): string {
  return path.join(path.dirname(new URL(moduleUrl).pathname), "../../agents");
}

export function loadAgentConfigsWithDiagnostics(
  agentsDir: string,
): AgentConfigLoadResult {
  const configs = new Map<string, AgentConfig>();
  const invalidFiles: InvalidAgentConfig[] = [];
  if (!fs.existsSync(agentsDir)) return { configs, invalidFiles };
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(agentsDir, file);
    try {
      const config = parseAgentConfig(filePath);
      configs.set(config.name, config);
    } catch (error) {
      invalidFiles.push({
        filePath,
        reason:
          error instanceof AgentConfigValidationError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }
  return { configs, invalidFiles };
}

export function loadAgentConfigs(agentsDir: string): Map<string, AgentConfig> {
  return loadAgentConfigsWithDiagnostics(agentsDir).configs;
}

export function loadMergedAgentConfigsWithDiagnostics(
  baseAgentsDir: string,
  overrideAgentsDir: string,
): AgentConfigLoadResult {
  const base = loadAgentConfigsWithDiagnostics(baseAgentsDir);
  const override = loadAgentConfigsWithDiagnostics(overrideAgentsDir);
  return {
    configs: new Map([...base.configs, ...override.configs]),
    invalidFiles: [...base.invalidFiles, ...override.invalidFiles],
  };
}

export function loadMergedAgentConfigs(
  baseAgentsDir: string,
  overrideAgentsDir: string,
): Map<string, AgentConfig> {
  return loadMergedAgentConfigsWithDiagnostics(baseAgentsDir, overrideAgentsDir)
    .configs;
}

export function formatAgentGuidelines(
  agentConfigs: Map<string, AgentConfig>,
): string[] {
  if (agentConfigs.size === 0) return ["subagent has no configured agents."];

  return [...agentConfigs.values()].map((config) =>
    config.description
      ? `subagent ${config.name}: ${config.description}`
      : `subagent ${config.name}.`,
  );
}

export function formatInvalidAgentFilesWarning(
  invalidFiles: InvalidAgentConfig[],
): string {
  const lines = invalidFiles.map(
    (invalid) => `- ${invalid.filePath}: ${invalid.reason}`,
  );
  return ["Invalid subagent files were skipped:", ...lines].join("\n");
}
