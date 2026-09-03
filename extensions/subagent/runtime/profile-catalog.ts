/**
 * `ProfileCatalog`: the Profiles this Session can start, decided once.
 *
 * Discovery runs when the Session Scope opens, and never again. Reload is out
 * of scope for M2, and that is a decision rather than an omission: a Profile
 * that changed under a running Subagent would either be ignored — because the
 * Subagent's Profile is fixed for its lifetime — or would make two Runs of one
 * Subagent disagree about what they are. Deciding once means `get` is a
 * synchronous lookup with no I/O, which is what admission needs.
 *
 * Every Profile is validated through the backend it names before it enters the
 * catalog, so a Profile that reaches `get` is one its backend has already
 * accepted. What was rejected is kept as a diagnostic rather than dropped: a
 * caller asking for a Profile that exists but does not work deserves to be
 * told which file and why.
 */

import { Context, Effect, Layer } from "effect";
import type { BackendValidationContext } from "../backend/contract.ts";
import type { Profile, ProfileDiagnostic } from "../domain/index.ts";
import { discoverProfiles, profilesDir } from "../profiles/discovery.ts";
import { BackendCatalog } from "./backend-catalog.ts";

export interface ProfileCatalogApi {
  /** A usable Profile by the name a caller spells in `agent_start`. */
  readonly get: (name: string) => Profile | undefined;
  /** Every usable Profile, in discovery order. */
  readonly list: () => readonly Profile[];
  /**
   * Why each unusable file was skipped.
   *
   * Retained per Profile rather than summed, so `/agents` can tell a user
   * which file to fix.
   */
  readonly diagnostics: () => readonly ProfileDiagnostic[];
  /** The diagnostics for one name, when a caller asks about a bad Profile. */
  readonly diagnosticsFor: (name: string) => readonly ProfileDiagnostic[];
}

/**
 * Which file a diagnostic is about, as a Profile name.
 *
 * A diagnostic names a path, and a caller names a Profile. Turning one into
 * the other here is what lets `agent_start` answer `invalid profile` with the
 * reasons that actually apply to the name that was asked for.
 */
function nameOf(filePath: string): string {
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const base = filePath.slice(lastSlash + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

export class ProfileCatalog extends Context.Service<
  ProfileCatalog,
  ProfileCatalogApi
>()("pi-subagent/runtime/ProfileCatalog") {
  /**
   * Discover from a directory of Profile files.
   *
   * `agentDir` is the Pi agent directory; the Profiles live in `agents/`
   * beneath it, user scope only, exactly as M1 decided.
   */
  static layerOf(
    agentDir: string,
    /**
     * Profiles that ship with the Session's backend set.
     *
     * Merged *under* the discovered ones: a user file with the same name wins,
     * because it is the user's machine and a built-in Profile that could not
     * be replaced would be a Profile a user could not fix.
     */
    builtIn: readonly Profile[] = [],
    /**
     * What a backend needs in order to validate a Profile against the Session
     * it is being loaded into — today, the model catalogue the host reported.
     *
     * Passed through rather than looked up, because the catalog does not know
     * what a backend will want from a Session and must not start guessing: an
     * adapter that validates a pinned model against what this Session can
     * actually reach needs the Session's own list, not a global one.
     */
    validation?: BackendValidationContext,
  ): Layer.Layer<ProfileCatalog, never, BackendCatalog> {
    return Layer.effect(
      ProfileCatalog,
      Effect.gen(function* () {
        const backends = yield* BackendCatalog;
        const discovered = yield* Effect.sync(() =>
          discoverProfiles(profilesDir(agentDir), (profile, filePath) =>
            backends.validateProfile(profile, filePath, validation),
          ),
        );
        const merged = new Map<string, Profile>(
          builtIn.map((profile) => [profile.name, profile]),
        );
        for (const [name, profile] of discovered.profiles) {
          merged.set(name, profile);
        }
        return ProfileCatalog.of(
          fromDiscovery({ ...discovered, profiles: merged }),
        );
      }),
    );
  }

  /**
   * Build from Profiles already in hand.
   *
   * The conformance suite and the race tests supply Profiles directly rather
   * than writing files, and a catalog that could only be built from a
   * directory would force every one of them through the filesystem.
   */
  static layerOfProfiles(
    profiles: readonly Profile[],
    diagnostics: readonly ProfileDiagnostic[] = [],
  ): Layer.Layer<ProfileCatalog> {
    return Layer.effect(
      ProfileCatalog,
      Effect.sync(() =>
        ProfileCatalog.of(
          fromDiscovery({
            profiles: new Map(
              profiles.map((profile) => [profile.name, profile]),
            ),
            diagnostics,
          }),
        ),
      ),
    );
  }
}

function fromDiscovery(discovered: {
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly diagnostics: readonly ProfileDiagnostic[];
}): ProfileCatalogApi {
  const byName = new Map(discovered.profiles);
  const diagnostics = [...discovered.diagnostics];
  return {
    get: (name) => byName.get(name),
    list: () => [...byName.values()],
    diagnostics: () => diagnostics,
    diagnosticsFor: (name) =>
      diagnostics.filter((entry) => nameOf(entry.filePath) === name),
  };
}
