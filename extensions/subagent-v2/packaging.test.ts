import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PINNED_EFFECT_VERSION } from "./effect-version.ts";

/**
 * Repository packaging policy the v2 tree depends on.
 *
 * These assertions change for dependency and packaging reasons rather than
 * for entry-point reasons, so they live apart from `index.test.ts`. They are
 * v2's tests because v2 is what they protect: an installed package must keep
 * loading only v1, and the Effect pin must stay exact.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readPackageManifest(): {
  dependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
} {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
}

test("the package manifest exposes only the v1 extension", () => {
  const manifest = readPackageManifest();

  assert.deepEqual(manifest.pi?.extensions, ["./extensions/subagent"]);
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
