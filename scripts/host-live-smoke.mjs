// The host-level live gate, for one backend at a time.
//
// Usage: node --import tsx scripts/host-live-smoke.mjs [pi|claude]
//
// Launches Pi in RPC mode with **only** this extension loaded, asks the
// model to delegate to a Profile naming the given backend, and reads the
// answer back through `agent_wait`. The runtime gates next to this one
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
// executable with PI_LIVE_BIN, the parent model with PI_LIVE_MODEL, the
// delegate's model with PI_LIVE_MODEL or CLAUDE_LIVE_MODEL, and the overall
// bound with PI_LIVE_TIMEOUT_MS. This spends provider quota and is not part
// of `npm run check`.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const BACKENDS = new Set(["pi", "claude"]);
const backend = process.argv[2] ?? "pi";
if (!BACKENDS.has(backend)) {
  console.error(
    `unknown backend '${backend}'; expected one of ${[...BACKENDS].join(", ")}`,
  );
  process.exit(2);
}

const SUCCESS_MARKER = `${backend.toUpperCase()}_HOST_LIVE_SMOKE_PASS`;
const FAILURE_MARKER = `${backend.toUpperCase()}_HOST_LIVE_SMOKE_FAIL`;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entry = path.join(repositoryRoot, "extensions", "subagent", "index.ts");
const bin = process.env.PI_LIVE_BIN ?? "pi";
// The delegate's model. Pi's is a catalogue reference and Claude's is a family
// alias — two different vocabularies, so two variables and no shared default.
const model =
  backend === "claude"
    ? (process.env.CLAUDE_LIVE_MODEL ?? "haiku")
    : process.env.PI_LIVE_MODEL;
const timeoutMs = Number(process.env.PI_LIVE_TIMEOUT_MS ?? 300_000);
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
const profilePath = path.join(agentsDir, "host-live-smoke.md");
let wroteProfile = false;

const cwd = mkdtempSync(path.join(tmpdir(), "host-live-smoke-"));

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
      "description: A specialist that echoes a marker, for the host live gate.",
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
        // Every other extension disabled, and only this entry point loaded,
        // so a failure here is this extension's and nothing else's.
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
    let stdoutBuffer = "";
    let finished = false;
    let inputEnded = false;
    const events = [];
    const decoder = new StringDecoder("utf8");

    const finish = (action) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      action();
    };
    const fail = (error) => {
      child.kill("SIGKILL");
      finish(() => reject(error));
    };
    const acceptLine = (line) => {
      const framed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (framed.length === 0) return;
      let event;
      try {
        event = JSON.parse(framed);
      } catch (error) {
        fail(
          new Error(
            `Pi emitted invalid RPC JSON: ${framed}`,
            error instanceof Error ? { cause: error } : undefined,
          ),
        );
        return;
      }
      events.push(event);
      if (event.type === "agent_settled" && !inputEnded) {
        inputEnded = true;
        child.stdin.end();
      }
    };
    const acceptChunk = (text) => {
      stdoutBuffer += text;
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline === -1) return;
        acceptLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    };

    const timer = setTimeout(
      () =>
        fail(new Error(`the host live gate timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();

    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      acceptChunk(decoder.write(chunk));
    });
    child.stdout.on("end", () => {
      acceptChunk(decoder.end());
      if (stdoutBuffer.length > 0) acceptLine(stdoutBuffer);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.stdin.on("error", fail);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() => resolve({ code, out, err, events })),
    );

    child.stdin.write(
      `${JSON.stringify({ id: "r1", type: "prompt", message: prompt })}\n`,
    );
  });
}

const onSignal = (signal) => {
  interrupted = signal;
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  console.log(`host live gate (${backend})`);
  writeProfile();

  const prompt = [
    'Use agent_start with agent "host-live-smoke", a one-line description, and',
    `the prompt: Reply with exactly the word ${marker} and nothing else.`,
    "Then use agent_wait with the run id it returned, which returns the",
    "subagent's result directly, and finally tell me the word the subagent",
    "replied with.",
  ].join(" ");

  const { code, out, err, events } = await runPi(prompt);
  const transcript = `${out}\n${err}`;
  const toolStarted = (name) =>
    events.some(
      (event) =>
        event.type === "tool_execution_start" && event.toolName === name,
    );
  const toolResultText = (name) =>
    events
      .filter(
        (event) =>
          event.type === "tool_execution_end" && event.toolName === name,
      )
      .flatMap((event) => event.result?.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  const finalAssistantText = events
    .filter(
      (event) =>
        event.type === "message_end" && event.message?.role === "assistant",
    )
    .at(-1)
    ?.message.content.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  check("the Pi process exited cleanly", code === 0);
  check(
    "the prompt was accepted",
    events.some(
      (event) =>
        event.type === "response" &&
        event.id === "r1" &&
        event.command === "prompt" &&
        event.success === true,
    ),
  );
  check(
    "the parent Run fully settled",
    events.some((event) => event.type === "agent_settled"),
  );
  check("agent_start was called", toolStarted("agent_start"));
  check("agent_wait was called", toolStarted("agent_wait"));
  check(
    "agent_wait returned the subagent's answer",
    toolResultText("agent_wait").includes(marker),
  );
  check(
    "the parent reported the subagent's answer",
    finalAssistantText?.includes(marker) === true,
  );
  // The v1 tree it used to check for is gone, and so is the check: there is
  // one extension now, and "the entry point that loaded is the only one there
  // is" is not something a transcript can disagree with.

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
