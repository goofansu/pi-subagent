import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentSource, Effort, Harness } from "./types.ts";
import {
  DEFAULT_APPEND_SYSTEM_PROMPT,
  DEFAULT_HARNESS,
  EFFORTS,
  HARNESSES,
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

function parseHarness(raw: string | undefined, filePath: string): Harness {
  const value = raw?.trim();
  if (!value) return DEFAULT_HARNESS;
  if ((HARNESSES as readonly string[]).includes(value)) return value as Harness;
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
): Effort | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw new AgentConfigValidationError(
      `unknown effort '${value}'; expected one of ${oneOf(EFFORTS)}`,
      filePath,
    );
  }
  return value as Effort;
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
  if (!(EFFORTS as readonly string[]).includes(suffix)) return;
  throw new AgentConfigValidationError(
    `model is passed to the harness as written; set 'effort: ${suffix}' instead of the ':${suffix}' suffix`,
    filePath,
  );
}

/**
 * Reject a field the profile cannot control on this harness.
 *
 * Delegating to another harness means letting it work the way it works: an
 * external subagent runs its harness's own tools, and the extension does not
 * configure them. Accepting the field and quietly not honoring it is the
 * misreading most likely to matter — an author would believe they had built a
 * read-only agent and be wrong.
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
  const effort = parseEffort(
    stringField(frontmatter.effort, "effort", filePath),
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
      ) ?? DEFAULT_APPEND_SYSTEM_PROMPT,
    systemPrompt,
    ...(effort ? { effort } : {}),
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
  projectTrusted = false,
): AgentLayer[] {
  return packages.flatMap((pkg) => {
    if (pkg.scope === "project" && !projectTrusted) return [];
    if (typeof pkg.installedPath !== "string") return [];

    const agentsDir = path.join(pkg.installedPath, "agents");
    if (!fs.existsSync(agentsDir)) return [];

    return [{ dir: agentsDir, source: "package" as const }];
  });
}

export function getInstalledPackageAgentLayers(
  cwd: string,
  agentDir = getAgentDir(),
  projectTrusted = false,
): AgentLayer[] {
  // SettingsManager itself must receive the effective session decision. Merely
  // filtering its result would still read configuration from an untrusted
  // checkout.
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });

  return buildPackageAgentLayers(
    packageManager.listConfiguredPackages(),
    projectTrusted,
  );
}

export function buildAgentConfigLayers(
  projectCwd: string,
  agentDir: string,
  moduleUrl: string,
  configCwd = projectCwd,
  projectTrusted = false,
  packageLayers: AgentLayer[] = getInstalledPackageAgentLayers(
    configCwd,
    agentDir,
    projectTrusted,
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
    ...(projectTrusted
      ? [
          {
            dir: path.join(configCwd, ".pi", "agents"),
            source: "project" as const,
          },
        ]
      : []),
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

export function formatInvalidAgentFilesWarning(
  invalidFiles: InvalidAgentConfig[],
): string {
  const lines = invalidFiles.map(
    (invalid) => `- ${invalid.filePath}: ${invalid.reason}`,
  );
  return ["Invalid subagent files were skipped:", ...lines].join("\n");
}
