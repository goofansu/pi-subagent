/**
 * Pi Profile validation, and the model and thinking level a Run inherits.
 *
 * Ported from v1's Pi Profile rules with the behaviour unchanged, because a
 * Profile that validated under v1 has to keep validating: the migration
 * v2 asks a Profile author for is a renamed field, not a re-read of every
 * rule.
 *
 * Two rules are Pi's own, and everything else is the shared field vocabulary:
 *
 * - **A pinned model must be in the Session's catalogue**, spelled either as
 *   the catalogue's own id or as `provider/id`. Both spellings are accepted
 *   because both are what a user reads off `pi models`, and whichever one they
 *   wrote is the one passed through to the session.
 * - **The diagnostic names what the catalogue holds**, bounded, so a typo is
 *   answered with the alternatives rather than with "not found".
 *
 * Omitting the validation context means an empty catalogue, which is why a
 * pinned model is rejected when nothing supplied one. That is the honest
 * answer: a Session that reported no models can run no pinned model.
 */

import type {
  ParentModel,
  Profile,
  ProfileDiagnostic,
  SubagentContext,
} from "../../domain/index.ts";
import type { BackendValidationContext } from "../contract.ts";
import {
  EFFORTS,
  effortField,
  stringField,
  validateCommonProfileFields,
} from "../profile-fields.ts";

/** How diagnostics name this backend. Not its `BackendId`. */
export const PI_DISPLAY_NAME = "Pi";

/**
 * How much of the catalogue one diagnostic may quote.
 *
 * A Session can reach hundreds of models, and a diagnostic that listed them
 * all would be a wall of text wherever it is shown. The summary keeps as many
 * whole entries as fit and then says how many there were, so the message stays
 * one readable line's worth of alternatives plus an honest count.
 */
export const MAX_CATALOGUE_DIAGNOSTIC_CHARS = 512;

/** The catalogue, as much of it as fits, and how much did not. */
export function catalogueSummary(values: readonly string[]): string {
  if (values.length === 0) return "none";
  const shown: string[] = [];
  const omitted = `… (${values.length} catalogue models total)`;
  for (const [index, value] of values.entries()) {
    const candidate = [...shown, value].join(", ");
    const suffix = index < values.length - 1 ? `, ${omitted}` : "";
    if (`${candidate}${suffix}`.length > MAX_CATALOGUE_DIAGNOSTIC_CHARS) break;
    shown.push(value);
  }
  if (shown.length === values.length) return shown.join(", ");
  return shown.length > 0 ? `${shown.join(", ")}, ${omitted}` : omitted;
}

/** Why a pinned model cannot be used, or nothing when it can. */
export function modelProblem(
  model: string | undefined,
  context: BackendValidationContext | undefined,
): string | undefined {
  if (!model) return undefined;
  const catalogue = context?.models ?? [];
  const accepted = new Set(
    catalogue.flatMap((entry) => [entry.id, `${entry.provider}/${entry.id}`]),
  );
  if (accepted.has(model)) return undefined;
  const qualified = catalogue.map((entry) => `${entry.provider}/${entry.id}`);
  return `model '${model}' was not found in Pi's model catalogue (catalogue models include: ${catalogueSummary(qualified)})`;
}

/** Every diagnostic this Profile earns, deterministically. */
export function validatePiProfile(
  profile: Profile,
  filePath: string,
  context?: BackendValidationContext,
): readonly ProfileDiagnostic[] {
  return validateCommonProfileFields(profile, filePath, {
    displayName: PI_DISPLAY_NAME,
    validateModel: (model) => modelProblem(model, context),
  });
}

/** The model and thinking level one Subagent's session is built with. */
export interface PiModelChoice {
  readonly model?: string;
  readonly thinking?: string;
}

function qualify(parent: ParentModel): string {
  return `${parent.provider}/${parent.id}`;
}

/**
 * Resolve the model and thinking level, following v1's inheritance rule.
 *
 * The Profile's model wins; otherwise the parent's, spelled `provider/id`
 * because that is the spelling validation accepts and the one the session is
 * given. The thinking level follows the Profile's `effort` when it has one —
 * and otherwise the parent's **only when the Profile pinned no model**, since
 * a Profile that chose a different model has not agreed to the parent's
 * effort for it.
 *
 * Both are computed once, at `open`, from facts fixed for the Subagent's life.
 */
export function resolvePiModel(
  profile: Profile,
  subagent: SubagentContext,
): PiModelChoice {
  const pinned = stringField(profile, "model");
  const effort = effortField(profile, EFFORTS);
  const model =
    pinned ??
    (subagent.parentModel ? qualify(subagent.parentModel) : undefined);
  const thinking =
    effort ?? (pinned ? undefined : subagent.parentModel?.thinkingLevel);
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
  };
}
