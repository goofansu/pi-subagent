/**
 * The Profile fields every backend understands, and the helpers that read them.
 *
 * Four fields are shared vocabulary: `model`, `effort`, `tools`, and
 * `appendSystemPrompt`. They are shared because a Profile author expects them
 * to mean the same thing whichever backend runs the Profile, so they are
 * parsed and validated in one place. Everything else in a Profile's fields is
 * the named backend's own vocabulary.
 *
 * This is the field knowledge from v1's backend-seam contract module, ported:
 * the same seven-value effort scale, the same comma-separated tools syntax, the
 * same "append unless explicitly opted out" rule, and the same
 * unrecognized-field diagnostic — with that diagnostic reworded for v2's
 * vocabulary. Adding a fifth shared field is a change to this module and
 * nothing else.
 *
 * The accessors throw rather than returning diagnostics because execution
 * reads them too, and an execution that has already been validated should not
 * have to re-handle a diagnostic. {@link validateCommonProfileFields} is the
 * one place that catches, so validation stays deterministic and total.
 */

import type { Profile, ProfileDiagnostic } from "../domain/index.ts";

/** The shared seven-value effort scale, unchanged from v1. */
export const EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type Effort = (typeof EFFORTS)[number];

/**
 * The shared field vocabulary. Add a fifth field here and read it below;
 * shared Profile vocabulary stays a one-module change rather than a sweep
 * across every adapter.
 */
export const COMMON_PROFILE_FIELDS = [
  "model",
  "effort",
  "tools",
  "appendSystemPrompt",
] as const;

export class ProfileFieldError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ProfileFieldError";
    this.field = field;
  }
}

export function stringField(
  profile: Profile,
  field: string,
): string | undefined {
  const raw = profile.fields[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new ProfileFieldError(field, `${field} must be a string`);
  }
  return raw.trim() || undefined;
}

export function booleanField(
  profile: Profile,
  field: string,
): boolean | undefined {
  const raw = profile.fields[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new ProfileFieldError(field, `${field} must be true or false`);
  }
  return raw;
}

/**
 * Read `effort`, checking it against the scale the backend supports.
 *
 * A backend that supports a subset passes its own list: the scale is shared,
 * but which values a given provider can actually express is not.
 */
export function effortField(
  profile: Profile,
  allowed: readonly string[] = EFFORTS,
): string | undefined {
  const value = stringField(profile, "effort");
  if (value && !allowed.includes(value)) {
    throw new ProfileFieldError(
      "effort",
      `unknown effort '${value}'; expected one of ${allowed.join(", ")}`,
    );
  }
  return value;
}

/** The one user-facing comma-separated tools syntax, shared by every backend. */
export function parseTools(profile: Profile): string[] | undefined {
  const value = stringField(profile, "tools");
  if (value === undefined) return undefined;
  // `[]` is meaningful: an explicitly empty list disables tools, and turning
  // it into `undefined` would silently restore the backend's defaults.
  return value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Profiles append the native system prompt unless they explicitly opt out. */
export function shouldAppendSystemPrompt(profile: Profile): boolean {
  return booleanField(profile, "appendSystemPrompt") !== false;
}

/** Fields the named backend has no meaning for. */
export function unrecognizedFields(
  profile: Profile,
  recognized: readonly string[],
): string[] {
  const allowed = new Set(recognized);
  return Object.keys(profile.fields).filter((field) => !allowed.has(field));
}

export interface CommonProfileFieldOptions {
  /** How diagnostics name the backend. Not necessarily its `BackendId`. */
  readonly displayName: string;
  /** Every field this backend understands beyond the shared four. */
  readonly ownFields?: readonly string[];
  /**
   * The backend's own model rule. Model validation is genuinely
   * provider-specific — one backend checks a loaded catalogue, another a
   * family-alias list — so it stays with the backend rather than becoming a
   * central union.
   */
  readonly validateModel?: (model: string | undefined) => string | undefined;
}

/**
 * Validate the shared fields, then let the backend apply its own model rule.
 *
 * Deterministic and total: the same Profile always yields the same
 * diagnostics, and nothing escapes as an exception.
 */
export function validateCommonProfileFields(
  profile: Profile,
  filePath: string,
  options: CommonProfileFieldOptions,
): ProfileDiagnostic[] {
  const recognized = [...COMMON_PROFILE_FIELDS, ...(options.ownFields ?? [])];
  const diagnostics: ProfileDiagnostic[] = unrecognizedFields(
    profile,
    recognized,
  ).map((field) => ({
    filePath,
    reason: `${options.displayName} backend does not recognize field '${field}'`,
  }));

  try {
    const model = stringField(profile, "model");
    // These calls validate field types and values; execution reads them again.
    effortField(profile);
    parseTools(profile);
    shouldAppendSystemPrompt(profile);
    const modelProblem = options.validateModel?.(model);
    if (modelProblem) diagnostics.push({ filePath, reason: modelProblem });
  } catch (error) {
    diagnostics.push({
      filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return diagnostics;
}
