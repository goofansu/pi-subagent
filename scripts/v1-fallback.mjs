// The v1 fallback switch: run the frozen v1 extension locally instead of v2.
//
// Usage: node scripts/v1-fallback.mjs on
//        node scripts/v1-fallback.mjs off
//        node scripts/v1-fallback.mjs status
//
// This is the inverse of what it used to be. Before the M7 cutover the
// published manifest named v1 and this script switched *v2* on; now the
// manifest names v2, so `pi install` gives everyone the rewrite and this
// switches back — which is the rollback the migration policy asks for: "before
// final deletion, rollback means starting a new Pi session on v1."
//
// Two edits to Pi's own settings make it, and both are reversible:
//
//   1. This package's entry in `packages` is rewritten to Pi's object form
//      with an empty `extensions` list, which disables *this package's*
//      extension — the v2 one the manifest now names — and nothing else.
//      Every other extension the maintainer has installed stays exactly as it
//      was, which is the whole point: a switch that turned everything else off
//      would not be a fallback anyone could work in.
//   2. The absolute path of the v1 entry point is added to `extensions`, so
//      plain `pi` loads it.
//
// `off` reverses both, exactly, and is the ordinary state. The settings file
// is read and written whole, so anything Pi adds to it that this script does
// not know about survives.
//
// **The two are never loaded together.** They register the same six tool
// names, so a Pi process with both would offer a model each of them twice.
// Disabling the package's own extension before adding the other entry is what
// makes that impossible rather than merely unlikely, and `status` reports both
// halves so a half-applied switch is visible.
//
// This script is deleted with v1, and the rollback it offers goes with it. See
// the deletion ticket and the migration policy's "after final deletion,
// rollback is a normal release rollback".

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-subagent";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const v1Entry = path.join(repositoryRoot, "extensions", "subagent");
const settingsPath = path.join(getAgentDir(), "settings.json");

const mode = process.argv[2] ?? "status";
if (!["on", "off", "status"].includes(mode)) {
  console.error("expected one of: on, off, status");
  process.exitCode = 1;
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Whether one `packages` entry is this package, whatever form it takes. */
function isOwnPackage(entry) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string") return false;
  const base = path.basename(source.replace(/\.git$/, "").replace(/\/+$/, ""));
  return base === PACKAGE_NAME;
}

/** The entry with this package's extension disabled, and nothing else changed. */
function withoutOwnExtension(entry) {
  const source = typeof entry === "string" ? entry : entry.source;
  const rest = typeof entry === "string" ? {} : entry;
  // An empty list is Pi's way of saying "this package contributes no
  // extensions": the package is still installed, and its skills, prompts, and
  // themes are untouched.
  return { ...rest, source, extensions: [] };
}

/** The entry restored to whatever it was before the switch. */
function withOwnExtension(entry) {
  if (typeof entry === "string") return entry;
  const { extensions, ...rest } = entry;
  void extensions;
  // A bare source string is the form the installer writes, so an entry with
  // nothing else on it goes back to being one.
  return Object.keys(rest).length === 1 ? rest.source : rest;
}

function describe(settings) {
  const packages = settings.packages ?? [];
  const own = packages.find(isOwnPackage);
  const extensions = settings.extensions ?? [];
  return {
    installed: own !== undefined,
    publishedDisabled:
      own !== undefined &&
      typeof own !== "string" &&
      Array.isArray(own.extensions) &&
      own.extensions.length === 0,
    v1Loaded: extensions.includes(v1Entry),
  };
}

function report(settings) {
  const state = describe(settings);
  console.log(`settings: ${settingsPath}`);
  console.log(`  ${PACKAGE_NAME} installed as a package: ${state.installed}`);
  console.log(
    `  its published (v2) extension disabled: ${state.publishedDisabled}`,
  );
  console.log(`  the v1 entry point loaded: ${state.v1Loaded}`);
  console.log(
    state.publishedDisabled && state.v1Loaded
      ? "\nv1 is the fallback in use. `node scripts/v1-fallback.mjs off` returns to v2."
      : "\nv2 is in use, which is the default. `node scripts/v1-fallback.mjs on` falls back to v1.",
  );
}

const settings = readSettings();

if (mode === "status") {
  report(settings);
} else if (mode === "on") {
  const packages = settings.packages ?? [];
  if (!packages.some(isOwnPackage)) {
    console.error(
      `${PACKAGE_NAME} is not installed as a package, so there is no ` +
        "published extension to disable. Install it first, or load v1 by hand " +
        `with \`pi -e ${v1Entry}\`.`,
    );
    process.exitCode = 1;
  } else {
    const extensions = settings.extensions ?? [];
    writeSettings({
      ...settings,
      packages: packages.map((entry) =>
        isOwnPackage(entry) ? withoutOwnExtension(entry) : entry,
      ),
      extensions: extensions.includes(v1Entry)
        ? extensions
        : [...extensions, v1Entry],
    });
    report(readSettings());
  }
} else {
  const packages = settings.packages ?? [];
  const extensions = (settings.extensions ?? []).filter(
    (entry) => entry !== v1Entry,
  );
  const restored = {
    ...settings,
    packages: packages.map((entry) =>
      isOwnPackage(entry) ? withOwnExtension(entry) : entry,
    ),
    extensions,
  };
  // An empty list and an absent key mean the same thing to Pi, and the switch
  // should leave a settings file it can be read off as untouched.
  if (extensions.length === 0) delete restored.extensions;
  writeSettings(restored);
  report(readSettings());
}
