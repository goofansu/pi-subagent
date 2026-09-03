/**
 * Claude Profile validation, and the model and effort a Run is built with.
 *
 * Ported from v1's Claude Profile rules with the behaviour unchanged, because
 * a Profile that validated under v1 has to keep validating: the migration v2
 * asks a Profile author for is a renamed field, not a re-read of every rule.
 *
 * One rule is Claude's own, and everything else is the shared field
 * vocabulary:
 *
 * - **A pinned model must be a family alias.** The SDK documents four aliases
 *   and resolves each to its family's current default itself, so no local
 *   alias-to-id map and no full-id allowlist is kept — both went stale in
 *   practice as models shipped. A full or dated id would need such an
 *   allowlist to validate deterministically at Session start, and a Profile
 *   here always wants the current model of a family.
 * - **The diagnostic names the aliases**, so a typo is answered with the
 *   alternatives rather than with "not found".
 *
 * The alias is passed through **unresolved**, lowercased. Which concrete model
 * the family resolves to is the provider's answer, and it arrives on the init
 * frame as the Run's `model` observation — authoritative over anything guessed
 * here.
 *
 * Nothing in this module reads the validation context. Claude's model rule is
 * a fixed list rather than a Session catalogue, which is exactly why model
 * validation stayed with the backend instead of becoming a central union.
 */

import type { Profile, ProfileDiagnostic } from "../../domain/index.ts";
import {
  EFFORTS,
  effortField,
  stringField,
  validateCommonProfileFields,
} from "../profile-fields.ts";

/** How diagnostics name this backend. Not its `BackendId`. */
export const CLAUDE_DISPLAY_NAME = "Claude";

/**
 * The families a Profile may name.
 *
 * The SDK resolves each of these to the family's current default id, so a
 * Profile that names one does not go stale as models ship.
 */
export const CLAUDE_MODEL_ALIASES: readonly string[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
];

/** Whether a written model names one of the families, however it was cased. */
export function isClaudeModelAlias(value: string): boolean {
  return CLAUDE_MODEL_ALIASES.includes(value.toLowerCase());
}

/** Why a pinned model cannot be used, or nothing when it can. */
export function modelProblem(model: string | undefined): string | undefined {
  if (!model || isClaudeModelAlias(model)) return undefined;
  return `invalid Claude model '${model}' (expected one of: ${CLAUDE_MODEL_ALIASES.join(", ")})`;
}

/** Every diagnostic this Profile earns, deterministically. */
export function validateClaudeProfile(
  profile: Profile,
  filePath: string,
): readonly ProfileDiagnostic[] {
  return validateCommonProfileFields(profile, filePath, {
    displayName: CLAUDE_DISPLAY_NAME,
    validateModel: modelProblem,
  });
}

/** The family alias and effort one Subagent's Queries are built with. */
export interface ClaudeModelChoice {
  /** The alias, lowercased and unresolved. The SDK resolves the family. */
  readonly model?: string;
  readonly effort?: string;
}

/**
 * Read the model and effort once, at `open`, from the Profile alone.
 *
 * Deliberately **not** inherited from the parent, which is where this differs
 * from Pi. Pi's model reference and Pi's thinking level are the same
 * vocabulary the parent session speaks, so a Profile that pins neither can
 * sensibly borrow both. A parent running `openai-codex/gpt-5.6-sol` has no
 * Claude family to lend, so a Profile that names none leaves the SDK's own
 * default — which is v1's behaviour and the only honest one.
 */
export function resolveClaudeModel(profile: Profile): ClaudeModelChoice {
  const pinned = stringField(profile, "model")?.toLowerCase();
  const effort = effortField(profile, EFFORTS);
  return {
    ...(pinned === undefined ? {} : { model: pinned }),
    ...(effort === undefined ? {} : { effort }),
  };
}
