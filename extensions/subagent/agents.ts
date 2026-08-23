import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, Effort } from "./types.ts";
import { EFFORTS } from "./types.ts";

export interface InvalidAgentConfig {
  filePath: string;
  reason: string;
}

export interface AgentConfigLoadResult {
  configs: Map<string, AgentConfig>;
  invalidFiles: InvalidAgentConfig[];
}

export interface AgentModelReference {
  provider: string;
  id: string;
}

export class AgentConfigValidationError extends Error {
  readonly filePath: string;

  constructor(message: string, filePath: string) {
    super(message);
    this.name = "AgentConfigValidationError";
    this.filePath = filePath;
  }
}

/** What a rejected frontmatter value is, for a diagnostic that names it. */
function describeType(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a map";
  return `a ${typeof value}`;
}

/**
 * A frontmatter field as a trimmed string, or `undefined` when absent or empty.
 *
 * YAML types the value, and nothing constrains an author to a string:
 * `model: []` parses to an array. Rejecting it here is what turns
 * `raw?.trim is not a function` into a diagnostic naming the field.
 */
function stringField(
  raw: unknown,
  field: string,
  filePath: string,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new AgentConfigValidationError(
      `${field} must be a string, not ${describeType(raw)}`,
      filePath,
    );
  }
  return raw.trim() || undefined;
}

/**
 * A frontmatter field as a boolean, or `undefined` when absent. A non-boolean
 * is rejected rather than treated as absent and silently given the field's
 * default.
 */
function booleanField(
  raw: unknown,
  field: string,
  filePath: string,
): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new AgentConfigValidationError(
      `${field} must be true or false, not ${describeType(raw)}`,
      filePath,
    );
  }
  return raw;
}

/** Reasoning depth, validated against the closed scale so a typo is an error. */
function parseEffort(
  raw: string | undefined,
  filePath: string,
): Effort | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw new AgentConfigValidationError(
      `unknown effort '${value}'; expected one of ${EFFORTS.join(", ")}`,
      filePath,
    );
  }
  return value as Effort;
}

export function parseAgentConfig(filePath: string): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  // Every field is `unknown`: these are YAML values, not strings, and each one
  // is narrowed by the parser that reads it.
  const { frontmatter, body } = parseFrontmatter<{
    description?: unknown;
    model?: unknown;
    effort?: unknown;
    tools?: unknown;
    appendSystemPrompt?: unknown;
  }>(content);
  const description = stringField(
    frontmatter.description,
    "description",
    filePath,
  );
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
  const tools = stringField(frontmatter.tools, "tools", filePath);
  const model = stringField(frontmatter.model, "model", filePath);
  const effort = parseEffort(
    stringField(frontmatter.effort, "effort", filePath),
    filePath,
  );
  const appendSystemPrompt = booleanField(
    frontmatter.appendSystemPrompt,
    "appendSystemPrompt",
    filePath,
  );
  return {
    name: path.basename(filePath, path.extname(filePath)),
    description,
    model,
    ...(tools ? { tools } : {}),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    systemPrompt,
    ...(effort ? { effort } : {}),
  };
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

/**
 * Reject pinned models that are absent from Pi's already-loaded catalogue.
 *
 * Both `provider/model-id` and an unambiguous bare model id are accepted by
 * Pi's CLI, so the diagnostic recognizes both exact forms. Model matching is
 * case-insensitive, like `pi --model`. Profiles without a pinned model inherit
 * the caller's model and need no catalogue check.
 */
export function diagnoseAgentModels(
  configs: ReadonlyMap<string, AgentConfig>,
  agentsDir: string,
  models: readonly AgentModelReference[],
): AgentConfigLoadResult {
  const knownModels = new Set<string>();
  for (const model of models) {
    knownModels.add(model.id.toLowerCase());
    knownModels.add(`${model.provider}/${model.id}`.toLowerCase());
  }

  const validConfigs = new Map<string, AgentConfig>();
  const invalidFiles: InvalidAgentConfig[] = [];
  for (const [name, config] of configs) {
    if (config.model && !knownModels.has(config.model.toLowerCase())) {
      invalidFiles.push({
        filePath: path.join(agentsDir, `${name}.md`),
        reason: `model '${config.model}' was not found in Pi's model catalogue`,
      });
      continue;
    }
    validConfigs.set(name, config);
  }
  return { configs: validConfigs, invalidFiles };
}

/**
 * The one directory agents are read from.
 *
 * User scope only, deliberately. A project directory cannot contribute agent
 * profiles: a profile carries a system prompt, a model, and a tool list, and
 * its description is injected into the calling model's tool guidelines, so
 * honouring repository-controlled profiles would let a checkout shape what the
 * delegating session does and says. Nothing in a working directory is read
 * here, so there is no trust question to answer.
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
