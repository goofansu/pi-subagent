import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function initialize() {
  if (process.argv.length !== 2)
    throw new Error("Usage: node init.mjs (no arguments or path overrides)");
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || /[\r\n]/.test(home))
    throw new Error("HOME must be an absolute, single-line path");

  process.umask(0o077);
  const base = path.join(home, ".agent-runs");
  if (fs.lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("Handoff base must not be a symlink");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const root = execFileSync(
    "mktemp",
    ["-d", path.join(base, `handoff-${stamp}-XXXXXX`)],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trimEnd();
  try {
    fs.chmodSync(root, 0o700);
    fs.mkdirSync(path.join(root, "evidence"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "evidence/orchestrator"), { mode: 0o700 });
    for (const name of ["WRITER.md", "synopsis.mjs"]) {
      fs.writeFileSync(
        path.join(root, name),
        fs.readFileSync(new URL(name, import.meta.url)),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    }
    fs.writeFileSync(
      path.join(root, "README.md"),
      `# Shared handoff context

Complete these fields before assigning workers.

## Project
<absolute project path>

## Base revision
<Git SHA or n/a>

## Shared context
<context pointers>

## Common constraints
<shared constraints>
`,
      { flag: "wx", mode: 0o600 },
    );
    return fs.realpathSync(root);
  } catch (error) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error(
        `Unable to remove incomplete allocation ${root}: ${cleanupError.message}`,
      );
    }
    throw error;
  }
}

try {
  console.log(initialize());
} catch (error) {
  console.error(`Unable to initialize handoff: ${error.message}`);
  process.exitCode = 1;
}
