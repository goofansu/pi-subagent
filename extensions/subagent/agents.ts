import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { HarnessRegistry } from "./harness.ts";
import type { AgentConfig } from "./types.ts";

export interface InvalidAgentConfig {
  filePath: string;
  reason: string;
}

export interface AgentConfigLoadResult {
  configs: Map<string, AgentConfig>;
  invalidFiles: InvalidAgentConfig[];
}

export class AgentConfigValidationError extends Error {
  readonly filePath: string;

  constructor(message: string, filePath: string) {
    super(message);
    this.name = "AgentConfigValidationError";
    this.filePath = filePath;
  }
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object" && value !== null) return "a map";
  return `a ${typeof value}`;
}

function requiredDescription(raw: unknown, filePath: string): string {
  if (raw === undefined || raw === null || raw === "") {
    throw new AgentConfigValidationError(
      "missing required description frontmatter",
      filePath,
    );
  }
  if (typeof raw !== "string") {
    throw new AgentConfigValidationError(
      `description must be a string, not ${describeType(raw)}`,
      filePath,
    );
  }
  const value = raw.trim();
  if (!value) {
    throw new AgentConfigValidationError(
      "missing required description frontmatter",
      filePath,
    );
  }
  return value;
}

function stringField(raw: unknown, field: string, filePath: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new AgentConfigValidationError(
      `${field} must be a non-empty string`,
      filePath,
    );
  }
  return raw.trim();
}

/**
 * Parse only the common profile vocabulary. All other frontmatter survives as
 * opaque fields for the named harness to validate and interpret.
 */
export function parseAgentConfig(filePath: string): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } =
    parseFrontmatter<Record<string, unknown>>(content);
  const description = requiredDescription(frontmatter.description, filePath);
  const harness =
    frontmatter.harness === undefined
      ? "pi"
      : stringField(frontmatter.harness, "harness", filePath);
  const systemPrompt = body.trim();
  if (!systemPrompt) {
    throw new AgentConfigValidationError(
      "missing required prompt body",
      filePath,
    );
  }
  const fields = Object.fromEntries(
    Object.entries(frontmatter).filter(
      ([field]) => field !== "description" && field !== "harness",
    ),
  );
  return {
    name: path.basename(filePath, path.extname(filePath)),
    description,
    harness,
    fields,
    systemPrompt,
  };
}

export function loadAgentConfigsWithDiagnostics(
  agentsDir: string,
  harnesses?: HarnessRegistry,
  validationContext?: { models?: readonly { provider: string; id: string }[] },
): AgentConfigLoadResult {
  const configs = new Map<string, AgentConfig>();
  const invalidFiles: InvalidAgentConfig[] = [];
  if (!fs.existsSync(agentsDir)) return { configs, invalidFiles };
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(agentsDir, file);
    try {
      const config = parseAgentConfig(filePath);
      if (harnesses) {
        const diagnostics = harnesses.validate(
          config,
          filePath,
          validationContext,
        );
        if (diagnostics.length > 0) {
          invalidFiles.push(
            ...diagnostics.map((diagnostic) => ({
              filePath,
              reason: diagnostic.reason,
            })),
          );
          continue;
        }
      }
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

/**
 * The one directory agents are read from.
 *
 * User scope only, deliberately. A profile carries a system prompt, a model,
 * and a tool list, and its description is injected into the calling model's
 * tool guidelines, so honouring repository-controlled profiles would let a
 * checkout shape what the delegating session does and says. Nothing in a
 * working directory is read here, so there is no trust question to answer.
 */
export function getAgentsDir(agentDir: string): string {
  return path.join(agentDir, "agents");
}

export function formatAgentGuidelines(
  agentConfigs: Map<string, AgentConfig>,
): string[] {
  if (agentConfigs.size === 0) return ["agent_start has no configured agents."];
  return [...agentConfigs.values()].map(
    (config) => `agent_start ${config.name}: ${config.description}`,
  );
}

export function formatInvalidAgentFilesWarning(
  invalidFiles: InvalidAgentConfig[],
): string {
  const lines = invalidFiles.map((invalid) => {
    const agentName = path.basename(
      invalid.filePath,
      path.extname(invalid.filePath),
    );
    return `- ${agentName}: ${invalid.reason}`;
  });
  return ["Invalid subagents were skipped:", ...lines].join("\n");
}
