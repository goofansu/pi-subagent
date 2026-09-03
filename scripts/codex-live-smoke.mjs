// The v2 runtime-level live gate for the Codex backend.
//
// Usage: node --import tsx scripts/codex-live-smoke.mjs
//
// Builds a real Session runtime over the production backend set and drives the
// six operations the M6 exit gate names — start, resume, steer, cancel,
// timeout, and shutdown — against a real `codex app-server`. Then it reads
// every probe after the Session Scope has closed and asks the operating system
// whether the child is gone, because "no App Server process, reader fiber,
// pending request, retained root, or in-flight steer after closure" is the one
// exit-gate item that cannot be argued from code.
//
// Four of the checks are Codex's own and are the reason this script exists
// rather than being a copy of the Claude gate. Each is one of the M0 spike's
// findings, live:
//
// - The resumed Run has to answer from the *first* Turn's context and run on
//   the same retained root, which is what "resume" means for a backend with no
//   `thread/resume` and no stored rollout.
// - A confirmed steer has to produce exactly **one** user observation. The
//   adapter sends a client message id and the server echoes it on a
//   user-message item; a transcript with two would mean the adapter had
//   counted an echo twice, and one with none would mean guidance the model
//   read went unrecorded.
// - The cancelled Run must leave the process, the root, and the Subagent
//   alive, because the spike found that `turn/interrupt` stops only the Turn.
// - **The child process must actually be gone** — the whole process tree, not
//   only the App Server this process spawned. Codex is the one backend that
//   owns an operating-system process, and the adapter's own probe reading zero
//   is the adapter's word for it. This gate asks `ps` instead.
//
// Three of those checks came from v1's retained resume smoke, which M7 deletes.
// They are the evidence only that script carried, and they are here so nothing
// is lost with it:
//
// - **The retained root is undiscoverable.** A *second* App Server, spawned
//   from the same recorded invocation, is asked to list and read threads. It
//   must be able to read one ordinary stored thread — the positive control,
//   without which "it could not read ours" would prove nothing — and it must
//   neither list nor read our ephemeral root.
// - **The whole process tree is gone after shutdown.** Descendants are
//   remembered at each phase while the Session is live and every remembered
//   pid is asked afterwards.
// - **Codex Desktop coexistence.** With CODEX_DESKTOP_COEXISTENCE_PROBE=1 the
//   gate pauses at two checkpoints — the retained root idle, and Turn 2 in
//   flight — so an operator can exercise Desktop and record what happened.
//   The procedure is `docs/codex-desktop-coexistence-release.md`; the variable
//   is the one v1's script used, because it is the operator's muscle memory.
//
// Credentials follow the existing Codex live-smoke conventions: an
// authenticated `codex` CLI on PATH (`~/.codex/auth.json`), the same
// environment `npm run codex:smoke` needs. Override the model with
// CODEX_LIVE_MODEL and the overall bound with CODEX_LIVE_TIMEOUT_MS.
// This spends provider quota and is not part of `npm run check`.

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Effect } from "effect";
// The one adapter symbol this gate names. A live gate is a composition root
// of its own — it is the only thing here that decides which backends exist —
// and wrapping the *production* spawn is what makes the transcript below
// evidence about production rather than about a stand-in.
import { spawnCodexAppServer } from "../extensions/subagent/backend/codex/index.ts";
import { createProductionBackendSet } from "../extensions/subagent/host/production-backends.ts";
import { sessionRuntimeLayer } from "../extensions/subagent/runtime/composition.ts";
import {
  createRuntimeCounters,
  probeIsClear,
} from "../extensions/subagent/runtime/counters.ts";
import { DEFAULT_RUNTIME_POLICY } from "../extensions/subagent/runtime/policy.ts";
import { RunRepository } from "../extensions/subagent/runtime/repository.ts";
import { SubagentSupervisor } from "../extensions/subagent/runtime/supervisor.ts";
import {
  assertStoredThreadInspection,
  containsProviderIdentityFieldName,
  readRetainedRoots,
} from "./codex-smoke-contract.mjs";

const SUCCESS_MARKER = "CODEX_LIVE_SMOKE_PASS";
const FAILURE_MARKER = "CODEX_LIVE_SMOKE_FAIL";

const timeoutMs = Number(process.env.CODEX_LIVE_TIMEOUT_MS ?? 420_000);
const model = process.env.CODEX_LIVE_MODEL;
const failures = [];
let interrupted;

// A parent, explicitly: the entry point is inert at any other depth, and a
// developer who ran this from inside a subagent would otherwise be told
// nothing about why it did nothing.
const inheritedDepth = process.env.PI_SUBAGENT_DEPTH;
process.env.PI_SUBAGENT_DEPTH = "0";

function check(name, condition) {
  console.log(`  ${condition ? "ok" : "FAIL"} — ${name}`);
  if (!condition) failures.push(name);
}

let rejectInterruption;
const interruption = new Promise((_unused, reject) => {
  rejectInterruption = reject;
});
const onSignal = (signal) => {
  interrupted = signal;
  rejectInterruption(new Error(`interrupted by ${signal}`));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

/**
 * The gate's own bound, held as a deadline rather than a fixed timer.
 *
 * A Desktop coexistence checkpoint is minutes of an operator's attention, and
 * those minutes are not the gate's to spend — so a pause pushes the deadline
 * out by exactly how long it lasted and re-arms.
 */
let deadline = Date.now() + timeoutMs;
let timer;

function rearmTimeout(pausedMillis = 0) {
  clearTimeout(timer);
  deadline += pausedMillis;
  timer = setTimeout(
    () =>
      rejectInterruption(
        new Error(`live smoke timed out after ${timeoutMs}ms of gate time`),
      ),
    Math.max(0, deadline - Date.now()),
  );
  timer.unref();
}

rearmTimeout();

/**
 * Every `codex` process this process is the parent of.
 *
 * Read from the operating system rather than from the adapter, because "the
 * child is gone" is the one claim an adapter cannot make about itself. A `ps`
 * that fails — an unusual platform, a restricted environment — reports nothing
 * and the check below says it could not look, rather than passing quietly.
 */
function codexChildren() {
  try {
    const listing = execFileSync("ps", ["-eo", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    return listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
          : undefined;
      })
      .filter(
        (entry) =>
          entry !== undefined &&
          entry.ppid === process.pid &&
          /codex\b.*app-server/.test(entry.command),
      );
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : "ps failed" };
  }
}

/* ---------------------------------------------------------------- */
/* The process tree                                                  */
/* ---------------------------------------------------------------- */

/** Every (pid, ppid) pair the operating system will admit to. */
function processTable() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
  });
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      ([pid, parent]) => Number.isInteger(pid) && Number.isInteger(parent),
    );
}

/** Every descendant of one pid, breadth-first, however deep. */
function descendantsOf(parentPid) {
  if (!Number.isInteger(parentPid)) return [];
  const childrenByParent = new Map();
  for (const [pid, parent] of processTable()) {
    childrenByParent.set(parent, [
      ...(childrenByParent.get(parent) ?? []),
      pid,
    ]);
  }
  const descendants = [];
  const pending = [...(childrenByParent.get(parentPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processExecutable(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "<executable unavailable>";
  }
}

/**
 * Every descendant this gate has ever seen, with what it was and when.
 *
 * Sampled at phases rather than watched continuously: a tool process Codex
 * spawns for one command may live for a second, and the claim being defended
 * is that nothing observed alive during the Session is alive after it. A pid
 * nobody sampled cannot be asserted about, so the note printed at the end says
 * so rather than letting an unexercised check read as a passing one.
 */
const knownDescendants = new Set();
const descendantEvidence = new Map();

function rememberDescendants(phase) {
  for (const parent of appServers) {
    for (const pid of descendantsOf(parent.pid)) {
      knownDescendants.add(pid);
      const seen = descendantEvidence.get(pid) ?? {
        executable: processExecutable(pid),
        phases: new Set(),
      };
      seen.phases.add(phase);
      descendantEvidence.set(pid, seen);
    }
  }
}

/* ---------------------------------------------------------------- */
/* The recording spawn                                               */
/* ---------------------------------------------------------------- */

/**
 * Every App Server this gate started, with the invocation and the transcript.
 *
 * One entry per Subagent, because a Subagent is one retained App Server with
 * one root thread. The invocation is kept so the nondiscoverability proof can
 * start a *second* App Server exactly as the adapter started the first —
 * same binary, same arguments, same cwd, same environment. Anything else
 * would be asking a different Codex home the question.
 */
const appServers = [];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split a stdio stream into JSON frames, tolerating partial chunks. */
function createFrameReader(target, label) {
  let buffered = "";
  const readLine = (line) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (isRecord(value)) target.push(value);
      else failures.push(`${label} emitted a non-object JSON frame`);
    } catch {
      failures.push(`${label} emitted malformed JSON`);
    }
  };
  return {
    push(chunk) {
      buffered += String(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) readLine(line);
    },
  };
}

/**
 * The production spawn, with both directions of stdio copied out.
 *
 * A tap rather than a substitute: the child is the one the adapter would have
 * started, and the adapter's own `CodexChildProcess` is handed back with two
 * members wrapped. The gate reads the transcript afterwards to learn the root
 * thread id and the Turn ids, which are provider identities the adapter is
 * right not to publish — and which the release proof cannot be written
 * without.
 */
const recordingSpawn = (request) => {
  const child = spawnCodexAppServer(request);
  const trace = { outbound: [], inbound: [] };
  appServers.push({ request, pid: child.pid, trace });
  const outbound = createFrameReader(trace.outbound, "client stdio");
  const inbound = createFrameReader(trace.inbound, "server stdio");
  return {
    ...child,
    write: (line) => {
      outbound.push(line);
      return child.write(line);
    },
    onStdout: (listener) =>
      child.onStdout((chunk) => {
        inbound.push(chunk);
        listener(chunk);
      }),
  };
};

/* ---------------------------------------------------------------- */
/* The second App Server                                             */
/* ---------------------------------------------------------------- */

const INSPECTOR_CLOSE_MS = 15_000;

/**
 * A plain JSON-RPC client over a second `codex app-server`.
 *
 * Deliberately not the adapter's transport. What is being tested is what an
 * *unrelated* client can discover about our root, so the client has to be
 * unrelated: an inspector built from the adapter would inherit whatever the
 * adapter does about ephemeral threads, and would be proving something about
 * our own code rather than about Codex's storage.
 */
function createInspector(request) {
  const child = nodeSpawn(request.command, [...request.args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: request.cwd,
    env: { ...request.env },
  });
  const pending = new Map();
  let nextId = 1;
  let buffered = "";
  let stderr = "";
  const closed = new Promise((resolve) => child.once("close", resolve));
  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if ("error" in message) {
        const error = new Error(
          message.error?.message ?? "inspector JSON-RPC request failed",
        );
        error.rpcError = message.error;
        waiter.reject(error);
      } else waiter.resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.once("error", rejectPending);
  child.once("close", () =>
    rejectPending(
      new Error(`inspector App Server closed unexpectedly: ${stderr.trim()}`),
    ),
  );
  return {
    child,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      }),
    notify(method, params) {
      child.stdin.write(
        `${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`,
      );
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
      }
      await withTimeout(closed, INSPECTOR_CLOSE_MS, "inspector shutdown");
      if (pidAlive(child.pid)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/** One local bound, named so it cannot be confused with the gate's own. */
function withTimeout(promise, milliseconds, label) {
  let bound;
  const expiry = new Promise((_unused, reject) => {
    bound = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    bound.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(bound));
}

/** Ask a second App Server whether it can see the retained root. */
async function inspectStoredThreads(root, request) {
  const inspector = createInspector(request);
  try {
    const initialized = await Promise.race([
      inspector.request("initialize", {
        clientInfo: {
          name: "pi-subagent-release-inspector",
          title: "pi-subagent release inspector",
          version: "2.0.0",
        },
        capabilities: null,
      }),
      interruption,
    ]);
    inspector.notify("initialized");

    const listedThreadIds = [];
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const listed = await Promise.race([
        inspector.request("thread/list", {
          cursor,
          limit: 100,
          sortKey: "created_at",
          sortDirection: "desc",
        }),
        interruption,
      ]);
      for (const thread of listed?.data ?? []) {
        if (typeof thread?.id === "string") listedThreadIds.push(thread.id);
      }
      cursor = listed?.nextCursor ?? null;
      if (cursor === null) break;
      if (page === 99) {
        throw new Error("inspector thread/list pagination did not terminate");
      }
    }

    const controlThreadId = listedThreadIds.find((id) => id !== root.threadId);
    if (!controlThreadId) {
      throw new Error(
        "no stored thread was available for the positive control; nondiscoverability is inconclusive. Complete one ordinary Codex conversation in the configured Codex home first.",
      );
    }
    const read = (threadId) =>
      Promise.race([
        inspector.request("thread/read", { threadId, includeTurns: false }),
        interruption,
      ]);
    const control = await read(controlThreadId);

    let readError;
    try {
      await read(root.threadId);
    } catch (error) {
      readError = error;
    }
    assertStoredThreadInspection({
      privateThreadId: root.threadId,
      listedThreadIds,
      controlThreadId,
      controlReadThreadId: control?.thread?.id,
      privateReadRejected: readError?.rpcError !== undefined,
    });
    return { codexHome: initialized?.codexHome };
  } finally {
    try {
      await inspector.close();
    } catch (error) {
      failures.push(
        `inspector cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Read every transcript, then ask a second App Server about the resumed root.
 *
 * Both halves in one place because they are one claim: the root the adapter
 * retained across two Turns is the root nobody else can find. Failures are
 * returned rather than thrown so the drive reaches its probes — a
 * nondiscoverability proof that fell over should cost one check, not the
 * leak evidence too.
 */
async function readRetainedRoot() {
  const servers = [...appServers];
  try {
    // In transcript order, so a root and the App Server that owns it stay
    // paired: the inspector has to be started from *that* server's
    // invocation, or it would be asking a different Codex home.
    const roots = readRetainedRoots(servers.map((server) => server.trace));
    const resumedIndex = roots.findIndex((root) => root.turnIds.length >= 2);
    const retainedRoot = roots[resumedIndex];
    const stored = await inspectStoredThreads(
      retainedRoot,
      servers[resumedIndex].request,
    );
    return { roots, retainedRoot, stored };
  } catch (error) {
    return {
      roots: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ---------------------------------------------------------------- */
/* The Desktop coexistence checkpoints                               */
/* ---------------------------------------------------------------- */

const DESKTOP_PROBE_TIMEOUT_MS = 10 * 60_000;

/**
 * Pause so an operator can exercise Codex Desktop, if they asked to be paused.
 *
 * The gate cannot assert Desktop usability, and it does not pretend to: the
 * operator's recorded observation is the release authority and this only
 * supplies the timing. Human wait time is not charged against the gate's own
 * bound, because a coexistence run is minutes of somebody's attention and a
 * gate that timed out during it would be a gate that punished being careful.
 */
async function desktopCoexistenceCheckpoint(phase, instruction) {
  if (process.env.CODEX_DESKTOP_COEXISTENCE_PROBE !== "1") return;
  const pausedAt = Date.now();
  clearTimeout(timer);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(`\nDesktop ${phase} probe: ${instruction} (10 minute limit).`);
    await withTimeout(
      Promise.race([
        terminal.question(
          `Press Enter only after recording the ${phase} Desktop result: `,
        ),
        interruption,
      ]),
      DESKTOP_PROBE_TIMEOUT_MS,
      `Desktop ${phase} coexistence prompt`,
    );
  } finally {
    terminal.close();
    rearmTimeout(Date.now() - pausedAt);
  }
}

/** A Profile directory holding one Codex specialist, for this run only. */
function profileDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), "v2-codex-live-smoke-"));
  const agents = path.join(root, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "live-smoke.md"),
    [
      "---",
      "description: A specialist that answers briefly for the v2 Codex live gate.",
      "backend: codex",
      // No `tools` line: Codex recognizes `model` and `effort` and nothing
      // else, and a Profile naming a field it cannot honour is a diagnostic.
      ...(model ? [`model: ${model}`] : []),
      "---",
      "You answer in as few words as possible and you never ask questions.",
      "",
    ].join("\n"),
  );
  return root;
}

const cwd = mkdtempSync(path.join(tmpdir(), "v2-codex-live-smoke-cwd-"));
const agentDir = profileDirectory();

const notifications = [];
const sink = {
  push: (notice) =>
    Effect.sync(() => {
      notifications.push(notice);
    }),
};

function request(overrides) {
  return {
    agent: "live-smoke",
    description: "live gate",
    prompt: "say something",
    cwd,
    childDepth: 1,
    projectTrusted: true,
    ...overrides,
  };
}

/** Spin until something is true, so nothing here waits on a sleep. */
const until = (what, ready) =>
  Effect.gen(function* () {
    for (let step = 0; step < 4_000_000; step += 1) {
      if (yield* ready) return;
      yield* Effect.yieldNow;
    }
    throw new Error(`gave up waiting for ${what}`);
  });

/** Let the forks that follow settlement — delivery, sweeps — finish. */
const quiesce = Effect.gen(function* () {
  for (let step = 0; step < 200; step += 1) yield* Effect.yieldNow;
});

const untilTerminal = (repository, runId) =>
  until(
    `${runId} to settle`,
    Effect.map(repository.lookup(runId), (known) => known.state === "terminal"),
  );

/** Run one Session over a fresh production set, and report every probe. */
async function inSession(policy, body) {
  const held = createProductionBackendSet({
    codex: { spawn: recordingSpawn },
  });
  const counters = createRuntimeCounters();
  const program = Effect.scoped(
    Effect.gen(function* () {
      const supervisor = yield* SubagentSupervisor;
      const repository = yield* RunRepository;
      const value = yield* body({ supervisor, repository });
      return { value, readProbe: () => supervisor.probe() };
    }).pipe(
      Effect.provide(
        sessionRuntimeLayer({
          backendSet: held.set,
          profiles: { from: "directory", agentDir },
          sink,
          counters,
          ...(policy === undefined ? {} : { policy }),
        }),
      ),
    ),
  );
  const { value, readProbe } = await Promise.race([
    Effect.runPromise(program),
    interruption,
  ]);
  return { value, probe: readProbe(), adapterProbes: held.probe() };
}

function started(outcome, what) {
  if (outcome.outcome !== "started") {
    throw new Error(`${what} answered '${outcome.outcome}'`);
  }
  return outcome;
}

const output = (read) =>
  read.outcome === "result" ? read.result.finalOutput : "";
const status = (read) =>
  read.outcome === "result" ? read.result.status : read.outcome;

/** Every user transcript item of a settled Run, as text. */
function userTexts(read) {
  if (read.outcome !== "result") return [];
  return read.result.transcript
    .filter((item) => item.role === "user")
    .map((item) =>
      item.parts
        .filter((part) => part.kind === "text")
        .map((part) => part.text)
        .join(""),
    );
}

/** Whether every adapter's probe reads zero. */
function probesClear(adapterProbes) {
  return Object.values(adapterProbes).every((held) =>
    Object.values(held).every((count) => count === 0),
  );
}

async function driveMainSession() {
  const retained = `RETAINED-${randomUUID().slice(0, 8)}`;
  const steered = `STEERED-${randomUUID().slice(0, 8)}`;

  const { value, probe, adapterProbes } = await inSession(undefined, (rig) =>
    Effect.gen(function* () {
      /* ---- start ---- */
      const first = started(
        yield* rig.supervisor.start(
          request({
            description: "remember a word",
            prompt: `Reply with exactly the word ${retained} and nothing else.`,
          }),
        ),
        "start",
      );
      // Sampled while the first Run is live, so the check below is about a
      // child that existed rather than one that never started.
      const whileRunning = yield* Effect.sync(codexChildren);
      yield* untilTerminal(rig.repository, first.runId);
      const firstResult = yield* rig.supervisor.result(first.runId);

      // The root is retained and idle. Sample the tree, then let an operator
      // exercise Codex Desktop against the same Codex home if they asked to.
      yield* Effect.sync(() =>
        rememberDescendants("idle after retained Turn 1"),
      );
      yield* Effect.promise(() =>
        desktopCoexistenceCheckpoint(
          "retained-idle",
          "the retained App Server is idle; verify Codex Desktop can complete work now",
        ),
      );

      /* ---- resume, on the same retained root ---- */
      const resumed = started(
        yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "recall the word",
          prompt:
            "What was the word I asked you to reply with? Reply with only that word.",
        }),
        "resume",
      );
      // Turn 2 has been admitted and is in flight. Overlap with an active Turn
      // is the coexistence question that idle cannot answer, so the checkpoint
      // is here rather than after the Run settles.
      yield* Effect.promise(() =>
        desktopCoexistenceCheckpoint(
          "active-Turn-2",
          "Turn 2 is in flight; immediately exercise Codex Desktop and record whether usable overlap was actually observed",
        ),
      );
      yield* untilTerminal(rig.repository, resumed.runId);
      const resumedResult = yield* rig.supervisor.result(resumed.runId);
      yield* Effect.sync(() =>
        rememberDescendants("idle after retained Turn 2"),
      );

      /* ---- steer ---- */
      const steerText = `Before you finish, also include the exact marker ${steered}.`;
      const steerable = started(
        yield* rig.supervisor.start(
          request({
            description: "count slowly",
            prompt: "Count from one to twenty, one number per line, then stop.",
          }),
        ),
        "start for steering",
      );
      // Wait until the Turn is actually under way before steering, so the
      // guidance is a steer rather than a race with admission — and so that
      // `expectedTurnId` names a Turn the server is really running.
      yield* until(
        "the steerable Run to be under way",
        Effect.map(
          rig.repository.lookup(steerable.runId),
          (known) => known.state !== "unknown",
        ),
      );
      const steerOutcome = yield* rig.supervisor.steer(steerable.runId, {
        type: "steer",
        text: steerText,
      });
      yield* untilTerminal(rig.repository, steerable.runId);
      const steeredResult = yield* rig.supervisor.result(steerable.runId);

      /* ---- cancel ---- */
      // On the *first* Subagent, deliberately: what this gate is about is the
      // spike's finding that `turn/interrupt` stops only the Turn, and that
      // the process, the root, and the Subagent all survive it.
      const cancellable = started(
        yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "a long task",
          prompt:
            "Write a very long essay about the history of the bicycle. Take your time.",
        }),
        "resume for cancelling",
      );
      yield* until(
        "the cancellable Run to be under way",
        Effect.map(
          rig.repository.lookup(cancellable.runId),
          (known) => known.state !== "unknown",
        ),
      );
      const cancelOutcomes = yield* rig.supervisor.cancel([cancellable.runId]);
      yield* untilTerminal(rig.repository, cancellable.runId);
      const cancelledResult = yield* rig.supervisor.result(cancellable.runId);

      /* ---- the root survives an interrupted Turn ---- */
      const afterCancel = yield* rig.supervisor.resume({
        subagentId: first.subagentId,
        description: "still there?",
        prompt: "Reply with the single word ALIVE and nothing else.",
      });
      let afterCancelResult;
      if (afterCancel.outcome === "started") {
        yield* untilTerminal(rig.repository, afterCancel.runId);
        afterCancelResult = yield* rig.supervisor.result(afterCancel.runId);
      }

      /* ---- the retained root is undiscoverable to anyone else ---- */
      // Before shutdown, because after it there is no root left to fail to
      // find, and "we could not see a thread that no longer exists" is not
      // evidence of anything.
      // Recorded rather than thrown. A retained-root proof that failed would
      // otherwise abort the drive before the probes were read, and "did the
      // Session leak" is the evidence hardest to get any other way.
      const rootProof = yield* Effect.promise(() => readRetainedRoot());

      /* ---- shutdown ---- */
      // Delivery is initiated in a fork rather than awaited, so give the forks
      // a turn before shutting down: a Session that closes with a notice still
      // in flight drops it, which is correct behaviour and would make the
      // count below say something other than what it means.
      yield* quiesce;
      yield* Effect.sync(() =>
        rememberDescendants("immediately before Session shutdown"),
      );
      yield* rig.supervisor.shutdown();
      const afterShutdown = yield* rig.supervisor.start(request({}));

      return {
        rootProof,
        whileRunning,
        firstResult,
        resumedResult,
        steerText,
        steerOutcome,
        steeredResult,
        cancelOutcomes,
        cancelledResult,
        afterCancel: afterCancel.outcome,
        afterCancelResult,
        afterShutdown,
        firstRunId: first.runId,
        resumedRunId: resumed.runId,
        settledRunIds: [
          first.runId,
          resumed.runId,
          steerable.runId,
          cancellable.runId,
          ...(afterCancel.outcome === "started" ? [afterCancel.runId] : []),
        ],
      };
    }),
  );

  check("start settles completed", status(value.firstResult) === "completed");
  check(
    "start returns the answer",
    output(value.firstResult).includes(retained),
  );
  check(
    "the App Server ran as a child of this process while a Run was live",
    Array.isArray(value.whileRunning) && value.whileRunning.length >= 1,
  );
  check(
    "resume answers from the first Turn's retained root",
    status(value.resumedResult) === "completed" &&
      output(value.resumedResult).includes(retained),
  );
  check(
    "resume uses a distinct Run id",
    value.firstRunId !== value.resumedRunId,
  );
  check(
    "a resumed Run is charged only for its own work",
    value.resumedResult.outcome === "result" &&
      value.firstResult.outcome === "result" &&
      value.resumedResult.result.usage.totals.input > 0 &&
      value.resumedResult.result.usage.totals.input <
        value.firstResult.result.usage.totals.input +
          value.resumedResult.result.usage.totals.input,
  );
  check("steering is admitted", value.steerOutcome.outcome === "accepted");
  check(
    "steering reaches the answer",
    output(value.steeredResult).includes(steered),
  );
  const confirmed = userTexts(value.steeredResult);
  check(
    `a steer confirmed by client id produced exactly one user observation (${confirmed.length})`,
    confirmed.length === 1 && confirmed[0] === value.steerText,
  );
  check(
    "cancel is admitted and the Run settles cancelled",
    value.cancelOutcomes[0]?.outcome === "admitted" &&
      status(value.cancelledResult) === "cancelled",
  );
  check(
    `an interrupted Turn leaves the process, the root, and the Subagent alive (${value.afterCancel}, ${status(value.afterCancelResult ?? { outcome: "none" })})`,
    value.afterCancel === "started" &&
      status(value.afterCancelResult) === "completed",
  );
  check(
    "shutdown refuses new work",
    value.afterShutdown.outcome === "shutting down",
  );
  const notified = notifications.map((notice) => notice.runId).sort();
  check(
    `every settled Run produced exactly one notification (${notified.join(", ")})`,
    notified.join(",") === [...value.settledRunIds].sort().join(","),
  );
  check(
    "no notification carries a provider identity",
    !/threadId|turnId|clientUserMessageId|conversationId/.test(
      JSON.stringify(notifications),
    ),
  );

  /* ---- what the transcript proves about the retained root ---- */
  const { roots, retainedRoot, stored, failure } = value.rootProof;
  check(
    `every Subagent is one App Server with one ephemeral pathless root, and one resumed (${failure ?? `${roots.length} roots, ${retainedRoot?.turnIds.length ?? 0} Turns on the resumed one`})`,
    failure === undefined,
  );
  check(
    `the retained root is neither listed nor readable by a second App Server, whose Codex home is the same one (${stored?.codexHome ?? "not inspected"})`,
    typeof stored?.codexHome === "string" &&
      stored.codexHome === retainedRoot?.codexHome,
  );

  /* ---- provider identities stay out of every public record ---- */
  const publicRecords = JSON.stringify({
    settledRunIds: value.settledRunIds,
    results: [
      value.firstResult,
      value.resumedResult,
      value.steeredResult,
      value.cancelledResult,
      value.afterCancelResult,
    ],
    notifications,
  });
  check(
    "no public record names a provider identity field",
    !containsProviderIdentityFieldName(publicRecords),
  );
  const leaked = roots.flatMap((root) =>
    [...root.providerIdentities].filter((identity) =>
      publicRecords.includes(identity),
    ),
  );
  check(
    `no provider identity value reached a public record (${leaked.length === 0 ? "none" : leaked.join(", ")})`,
    leaked.length === 0,
  );

  check(
    `the runtime probe is clear after closure (${JSON.stringify(probe)})`,
    probeIsClear(probe),
  );
  check(
    `all three adapter probes are clear after closure (${JSON.stringify(adapterProbes)})`,
    probesClear(adapterProbes),
  );
  const remaining = codexChildren();
  check(
    `no App Server child remains after closure (${JSON.stringify(remaining)})`,
    Array.isArray(remaining) && remaining.length === 0,
  );
  checkProcessTreeIsGone("closure");
}

/**
 * Every descendant ever observed alive is gone, and say so either way.
 *
 * A gate that observed no descendant has not exercised descendant cleanup, and
 * printing "ok" for a check that never ran would be the worst outcome here.
 * The note is what the release record copies.
 */
function checkProcessTreeIsGone(occasion) {
  if (knownDescendants.size === 0) {
    console.log(
      `  note — no persistent App Server descendants were observed before ${occasion}; descendant cleanup was not exercised`,
    );
    return;
  }
  const evidence = [...descendantEvidence].map(
    ([pid, seen]) =>
      `${pid} ${seen.executable} [${[...seen.phases].join(", ")}]`,
  );
  console.log(`  evidence — observed descendants: ${evidence.join("; ")}`);
  const alive = [...knownDescendants].filter(pidAlive);
  check(
    `all observed App Server descendants are gone after ${occasion} (${alive.length === 0 ? "none alive" : alive.join(", ")})`,
    alive.length === 0,
  );
}

async function driveTimeoutSession() {
  const { value, probe, adapterProbes } = await inSession(
    // Inside the first Turn: `turn/start` returns its turn id before any model
    // work, so the bound has to fire while the model is still writing or a
    // fast answer beats it.
    { ...DEFAULT_RUNTIME_POLICY, defaultRunTimeoutMillis: 5_000 },
    (rig) =>
      Effect.gen(function* () {
        const timed = started(
          yield* rig.supervisor.start(
            request({
              description: "a task that will not finish in time",
              prompt:
                "Write an extremely long, detailed history of the bicycle, chapter by chapter.",
            }),
          ),
          "start for the timeout",
        );
        yield* Effect.sync(() =>
          rememberDescendants("the timeout Session's Run in flight"),
        );
        yield* untilTerminal(rig.repository, timed.runId);
        return yield* rig.supervisor.result(timed.runId);
      }),
  );

  check(
    `a Run past its default timeout is cancelled with reason timeout (${status(value)}, ${
      value.outcome === "result" ? value.result.cancellationReason : "none"
    })`,
    value.outcome === "result" &&
      value.result.status === "cancelled" &&
      value.result.cancellationReason === "timeout",
  );
  check(
    `the runtime probe is clear after the timeout Session (${JSON.stringify(probe)})`,
    probeIsClear(probe),
  );
  check(
    `all three adapter probes are clear after the timeout Session (${JSON.stringify(adapterProbes)})`,
    probesClear(adapterProbes),
  );
  const remaining = codexChildren();
  check(
    `no App Server child remains after the timeout Session (${JSON.stringify(remaining)})`,
    Array.isArray(remaining) && remaining.length === 0,
  );
  checkProcessTreeIsGone("the timeout Session");
}

try {
  console.log(
    `v2 Codex runtime live gate (model: ${model ?? "the App Server's default"})`,
  );
  await driveMainSession();
  await driveTimeoutSession();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timer);
  // Nothing this gate started may outlive it, whatever failed. The Session
  // Scope is what should have done it; this is the backstop that makes a
  // failing gate safe to run twice.
  for (const pid of [
    ...[...knownDescendants].reverse(),
    ...appServers.map((server) => server.pid),
  ]) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  if (inheritedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
  else process.env.PI_SUBAGENT_DEPTH = inheritedDepth;
}

if (failures.length === 0) console.log(`\n${SUCCESS_MARKER}`);
else {
  console.error(`\n${FAILURE_MARKER} — ${failures.join("; ")}`);
  process.exitCode = interrupted ? 128 : 1;
}
