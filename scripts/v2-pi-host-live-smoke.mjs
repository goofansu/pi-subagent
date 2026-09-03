// The v2 host-level live gate, for one backend at a time.
//
// Usage: node --import tsx scripts/v2-pi-host-live-smoke.mjs [pi|claude]
//
// Launches Pi in RPC mode with **only** the v2 entry point loaded, asks the
// model to delegate to a Profile naming the given backend, and reads the
// answer back through `agent_result`. The runtime gates next to this one
// prove the lifecycle; this proves the other half — that the whole thing is
// reachable through the surface a user has, with the real registrations, the
// real Session events, the production backend set, and no v1 in the process at
// all.
//
// The backend is an argument rather than a second copy of this file because
// what the gate exercises is the *host*, and the host is the same whichever
// backend a Profile names. That sameness is the claim; a second script would
// have let the two drift and hidden it.
//
// Credentials follow the existing live-smoke conventions. Override the Pi
// executable with V2_PI_LIVE_BIN, the parent model with V2_PI_LIVE_MODEL, the
// delegate's model with V2_PI_LIVE_MODEL or V2_CLAUDE_LIVE_MODEL, and the
// overall bound with V2_PI_LIVE_TIMEOUT_MS. This spends provider quota and is
// not part of `npm run check`.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const BACKENDS = new Set(["pi", "claude"]);
const backend = process.argv[2] ?? "pi";
if (!BACKENDS.has(backend)) {
  console.error(`unknown backend '${backend}'; expected pi or claude`);
  process.exit(2);
}

const SUCCESS_MARKER = `V2_${backend.toUpperCase()}_HOST_LIVE_SMOKE_PASS`;
const FAILURE_MARKER = `V2_${backend.toUpperCase()}_HOST_LIVE_SMOKE_FAIL`;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entry = path.join(
  repositoryRoot,
  "extensions",
  "subagent-v2",
  "index.ts",
);
const bin = process.env.V2_PI_LIVE_BIN ?? "pi";
// The delegate's model. Pi's is a catalogue reference and Claude's is a family
// alias, so they are different variables and neither default fits the other.
const model =
  backend === "claude"
    ? (process.env.V2_CLAUDE_LIVE_MODEL ?? "haiku")
    : process.env.V2_PI_LIVE_MODEL;
const timeoutMs = Number(process.env.V2_PI_LIVE_TIMEOUT_MS ?? 300_000);
const failures = [];
let interrupted;

function check(name, condition) {
  console.log(`  ${condition ? "ok" : "FAIL"} — ${name}`);
  if (!condition) failures.push(name);
}

/**
 * The Profile the model is asked to delegate to.
 *
 * Written into the real agent directory, because that is where a Session
 * reads Profiles from and the whole point of this gate is to use the surface
 * a user has. It is removed afterwards, and an existing file of the same name
 * is never overwritten — a developer's own Profile is not this script's to
 * replace.
 */
const marker = `HOST-${randomUUID().slice(0, 8)}`;
const agentsDir = path.join(getAgentDir(), "agents");
const profilePath = path.join(agentsDir, "v2-live-smoke.md");
let wroteProfile = false;

const cwd = mkdtempSync(path.join(tmpdir(), "v2-pi-host-live-smoke-"));

function writeProfile() {
  if (existsSync(profilePath)) {
    throw new Error(
      `${profilePath} already exists; remove it or rename this gate's Profile`,
    );
  }
  writeFileSync(
    profilePath,
    [
      "---",
      "description: A specialist that echoes a marker, for the v2 host live gate.",
      // Omitted for Pi, whose Profiles name no backend by default; written for
      // every other backend, because that line is the whole selection
      // mechanism a user has.
      ...(backend === "pi" ? [] : [`backend: ${backend}`]),
      ...(model ? [`model: ${model}`] : []),
      "---",
      "You answer in as few words as possible and you never ask questions.",
      "",
    ].join("\n"),
  );
  wroteProfile = true;
}

/** Drive one Pi RPC process to completion and collect what it said. */
function runPi(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        "-np",
        "-nc",
        "-ns",
        // Every other extension disabled, and only the v2 entry loaded: a
        // failure here is v2's, and v1 is not in the process to help.
        "-ne",
        "-e",
        entry,
        "--no-session",
        "--mode",
        "rpc",
        "--tools",
        "agent_start,agent_wait,agent_result",
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the host live gate timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });

    child.stdin.write(
      `${JSON.stringify({ id: "r1", type: "prompt", message: prompt })}\n`,
    );
    child.stdin.end();
  });
}

const onSignal = (signal) => {
  interrupted = signal;
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  console.log(`v2 host live gate (${backend})`);
  writeProfile();

  const prompt = [
    'Use agent_start with agent "v2-live-smoke", a one-line description, and',
    `the prompt: Reply with exactly the word ${marker} and nothing else.`,
    "Then use agent_wait with the run id it returned, then agent_result with",
    "the same run id, and finally tell me the word the subagent replied with.",
  ].join(" ");

  const { code, out, err } = await runPi(prompt);
  const transcript = `${out}\n${err}`;

  check("the Pi process exited cleanly", code === 0);
  check("agent_start was called", /agent_start/.test(transcript));
  check("agent_result was called", /agent_result/.test(transcript));
  check("the subagent's answer came back", transcript.includes(marker));
  check(
    "no v1 module was loaded",
    !/extensions\/subagent\//.test(transcript.replace(/subagent-v2/g, "")),
  );
  if (failures.length > 0) console.error(transcript);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  if (wroteProfile) rmSync(profilePath, { force: true });
  rmSync(cwd, { recursive: true, force: true });
}

if (failures.length === 0) console.log(`\n${SUCCESS_MARKER}`);
else {
  console.error(`\n${FAILURE_MARKER} — ${failures.join("; ")}`);
  process.exitCode = interrupted ? 128 : 1;
}
