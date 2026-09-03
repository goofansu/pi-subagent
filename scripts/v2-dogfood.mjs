// The dogfood switch: run v2 with the Pi backend as the daily driver.
//
// Usage: node scripts/v2-dogfood.mjs on
//        node scripts/v2-dogfood.mjs off
//        node scripts/v2-dogfood.mjs status
//
// The published manifest keeps exposing only v1, so switching is a local
// decision rather than a release. Two edits to Pi's own settings make it, and
// both are reversible:
//
//   1. This package's entry in `packages` is rewritten to Pi's object form
//      with an empty `extensions` list, which disables *this package's*
//      extension and nothing else. Every other extension the maintainer has
//      installed stays exactly as it was, which is the whole point — a switch
//      that turned everything else off would not be a daily driver.
//   2. The absolute path of the v2 entry point is added to `extensions`, so
//      plain `pi` loads it.
//
// `off` reverses both, exactly. The settings file is read and written whole,
// so anything Pi adds to it that this script does not know about survives.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-subagent";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const v2Entry = path.join(
  repositoryRoot,
  "extensions",
  "subagent-v2",
  "index.ts",
);
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
    v1Disabled:
      own !== undefined &&
      typeof own !== "string" &&
      Array.isArray(own.extensions) &&
      own.extensions.length === 0,
    v2Loaded: extensions.includes(v2Entry),
  };
}

function report(settings) {
  const state = describe(settings);
  console.log(`settings: ${settingsPath}`);
  console.log(`  ${PACKAGE_NAME} installed as a package: ${state.installed}`);
  console.log(`  its v1 extension disabled: ${state.v1Disabled}`);
  console.log(`  the v2 entry point loaded: ${state.v2Loaded}`);
  console.log(
    state.v1Disabled && state.v2Loaded
      ? "\nv2 is the daily driver. `node scripts/v2-dogfood.mjs off` reverses it."
      : "\nv1 is the daily driver. `node scripts/v2-dogfood.mjs on` switches.",
  );
}

const settings = readSettings();

if (mode === "status") {
  report(settings);
} else if (mode === "on") {
  const packages = settings.packages ?? [];
  if (!packages.some(isOwnPackage)) {
    console.error(
      `${PACKAGE_NAME} is not installed as a package, so there is no v1 ` +
        "extension to disable. Install it first, or load v2 by hand with " +
        `\`pi -e ${v2Entry}\`.`,
    );
    process.exitCode = 1;
  } else {
    const extensions = settings.extensions ?? [];
    writeSettings({
      ...settings,
      packages: packages.map((entry) =>
        isOwnPackage(entry) ? withoutOwnExtension(entry) : entry,
      ),
      extensions: extensions.includes(v2Entry)
        ? extensions
        : [...extensions, v2Entry],
    });
    report(readSettings());
  }
} else {
  const packages = settings.packages ?? [];
  const extensions = (settings.extensions ?? []).filter(
    (entry) => entry !== v2Entry,
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
