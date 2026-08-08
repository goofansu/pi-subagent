import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

/**
 * Why project-controlled configuration is or is not permitted for delegated
 * harnesses. Kept alongside the boolean so the decision stays auditable — tests
 * assert on it, and UI messaging can grow more specific without the caller
 * having to re-derive which rule fired. `vacuous-trust` covers both an absent
 * decision and a saved negative one: neither backs Pi's `true`.
 */
export type ProjectConfigReason =
  | "pi-untrusted"
  | "trust-required-and-approved"
  | "saved-approval"
  | "vacuous-trust"
  | "trust-store-error";

export interface ProjectConfigPolicy {
  /** The raw value Pi reported for this directory. */
  piProjectTrusted: boolean;
  /** Whether delegated harnesses may load project-controlled configuration. */
  allowProjectConfig: boolean;
  reason: ProjectConfigReason;
  /** Short, path-free message worth showing the person once at startup. */
  warning?: string;
}

export interface ResolveProjectConfigPolicyOptions {
  cwd: string;
  agentDir: string;
  piProjectTrusted: boolean;
}

/**
 * Pi reports `true` without asking anyone when the directory holds nothing that
 * requires trust. That answer means "there was nothing to gate", not "the
 * person approved project configuration", so forwarding it to a child process
 * that starts later — after a checkout or generator has added configuration —
 * would hand out approval nobody gave.
 *
 * So Pi's trust is necessary but not sufficient: it must be backed either by
 * resources that actually forced a decision, or by a decision saved for this
 * directory or an ancestor in Pi's own trust store.
 */
export function resolveProjectConfigPolicy({
  cwd,
  agentDir,
  piProjectTrusted,
}: ResolveProjectConfigPolicyOptions): ProjectConfigPolicy {
  if (!piProjectTrusted) {
    return {
      piProjectTrusted,
      allowProjectConfig: false,
      reason: "pi-untrusted",
    };
  }

  // A current-session override stays authoritative here: Pi already resolved
  // --approve / --no-approve against these resources, and its answer arrives as
  // `piProjectTrusted` above.
  if (hasTrustRequiringProjectResources(cwd)) {
    return {
      piProjectTrusted,
      allowProjectConfig: true,
      reason: "trust-required-and-approved",
    };
  }

  let savedDecision: boolean | null;
  try {
    // `get` walks up to the nearest ancestor entry, so a decision saved for a
    // parent folder counts here.
    savedDecision = new ProjectTrustStore(agentDir).get(cwd);
  } catch {
    // An unreadable or malformed store is not evidence of approval. Deny, warn
    // once, and keep the extension starting; the raw parser error and the store
    // path stay out of the UI and out of the model's context.
    return {
      piProjectTrusted,
      allowProjectConfig: false,
      reason: "trust-store-error",
      warning:
        "Pi's project trust store could not be read, so subagents run without project configuration. Use /trust and restart Pi once it is fixed.",
    };
  }

  return savedDecision === true
    ? { piProjectTrusted, allowProjectConfig: true, reason: "saved-approval" }
    : { piProjectTrusted, allowProjectConfig: false, reason: "vacuous-trust" };
}
