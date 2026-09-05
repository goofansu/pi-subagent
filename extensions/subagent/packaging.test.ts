import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PINNED_EFFECT_VERSION } from "./effect-version.ts";

/**
 * The repository's packaging policy.
 *
 * These assertions change for dependency and packaging reasons rather than for
 * entry-point reasons, so they live apart from `index.test.ts`. What they
 * protect is what a user actually installs: the manifest names this extension
 * and nothing else, the version says which release it is, the upgrade notice
 * exists, and the Effect pin stays exact.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readPackageManifest(): {
  version?: string;
  dependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
} {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
}

test("the package manifest exposes this extension and nothing else", () => {
  // The cutover, as one assertion. A fresh `pi install` reads this list and
  // nothing else, so a manifest naming both entries would offer a model each
  // of the six tool names twice — and one naming only v1 would mean the
  // rewrite shipped to nobody.
  const manifest = readPackageManifest();

  assert.deepEqual(manifest.pi?.extensions, ["./extensions/subagent/index.ts"]);
});

test("the package version is the 2.0.0 release candidate", () => {
  // The marker stays until two things have happened: the four live gates run
  // on the build being released, and the release-candidate soak closes.
  // Neither can be established by writing code, so neither can be established
  // by this test — what it can do is stop the marker being dropped by
  // accident, because a plain 2.0.0 asserts both.
  const manifest = readPackageManifest();

  assert.match(manifest.version ?? "", /^2\.0\.0-rc\.\d+$/);
});

test("the README carries an upgrade notice naming the new Profile field", () => {
  // The Profile field rename is the only thing a 1.x user has to do by hand,
  // and a major version that did not say so where a reader first looks would
  // be a major version that broke their Profiles silently.
  //
  // What this asserts is the *notice and the new field name*, not the old one:
  // the boundary rule keeps the legacy name out of this tree, so the README —
  // which is outside it — is where the rename is spelled out.
  const readme = readFileSync(path.join(repositoryRoot, "README.md"), "utf8");

  assert.match(readme, /^## Upgrading from 1\.x$/m);
  assert.match(readme, /`backend:`/);
});

test("the pinned Effect version matches the dependency and the installed package", () => {
  const manifest = readPackageManifest();
  const installed = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "node_modules", "effect", "package.json"),
      "utf8",
    ),
  ) as { version: string };

  assert.equal(manifest.dependencies?.effect, PINNED_EFFECT_VERSION);
  assert.equal(installed.version, PINNED_EFFECT_VERSION);
});

test("no Effect ecosystem package other than the core package is a dependency", () => {
  const manifest = readPackageManifest();

  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).filter(
      (name) => name === "effect" || name.startsWith("@effect/"),
    ),
    ["effect"],
  );
});
