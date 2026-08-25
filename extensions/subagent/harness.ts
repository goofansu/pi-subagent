import type { SubagentExecutor, SubagentTask } from "./run.ts";
import type { AgentConfig } from "./types.ts";

/** The parent model context, intentionally opaque to the dispatcher. */
export interface ParentModel {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

export interface HarnessDiagnostic {
  reason: string;
}

export interface HarnessValidationContext {
  models?: readonly { provider: string; id: string }[];
}

export interface HarnessRun {
  execute: SubagentExecutor;
  /** Display metadata resolved in the harness's own vocabulary. */
  model?: string;
  effort?: string;
}

export interface Harness {
  readonly name: string;
  validate(
    profile: AgentConfig,
    filePath: string,
    context?: HarnessValidationContext,
  ): HarnessDiagnostic[];
  prepare(task: SubagentTask, parentModel?: ParentModel): HarnessRun;
}

export interface HarnessRegistry {
  get(name: string): Harness | undefined;
  validate(
    profile: AgentConfig,
    filePath: string,
    context?: HarnessValidationContext,
  ): HarnessDiagnostic[];
  names(): readonly string[];
}

export function createHarnessRegistry(
  harnesses: readonly Harness[],
): HarnessRegistry {
  const byName = new Map(harnesses.map((harness) => [harness.name, harness]));
  return {
    get: (name) => byName.get(name),
    validate(profile, filePath, context) {
      const name = profile.harness ?? "pi";
      const harness = byName.get(name);
      if (!harness) {
        return [{ reason: `unknown harness '${name}'` }];
      }
      return harness.validate(profile, filePath, context);
    },
    names: () => [...byName.keys()],
  };
}

/** Shared profile-field helpers used only by adapters while validating. */
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

export function booleanField(
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

export function unknownFields(
  profile: AgentConfig,
  recognized: readonly string[],
): string[] {
  const allowed = new Set(recognized);
  return Object.keys(profile.fields ?? {}).filter(
    (field) => !allowed.has(field),
  );
}
