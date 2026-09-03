/**
 * Resolving a backend by name.
 *
 * A plain map in M1, deliberately. The catalog's job is to answer "which
 * backend does this Profile name, and does it exist" — and doing that as a
 * function of a list makes Profile validation testable without a runtime. M2
 * turns it into the session-long `BackendCatalog` service, built once when the
 * Session Scope opens; the lookup rule stays exactly this.
 */

import type { BackendId, Profile, ProfileDiagnostic } from "../domain/index.ts";
import type { Backend, BackendValidationContext } from "./contract.ts";

export interface BackendCatalog {
  readonly ids: readonly BackendId[];
  readonly get: (id: BackendId) => Backend | undefined;
  /**
   * Validate a Profile through the backend it names.
   *
   * A Profile naming a backend that does not exist is one diagnostic, not an
   * exception: an unknown backend is a mistake in a file, and the answer to it
   * is to say which file and which name.
   */
  readonly validateProfile: (
    profile: Profile,
    filePath: string,
    context?: BackendValidationContext,
  ) => readonly ProfileDiagnostic[];
}

export function createBackendCatalog(
  backends: readonly Backend[],
): BackendCatalog {
  const byId = new Map(backends.map((backend) => [backend.id, backend]));
  return {
    ids: [...byId.keys()],
    get: (id) => byId.get(id),
    validateProfile: (profile, filePath, context) => {
      const backend = byId.get(profile.backend);
      if (!backend) {
        return [{ filePath, reason: `unknown backend '${profile.backend}'` }];
      }
      return backend.validateProfile(profile, filePath, context);
    },
  };
}
