/**
 * Finding Profile files on disk.
 *
 * Parsing a Profile is pure and lives in the domain module. Discovery is not:
 * it reads a directory, so it lives out here, and it is deliberately the only
 * v2 module that touches the filesystem to find Profiles.
 *
 * Validation is a callback rather than a catalog lookup. Discovery does not
 * need to know what a backend is; it needs to know whether this Profile is
 * usable, and the caller — which does have a backend catalog — answers that.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PROFILE_FILE_EXTENSION,
  type Profile,
  type ProfileDiagnostic,
  parseProfile,
} from "../domain/index.ts";

/**
 * The one directory Profiles are read from.
 *
 * User scope only, deliberately. A Profile carries a system prompt, a model,
 * and a tool list, and its description is injected into the calling model's
 * tool guidelines, so honouring repository-controlled Profiles would let a
 * checkout shape what the delegating session does and says. Nothing in a
 * working directory is read here, so there is no trust question to answer.
 */
export function profilesDir(agentDir: string): string {
  return path.join(agentDir, "agents");
}

/** Ask whether a parsed Profile is usable, in the backend's own terms. */
export type ProfileValidator = (
  profile: Profile,
  filePath: string,
) => readonly ProfileDiagnostic[];

export interface ProfileDiscovery {
  /** Usable Profiles, by name. */
  readonly profiles: ReadonlyMap<string, Profile>;
  /** Every reason a file in the directory was skipped. */
  readonly diagnostics: readonly ProfileDiagnostic[];
}

/**
 * List the Profiles in a directory, in file-name order.
 *
 * A Profile that fails to parse, or that its backend rejects, is skipped and
 * reported rather than dropped. A missing directory is not an error: a user
 * with no Profiles has an empty list.
 */
export function discoverProfiles(
  dir: string,
  validate?: ProfileValidator,
): ProfileDiscovery {
  const profiles = new Map<string, Profile>();
  const diagnostics: ProfileDiagnostic[] = [];
  if (!fs.existsSync(dir)) return { profiles, diagnostics };

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch (error) {
    diagnostics.push({
      filePath: dir,
      reason: `cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { profiles, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.endsWith(PROFILE_FILE_EXTENSION)) continue;
    const filePath = path.join(dir, entry);
    let contents: string;
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      diagnostics.push({
        filePath,
        reason: `cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const parsed = parseProfile(contents, filePath);
    if (parsed.outcome === "diagnostics") {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    const rejected = validate?.(parsed.profile, filePath) ?? [];
    if (rejected.length > 0) {
      diagnostics.push(...rejected);
      continue;
    }
    profiles.set(parsed.profile.name, parsed.profile);
  }
  return { profiles, diagnostics };
}
