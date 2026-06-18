import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildSkillPaths } from "./runner.ts";
import type { AgentConfig, AgentSource } from "./types.ts";

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

export function parseAgentConfig(
  filePath: string,
  source?: AgentSource,
): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<{
    description?: string;
    model?: string;
    tools?: string;
    appendSystemPrompt?: boolean;
    skills?: string;
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
  const skills = frontmatter.skills
    ? frontmatter.skills
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;
  return {
    name: path.basename(filePath, path.extname(filePath)),
    description,
    model: frontmatter.model,
    tools: frontmatter.tools,
    appendSystemPrompt: frontmatter.appendSystemPrompt === true,
    systemPrompt,
    ...(skills ? { skills } : {}),
    ...(source ? { source } : {}),
  };
}

export function getDefaultAgentsDir(moduleUrl: string): string {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), "../../agents");
}

export function loadAgentConfigsWithDiagnostics(
  agentsDir: string,
  source: AgentSource = "default",
): AgentConfigLoadResult {
  const configs = new Map<string, AgentConfig>();
  const invalidFiles: InvalidAgentConfig[] = [];
  if (!fs.existsSync(agentsDir)) return { configs, invalidFiles };
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(agentsDir, file);
    try {
      const config = parseAgentConfig(filePath, source);
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

export function loadAgentConfigs(
  agentsDir: string,
  source: AgentSource = "default",
): Map<string, AgentConfig> {
  return loadAgentConfigsWithDiagnostics(agentsDir, source).configs;
}

export interface AgentLayer {
  dir: string;
  source: AgentSource;
}

export interface PackageAgentPackage {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

function resolveExistingPath(filePath: string): string {
  return fs.existsSync(filePath)
    ? fs.realpathSync.native(filePath)
    : path.resolve(filePath);
}

export function buildPackageAgentLayers(
  packages: PackageAgentPackage[],
): AgentLayer[] {
  return packages.flatMap((pkg) => {
    if (typeof pkg.installedPath !== "string") return [];

    const agentsDir = path.join(pkg.installedPath, "agents");
    if (!fs.existsSync(agentsDir)) return [];

    return [{ dir: agentsDir, source: "package" as const }];
  });
}

export function getInstalledPackageAgentLayers(
  cwd: string,
  agentDir = getAgentDir(),
): AgentLayer[] {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });

  return buildPackageAgentLayers(packageManager.listConfiguredPackages());
}

export function buildAgentConfigLayers(
  projectCwd: string,
  agentDir: string,
  moduleUrl: string,
  configCwd = projectCwd,
  packageLayers: AgentLayer[] = getInstalledPackageAgentLayers(
    configCwd,
    agentDir,
  ),
): AgentLayer[] {
  const defaultAgentsDir = getDefaultAgentsDir(moduleUrl);
  const resolvedDefaultAgentsDir = resolveExistingPath(defaultAgentsDir);
  const deduplicatedPackageLayers = packageLayers.filter(
    (layer) => resolveExistingPath(layer.dir) !== resolvedDefaultAgentsDir,
  );

  return [
    { dir: defaultAgentsDir, source: "default" },
    ...deduplicatedPackageLayers,
    { dir: path.join(agentDir, "agents"), source: "user" },
    { dir: path.join(configCwd, ".pi", "agents"), source: "project" },
  ];
}

export function loadLayeredAgentConfigsWithDiagnostics(
  layers: AgentLayer[],
): AgentConfigLoadResult {
  const configs = new Map<string, AgentConfig>();
  const invalidFiles: InvalidAgentConfig[] = [];
  for (const layer of layers) {
    const result = loadAgentConfigsWithDiagnostics(layer.dir, layer.source);
    for (const [name, config] of result.configs) {
      configs.set(name, config);
    }
    invalidFiles.push(...result.invalidFiles);
  }
  return { configs, invalidFiles };
}

export function loadLayeredAgentConfigs(
  layers: AgentLayer[],
): Map<string, AgentConfig> {
  return loadLayeredAgentConfigsWithDiagnostics(layers).configs;
}

export function loadMergedAgentConfigsWithDiagnostics(
  baseAgentsDir: string,
  overrideAgentsDir: string,
): AgentConfigLoadResult {
  return loadLayeredAgentConfigsWithDiagnostics([
    { dir: baseAgentsDir, source: "default" },
    { dir: overrideAgentsDir, source: "user" },
  ]);
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

export function validateAgentSkills(
  configs: Map<string, AgentConfig>,
  cwd: string,
  agentDir = getAgentDir(),
): string[] {
  const skillPaths = buildSkillPaths(cwd, agentDir);
  const { skills: discovered } = loadSkills({
    cwd,
    agentDir,
    skillPaths,
    includeDefaults: false,
  });
  const availableNames = new Set(discovered.map((s) => s.name));
  const warnings: string[] = [];

  for (const [, config] of configs) {
    if (!config.skills) continue;
    const missing = config.skills.filter((name) => !availableNames.has(name));
    if (missing.length > 0) {
      warnings.push(
        `Agent '${config.name}': unknown skills: ${missing.join(", ")}`,
      );
    }
  }

  return warnings;
}

export function formatInvalidAgentFilesWarning(
  invalidFiles: InvalidAgentConfig[],
): string {
  const lines = invalidFiles.map(
    (invalid) => `- ${invalid.filePath}: ${invalid.reason}`,
  );
  return ["Invalid subagent files were skipped:", ...lines].join("\n");
}
