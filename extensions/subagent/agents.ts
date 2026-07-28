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
import { buildSkillPaths } from "./skills.ts";
import type {
  AgentConfig,
  AgentSource,
  Harness,
  ReasoningEffort,
} from "./types.ts";
import {
  DEFAULT_HARNESS,
  HARNESSES,
  PLANNED_HARNESSES,
  REASONING_EFFORTS,
} from "./types.ts";

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

function oneOf(values: readonly string[]): string {
  return values.join(", ");
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
 * `harness: []` parses to an array. Rejecting it here is what turns
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
 * is rejected rather than read as false: `appendSystemPrompt: "yes"` means the
 * opposite of what it silently would have done.
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

function parseHarness(raw: string | undefined, filePath: string): Harness {
  const value = raw?.trim();
  if (!value) return DEFAULT_HARNESS;
  if ((HARNESSES as readonly string[]).includes(value)) return value as Harness;
  if ((PLANNED_HARNESSES as readonly string[]).includes(value)) {
    throw new AgentConfigValidationError(
      `harness '${value}' is not supported yet; this version supports ${oneOf(HARNESSES)}`,
      filePath,
    );
  }
  throw new AgentConfigValidationError(
    `unknown harness '${value}'; expected one of ${oneOf(HARNESSES)}`,
    filePath,
  );
}

/**
 * Reasoning depth, as its own validated field.
 *
 * A closed scale in a field of its own is the only shape that can catch a typo.
 * Carried as a `:<effort>` suffix on the model it could not: nothing
 * distinguishes a misspelled effort from a variant suffix a provider really uses,
 * so `opus:turbo` had to be read as a model id.
 */
function parseEffort(
  raw: string | undefined,
  filePath: string,
): ReasoningEffort | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new AgentConfigValidationError(
      `unknown effort '${value}'; expected one of ${oneOf(REASONING_EFFORTS)}`,
      filePath,
    );
  }
  return value as ReasoningEffort;
}

/** Point the old name at the new one rather than ignoring it. */
function rejectReasoningEffort(raw: unknown, filePath: string): void {
  if (raw === undefined || raw === null) return;
  throw new AgentConfigValidationError(
    `reasoningEffort is now called effort`,
    filePath,
  );
}

/**
 * Reject an effort suffix on the model.
 *
 * The model reaches the harness exactly as written — no provider stripping, no
 * suffix splitting — so a `:high` it carries would land as part of the id. Only a
 * trailing segment that *is* an effort is rejected; a provider's own variant
 * suffix (`google/gemma-4-31b-it:free`) or version (`…-v1:0`) is none of this
 * function's business.
 */
function assertNoEffortSuffix(
  model: string | undefined,
  filePath: string,
): void {
  if (!model) return;
  const colon = model.lastIndexOf(":");
  if (colon === -1) return;
  const suffix = model.slice(colon + 1);
  if (!(REASONING_EFFORTS as readonly string[]).includes(suffix)) return;
  throw new AgentConfigValidationError(
    `model is passed to the harness as written; set 'effort: ${suffix}' instead of the ':${suffix}' suffix`,
    filePath,
  );
}

/**
 * Reject a field the profile cannot control on this harness.
 *
 * Delegating to another harness means letting it work the way it works: a
 * claude subagent runs Claude Code's own tools and its own skills, and the
 * extension configures neither. Accepting the field and quietly not honoring it
 * is the misreading most likely to matter — an author would believe they had
 * built a read-only agent, or pinned its skill set, and be wrong.
 */
function assertPiOnlyField(
  field: string,
  detail: string,
  harness: Harness,
  filePath: string,
): void {
  if (harness === "pi") return;
  throw new AgentConfigValidationError(
    `${field} is only supported on harness 'pi'; harness '${harness}' ${detail}`,
    filePath,
  );
}

function parseTools(
  raw: string | undefined,
  harness: Harness,
  filePath: string,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  assertPiOnlyField(
    "tools",
    "runs with a fixed tool set this backend controls",
    harness,
    filePath,
  );
  return value;
}

function parseSkills(
  raw: string | undefined,
  harness: Harness,
  filePath: string,
): string[] | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  assertPiOnlyField("skills", "manages its own skills", harness, filePath);
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : undefined;
}

export function parseAgentConfig(
  filePath: string,
  source?: AgentSource,
): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  // Every field is `unknown`: these are YAML values, not strings, and each one
  // is narrowed by the parser that reads it.
  const { frontmatter, body } = parseFrontmatter<{
    description?: unknown;
    harness?: unknown;
    model?: unknown;
    effort?: unknown;
    reasoningEffort?: unknown;
    tools?: unknown;
    appendSystemPrompt?: unknown;
    skills?: unknown;
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
  const harness = parseHarness(
    stringField(frontmatter.harness, "harness", filePath),
    filePath,
  );
  const tools = parseTools(
    stringField(frontmatter.tools, "tools", filePath),
    harness,
    filePath,
  );
  const model = stringField(frontmatter.model, "model", filePath);
  assertNoEffortSuffix(model, filePath);
  rejectReasoningEffort(frontmatter.reasoningEffort, filePath);
  const effort = parseEffort(
    stringField(frontmatter.effort, "effort", filePath),
    filePath,
  );
  const skills = parseSkills(
    stringField(frontmatter.skills, "skills", filePath),
    harness,
    filePath,
  );
  return {
    name: path.basename(filePath, path.extname(filePath)),
    description,
    harness,
    model,
    ...(tools ? { tools } : {}),
    appendSystemPrompt:
      booleanField(
        frontmatter.appendSystemPrompt,
        "appendSystemPrompt",
        filePath,
      ) === true,
    systemPrompt,
    ...(effort ? { effort } : {}),
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
