import type {
  RunControl,
  SubagentContext,
  SubagentExecutor,
  SubagentTask,
} from "../run.ts";
import { type AgentConfig, DEFAULT_HARNESS_NAME, EFFORTS } from "../types.ts";

export interface HarnessDiagnostic {
  reason: string;
}

export interface HarnessValidationContext {
  /** Available models; omission is treated as an empty catalogue. */
  models?: readonly { provider: string; id: string }[];
}

export interface HarnessCapabilities {
  /** Whether this adapter can continue its private Conversation in a later Run. */
  readonly resume: boolean;
}

/** One independently prepared execution on a Subagent-scoped adapter. */
export interface HarnessRun {
  execute: SubagentExecutor;
  /** Neutral Controls this prepared Run can consume through its executor. */
  supportedControls: readonly RunControl["type"][];
}

/**
 * One prepared Subagent adapter. Provider Conversation state may live only in
 * this instance and is never returned through the neutral contract.
 */
export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;
  /** Display metadata resolved once from the Subagent's fixed policy. */
  readonly model?: string;
  prepareRun(task: SubagentTask): HarnessRun;
  /** Release adapter-owned state. Safe to await more than once. */
  close(): Promise<void>;
}

/**
 * The public Harness factory seam for Subagent-scoped execution.
 *
 * @see ../../../docs/harness-definition-of-done.md
 * @see ../../../docs/adr/0007-harness-seam-with-neutral-facts.md
 */
export interface Harness {
  readonly name: string;
  /**
   * Validate profile shape and adapter policy. Omitted runtime context carries
   * no catalogue entries, so adapters may diagnose pinned models as unknown.
   */
  validate(
    profile: AgentConfig,
    filePath: string,
    context?: HarnessValidationContext,
  ): HarnessDiagnostic[];
  prepare(context: SubagentContext): HarnessAdapter;
}

export interface HarnessRegistry {
  get(name: string): Harness | undefined;
  validate(
    profile: AgentConfig,
    filePath: string,
    context?: HarnessValidationContext,
  ): HarnessDiagnostic[];
}

interface CommonProfileFieldValidationOptions {
  /** Name used in diagnostics, not the registry key. */
  readonly displayName: string;
  readonly validateModel?: (
    model: string | undefined,
  ) => HarnessDiagnostic | undefined;
}

export function createHarnessRegistry(
  harnesses: readonly Harness[],
): HarnessRegistry {
  const byName = new Map(harnesses.map((harness) => [harness.name, harness]));
  return {
    get: (name) => byName.get(name),
    validate(profile, filePath, context) {
      const name = profile.harness ?? DEFAULT_HARNESS_NAME;
      const harness = byName.get(name);
      if (!harness) {
        return [{ reason: `unknown harness '${name}'` }];
      }
      return harness.validate(profile, filePath, context);
    },
  };
}

/** Shared profile-field helpers used by both validation and execution. */
export function stringField(
  profile: AgentConfig,
  field: string,
  filePath: string,
): string | undefined {
  const raw = profile.fields?.[field] ?? profile[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`${field} must be a string in ${filePath}`);
  }
  return raw.trim() || undefined;
}

function booleanField(
  profile: AgentConfig,
  field: string,
  filePath: string,
): boolean | undefined {
  const raw = profile.fields?.[field] ?? profile[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new Error(`${field} must be true or false in ${filePath}`);
  }
  return raw;
}

export function effortField(
  profile: AgentConfig,
  filePath: string,
  allowed: readonly string[],
): string | undefined {
  const value = stringField(profile, "effort", filePath);
  if (value && !allowed.includes(value)) {
    throw new Error(
      `unknown effort '${value}'; expected one of ${allowed.join(", ")}`,
    );
  }
  return value;
}

function unknownFields(
  profile: AgentConfig,
  recognized: readonly string[],
): string[] {
  const allowed = new Set(recognized);
  return Object.keys(profile.fields ?? {}).filter(
    (field) => !allowed.has(field),
  );
}

// Add a fifth common profile field here and validate/access it below; shared
// profile vocabulary remains a one-module change rather than an adapter sweep.
const COMMON_PROFILE_FIELDS = [
  "model",
  "effort",
  "tools",
  "appendSystemPrompt",
] as const;

/** Parse the one user-facing comma-separated tools syntax for every harness. */
export function parseTools(
  profile: AgentConfig,
  filePath: string,
): string[] | undefined {
  const value = stringField(profile, "tools", filePath);
  if (value === undefined) return undefined;
  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  // `[]` is meaningful: passing an explicitly empty list disables tools;
  // converting it to undefined would silently restore the backend defaults.
  return tools;
}

/** Profiles append the native system prompt unless they explicitly opt out. */
export function shouldAppendSystemPrompt(
  profile: AgentConfig,
  filePath: string,
): boolean {
  return booleanField(profile, "appendSystemPrompt", filePath) !== false;
}

/**
 * Validate the four shared fields, then let each harness apply its own model
 * rule. Adapter-specific vocabulary remains adapter-owned rather than forming
 * a central config union.
 */
export function validateCommonProfileFields(
  profile: AgentConfig,
  filePath: string,
  options: CommonProfileFieldValidationOptions,
): HarnessDiagnostic[] {
  const diagnostics: HarnessDiagnostic[] = unknownFields(
    profile,
    COMMON_PROFILE_FIELDS,
  ).map((field) => ({
    reason: `${options.displayName} harness does not recognize field '${field}'`,
  }));

  try {
    const model = stringField(profile, "model", filePath);
    // These calls validate field types and values; execution reads them again.
    effortField(profile, filePath, EFFORTS);
    parseTools(profile, filePath);
    shouldAppendSystemPrompt(profile, filePath);
    const modelDiagnostic = options.validateModel?.(model);
    if (modelDiagnostic) diagnostics.push(modelDiagnostic);
  } catch (error) {
    diagnostics.push({
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return diagnostics;
}
