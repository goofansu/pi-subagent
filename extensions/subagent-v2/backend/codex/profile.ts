/**
 * Codex Profile validation, and the model, effort, and prompt a Turn is built
 * with.
 *
 * Ported from v1's Codex Profile rules with the behaviour unchanged, because a
 * Profile that validated under v1 has to keep validating: the migration v2
 * asks a Profile author for is a renamed field, not a re-read of every rule.
 *
 * Two of those rules are Codex's own, and both are narrower than the shared
 * field vocabulary rather than wider:
 *
 * - **`model` is passed through unvalidated.** There is no catalogue to check
 *   it against and no family-alias list to compare it with: the App Server
 *   resolves a model name itself and rejects one it cannot. A local allowlist
 *   would go stale as models ship, and rejecting a name Codex would have
 *   accepted is worse than letting Codex answer.
 * - **Only `model` and `effort` are recognized.** `tools` and
 *   `appendSystemPrompt` are shared vocabulary that this backend cannot
 *   express — the thread's tool set is Codex's own and its prompt is composed
 *   into the first Turn's input rather than configured — so a Profile naming
 *   either earns a diagnostic. ADR-0009 is why that is a diagnostic rather
 *   than a silent drop: nothing a Profile asks for is quietly ignored.
 *
 * The effort mapping is v1's: `off` becomes `none`, and every other value on
 * the shared scale passes through as the thread's reasoning-effort config.
 */

import type { Profile, ProfileDiagnostic } from "../../domain/index.ts";
import {
  EFFORTS,
  effortField,
  stringField,
  validateCommonProfileFields,
} from "../profile-fields.ts";

/** How diagnostics name this backend. Not its `BackendId`. */
export const CODEX_DISPLAY_NAME = "Codex";

/**
 * The only two fields a Codex Profile may carry.
 *
 * Deliberately not the shared four. See the module comment: the other two are
 * shared vocabulary this backend has no way to honour.
 */
export const CODEX_PROFILE_FIELDS = ["model", "effort"] as const;

/** What `effort: off` becomes on the wire. */
export const CODEX_EFFORT_NONE = "none";

/**
 * The reasoning effort the thread is configured with.
 *
 * `off` is the one value the shared scale spells differently from Codex, and
 * mapping it rather than dropping it is what keeps "off means off" true: a
 * dropped value would leave the server's own default in place.
 */
export function codexEffort(effort: string | undefined): string | undefined {
  return effort === "off" ? CODEX_EFFORT_NONE : effort;
}

/**
 * Every diagnostic this Profile earns, deterministically.
 *
 * Through the shared field module, which is where field knowledge lives — the
 * only Codex-specific part is *which* of the shared four this backend can
 * express, and there is no model rule to supply because Codex checks a model
 * name itself.
 */
export function validateCodexProfile(
  profile: Profile,
  filePath: string,
): readonly ProfileDiagnostic[] {
  return validateCommonProfileFields(profile, filePath, {
    displayName: CODEX_DISPLAY_NAME,
    sharedFields: CODEX_PROFILE_FIELDS,
  });
}

/** The model and effort one Subagent's threads are started with. */
export interface CodexModelChoice {
  /** Passed through for Codex to check. Never validated here. */
  readonly model?: string;
  /** Already mapped: `off` has become `none`. */
  readonly effort?: string;
}

/**
 * Read the model and effort once, at `open`, from the Profile alone.
 *
 * Deliberately **not** inherited from the parent, which is where this differs
 * from Pi and matches Claude. Pi's model reference and thinking level are the
 * same vocabulary the parent session speaks; a parent running a Pi model has
 * no Codex model to lend, so a Profile that names none leaves the App Server's
 * own default — which is v1's behaviour and the only honest one.
 */
export function resolveCodexModel(profile: Profile): CodexModelChoice {
  const model = stringField(profile, "model");
  const effort = codexEffort(effortField(profile, EFFORTS));
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * What one Turn's input text is.
 *
 * The Profile's prompt is composed into the **first** Turn and never repeated:
 * a Codex thread is a conversation, and the specialist's instructions are part
 * of how it opened rather than something every later Turn has to restate. v1
 * did exactly this, and repeating it would both cost tokens and read to the
 * model as the instructions having changed.
 */
export function codexTurnInput(
  profile: Profile,
  taskPrompt: string,
  isFirstTurn: boolean,
): string {
  if (!isFirstTurn) return taskPrompt;
  const composed = profile.systemPrompt.trim();
  return composed === "" ? taskPrompt : `${composed}\n\n${taskPrompt}`;
}
