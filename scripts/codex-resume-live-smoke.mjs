// Authenticated release proof for one retained, ephemeral Codex Conversation.
// It spends real quota and prints CODEX_RESUME_LIVE_SMOKE_PASS only after every
// lifecycle, persistence, public-boundary, and cleanup assertion succeeds.

import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createSubagentDelivery } from "../extensions/subagent/delivery.ts";
import { createCodexHarness } from "../extensions/subagent/harnesses/codex/harness.ts";
import { createHarnessRegistry } from "../extensions/subagent/harnesses/contract.ts";
import { createSubagentRuns } from "../extensions/subagent/runs.ts";
import { createSubagentManager } from "../extensions/subagent/subagents.ts";
import {
  assertRetainedProtocolLifecycle,
  assertStoredThreadInspection,
  containsProviderIdentityFieldName,
  recallsExactMarker,
} from "./codex-resume-smoke-contract.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const LIVE_TIMEOUT_MS = 240_000;
const DESKTOP_PROBE_TIMEOUT_MS = 10 * 60_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const SUCCESS_MARKER = "CODEX_RESUME_LIVE_SMOKE_PASS";
const configuredCodexHomeCandidate =
  process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
const inheritedDepth = process.env.PI_SUBAGENT_DEPTH;
process.env.PI_SUBAGENT_DEPTH = "0";
const cwd = mkdtempSync(path.join(tmpdir(), "codex-resume-live-smoke-"));
const failures = [];
const notifications = [];
const primaryChildren = [];
const knownDescendants = new Set();
const descendantEvidence = new Map();
const protocolTrace = { outbound: [], inbound: [] };
let primarySpawnInvocation;
let inspector;
let interruption;
let timeout;
let configuredCodexHome;
let rolloutFilesBefore;
let marker;
let lifecycle;
let lifecycleDeadline = Date.now() + LIVE_TIMEOUT_MS;

function check(name, condition) {
  console.log(`  ${condition ? "ok" : "FAIL"} — ${name}`);
  if (!condition) failures.push(name);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createNdjsonRecorder(target, label) {
  let buffered = "";
  const processLine = (line) => {
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
      for (const line of lines) processLine(line);
    },
    flush() {
      processLine(buffered);
      buffered = "";
    },
  };
}

function canonicalCodexHome(candidate, label) {
  if (typeof candidate !== "string" || candidate.trim().length === 0)
    throw new Error(`${label} is not a non-empty path`);
  const resolved = path.resolve(candidate);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error(`${label} does not exist: ${resolved}`, { cause: error });
    throw new Error(
      `${label} cannot be canonicalized at ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function snapshotRolloutFiles(codexHome) {
  const files = new Set();
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.add(absolute);
    }
  };
  visit(path.join(codexHome, "sessions"));
  visit(path.join(codexHome, "archived_sessions"));
  return files;
}

function newAttributableRollouts(before, codexHome, identities) {
  const after = snapshotRolloutFiles(codexHome);
  const attributable = [];
  for (const file of after) {
    if (before.has(file)) continue;
    const content = readFileSync(file, "utf8");
    if (
      identities.some(
        (identity) => file.includes(identity) || content.includes(identity),
      )
    )
      attributable.push(file);
  }
  return attributable;
}

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

function descendantsOf(parentPid) {
  if (!Number.isInteger(parentPid)) return [];
  const childrenByParent = new Map();
  for (const [pid, parent] of processTable()) {
    const children = childrenByParent.get(parent) ?? [];
    children.push(pid);
    childrenByParent.set(parent, children);
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

function childAlive(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
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

function rememberDescendants(child, phase) {
  for (const pid of descendantsOf(child?.pid)) {
    knownDescendants.add(pid);
    const evidence = descendantEvidence.get(pid) ?? {
      executable: processExecutable(pid),
      phases: new Set(),
    };
    evidence.phases.add(phase);
    descendantEvidence.set(pid, evidence);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function forceStopTree(child, additionalPids = []) {
  const pids = [
    ...new Set([
      ...descendantsOf(child?.pid).reverse(),
      ...additionalPids,
      child?.pid,
    ]),
  ].filter((pid) => Number.isInteger(pid) && pidAlive(pid));
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await delay(250);
  for (const pid of pids) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

let rejectInterruption;
const interrupted = new Promise((_, reject) => {
  rejectInterruption = reject;
});
void interrupted.catch(() => {});
const onSignal = (signal) => {
  interruption = signal;
  rejectInterruption(new Error(`interrupted by ${signal}`));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

let rejectTimeout;
const timedOut = new Promise((_, reject) => {
  rejectTimeout = reject;
});
void timedOut.catch(() => {});

function armLifecycleTimeout() {
  clearTimeout(timeout);
  timeout = setTimeout(
    () => {
      rejectTimeout(
        new Error(`live smoke timed out after ${LIVE_TIMEOUT_MS}ms`),
      );
    },
    Math.max(0, lifecycleDeadline - Date.now()),
  );
  timeout.unref?.();
}

armLifecycleTimeout();

function settleWithinGate(promise) {
  return Promise.race([promise, timedOut, interrupted]);
}

async function waitForDesktopCoexistenceProbe(phase, instruction) {
  if (process.env.CODEX_DESKTOP_COEXISTENCE_PROBE !== "1") return;
  const pausedAt = Date.now();
  clearTimeout(timeout);
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
        interrupted,
      ]),
      DESKTOP_PROBE_TIMEOUT_MS,
      `Desktop ${phase} coexistence prompt`,
    );
  } finally {
    terminal.close();
    lifecycleDeadline += Date.now() - pausedAt;
    armLifecycleTimeout();
  }
}

function runPinnedProtocolPreflight() {
  const output = execFileSync(
    process.execPath,
    [path.join(repository, "scripts", "check-codex-protocol.mjs")],
    { cwd: repository, encoding: "utf8" },
  );
  if (!output.includes("CODEX_PROTOCOL_CHECK_PASS"))
    throw new Error("pinned Codex protocol preflight did not pass");
}

const spawn = (command, args, options) => {
  const child = spawnProcess(command, args, options);
  primaryChildren.push(child);
  primarySpawnInvocation = {
    command,
    args: [...args],
    options: { ...options },
  };
  const outbound = createNdjsonRecorder(protocolTrace.outbound, "client stdio");
  const inbound = createNdjsonRecorder(protocolTrace.inbound, "server stdio");
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...rest) => {
    outbound.push(chunk);
    return write(chunk, ...rest);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => inbound.push(chunk));
  child.once("close", () => {
    outbound.flush();
    inbound.flush();
  });
  return child;
};

function createRpcClient(command, args, options) {
  const child = spawnProcess(command, args, options);
  const pending = new Map();
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  const closed = new Promise((resolve) => child.once("close", resolve));
  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
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
  child.once("error", (error) => rejectPending(error));
  child.once("close", () =>
    rejectPending(
      new Error(`inspector App Server closed unexpectedly: ${stderr.trim()}`),
    ),
  );
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return {
    child,
    request,
    notify(method, params) {
      child.stdin.write(
        `${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`,
      );
    },
    async close() {
      if (childAlive(child)) child.stdin.end();
      await withTimeout(closed, CLEANUP_TIMEOUT_MS, "inspector shutdown");
    },
  };
}

async function inspectStoredThreads(lifecycle) {
  if (!primarySpawnInvocation)
    throw new Error("primary App Server invocation was not captured");
  inspector = createRpcClient(
    primarySpawnInvocation.command,
    primarySpawnInvocation.args,
    primarySpawnInvocation.options,
  );
  const initialized = await settleWithinGate(
    inspector.request("initialize", {
      clientInfo: {
        name: "pi-subagent-release-inspector",
        title: "pi-subagent release inspector",
        version: "1.0.0",
      },
      capabilities: null,
    }),
  );
  inspector.notify("initialized");

  const listedIds = [];
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await settleWithinGate(
      inspector.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "created_at",
        sortDirection: "desc",
      }),
    );
    for (const thread of page?.data ?? []) {
      if (typeof thread?.id === "string") listedIds.push(thread.id);
    }
    cursor = page?.nextCursor ?? null;
    if (cursor === null) break;
    if (pageNumber === 99)
      throw new Error("inspector thread/list pagination did not terminate");
  }

  const controlThreadId = listedIds.find(
    (threadId) => threadId !== lifecycle.threadId,
  );
  if (!controlThreadId)
    throw new Error(
      "Codex retained lifecycle: no stored thread was available for the positive control; nondiscoverability is inconclusive",
    );
  const readThread = (threadId) =>
    settleWithinGate(
      inspector.request("thread/read", {
        threadId,
        includeTurns: false,
      }),
    );
  const controlRead = await readThread(controlThreadId);

  let readError;
  try {
    await readThread(lifecycle.threadId);
  } catch (error) {
    readError = error;
  }
  const observation = {
    privateThreadId: lifecycle.threadId,
    listedThreadIds: listedIds,
    controlThreadId,
    controlReadThreadId: controlRead?.thread?.id,
    privateReadRejected: !!readError?.rpcError,
  };
  assertStoredThreadInspection(observation);
  return {
    codexHome: initialized?.codexHome,
  };
}

const runs = createSubagentRuns();
const delivery = createSubagentDelivery({
  runs,
  push: (notification) => notifications.push(notification),
});
const harnesses = createHarnessRegistry([createCodexHarness({ spawn })]);
const manager = createSubagentManager({ harnesses, runs });

try {
  console.log("\n=== pinned retained Codex lifecycle release proof ===");
  configuredCodexHome = canonicalCodexHome(
    configuredCodexHomeCandidate,
    "configured Codex home",
  );
  rolloutFilesBefore = snapshotRolloutFiles(configuredCodexHome);
  runPinnedProtocolPreflight();

  marker = `codex-retained-${randomUUID()}`;
  const config = {
    name: "codex-resume-live",
    description: "Live retained Codex lifecycle release proof",
    harness: "codex",
    fields: {},
    systemPrompt:
      "Retain user-provided context for later turns. Answer briefly and exactly when asked for a marker.",
  };
  const first = manager.start({
    config,
    description: "establish retained marker",
    prompt: `Remember this unique marker for a later turn: ${marker}. Confirm it by including the exact marker in your answer.`,
    cwd,
    projectTrusted: false,
  });
  delivery.register(first.runId, config.name, first.settled, first.subagentId);
  const firstResult = await settleWithinGate(first.settled);
  const firstStored = structuredClone(delivery.result(first.runId));
  const primary = primaryChildren[0];
  rememberDescendants(primary, "idle after retained Turn 1");
  check("first Run completes", firstResult.lifecycle.phase === "completed");
  check(
    "first Result establishes the random marker",
    firstStored?.output.includes(marker) === true,
  );
  check(
    "exactly one retained App Server has spawned",
    primaryChildren.length === 1,
  );
  check("the retained App Server is alive while idle", childAlive(primary));
  await waitForDesktopCoexistenceProbe(
    "retained-idle",
    "the retained App Server is idle; verify Codex Desktop can complete work now",
  );
  rememberDescendants(primary, "idle before retained Turn 2");

  const resumePrompt =
    "Return only the unique marker I asked you to remember in the previous turn.";
  const resumed = manager.resume({
    subagentId: first.subagentId,
    description: "recall retained marker",
    prompt: resumePrompt,
  });
  if (resumed.outcome !== "started")
    throw new Error(`resume was not started: ${resumed.outcome}`);
  delivery.register(
    resumed.runId,
    resumed.agent,
    resumed.settled,
    first.subagentId,
  );
  await waitForDesktopCoexistenceProbe(
    "active-Turn-2",
    "Turn 2 has been admitted; immediately exercise Codex Desktop and record whether usable overlap is observed while it remains in flight",
  );
  const secondResult = await settleWithinGate(resumed.settled);
  const secondStored = structuredClone(delivery.result(resumed.runId));
  rememberDescendants(primary, "idle after retained Turn 2");

  check("second Run completes", secondResult.lifecycle.phase === "completed");
  check(
    "second Result recalls the marker exactly",
    recallsExactMarker(secondStored?.output, marker),
  );
  check(
    "both Runs keep the stable Subagent id",
    secondStored?.subagentId === first.subagentId,
  );
  check("the resumed Run has a distinct Run id", resumed.runId !== first.runId);
  check("resume reuses the one App Server", primaryChildren.length === 1);
  check(
    "the retained App Server remains alive after Run 2",
    childAlive(primary),
  );
  check(
    "the first Result remains immutable",
    JSON.stringify(delivery.result(first.runId)) ===
      JSON.stringify(firstStored),
  );
  check(
    "both Results remain independently retrievable",
    !!delivery.result(first.runId) && !!delivery.result(resumed.runId),
  );
  check(
    "each Run emits exactly one notification",
    notifications.filter((notification) => notification.id === first.runId)
      .length === 1 &&
      notifications.filter((notification) => notification.id === resumed.runId)
        .length === 1 &&
      notifications.length === 2,
  );

  lifecycle = assertRetainedProtocolLifecycle(protocolTrace);
  const providerPrompts = protocolTrace.outbound
    .filter((message) => message.method === "turn/start")
    .map((message) => JSON.stringify(message.params?.input ?? []));
  check(
    "only the first provider Turn receives the random marker",
    providerPrompts[0]?.includes(marker) === true &&
      providerPrompts[1]?.includes(marker) === false,
  );
  check(
    "the App Server reports the configured Codex home",
    canonicalCodexHome(
      lifecycle.codexHome,
      "App Server reported Codex home",
    ) === configuredCodexHome,
  );
  const stored = await inspectStoredThreads(lifecycle);
  check(
    "the inspector uses the same Codex home",
    canonicalCodexHome(stored.codexHome, "inspector reported Codex home") ===
      configuredCodexHome,
  );
  await inspector.close();
  inspector = undefined;

  const publicRecords = JSON.stringify({
    subagentId: first.subagentId,
    firstRunId: first.runId,
    secondRunId: resumed.runId,
    first: firstStored,
    second: secondStored,
    notifications,
  });
  check(
    "public records contain no provider identity fields",
    !containsProviderIdentityFieldName(publicRecords),
  );
  check(
    "captured provider identities remain outside public records",
    [...lifecycle.providerIdentities].every(
      (identity) => !publicRecords.includes(identity),
    ),
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  for (const child of primaryChildren)
    rememberDescendants(child, "immediately before Session shutdown");
  try {
    if (inspector) await inspector.close();
  } catch (error) {
    failures.push(
      `inspector cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (inspector) await forceStopTree(inspector.child);
  }
  try {
    await withTimeout(
      manager.shutdown(),
      CLEANUP_TIMEOUT_MS,
      "manager shutdown",
    );
  } catch (error) {
    failures.push(
      `manager cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    for (const child of primaryChildren)
      await forceStopTree(child, [...knownDescendants]);
  }
  delivery.shutdown();

  try {
    if (rolloutFilesBefore && configuredCodexHome && marker && lifecycle) {
      const attributableRollouts = newAttributableRollouts(
        rolloutFilesBefore,
        configuredCodexHome,
        [marker, lifecycle.threadId, ...lifecycle.turnIds],
      );
      check(
        "no new stored rollout is attributable to the private root after Session shutdown",
        attributableRollouts.length === 0,
      );
    }
  } catch (error) {
    failures.push(
      `post-shutdown rollout inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const primary = primaryChildren[0];
  if (primary) {
    const parentGone = !childAlive(primary);
    const stdioClosed =
      (primary.stdin.writableEnded || primary.stdin.destroyed) &&
      (primary.stdout.readableEnded || primary.stdout.destroyed) &&
      (primary.stderr.readableEnded || primary.stderr.destroyed);
    check("Session shutdown closes retained App Server stdio", stdioClosed);
    check("the retained App Server is gone after Session shutdown", parentGone);
    const descendantsGone = [...knownDescendants].every(
      (pid) => !pidAlive(pid),
    );
    if (knownDescendants.size > 0) {
      const evidence = [...descendantEvidence].map(
        ([pid, observed]) =>
          `${pid} ${observed.executable} [${[...observed.phases].join(", ")}]`,
      );
      console.log(
        `  evidence — observed App Server descendants: ${evidence.join("; ")}`,
      );
      check(
        "all observed App Server descendants are gone after Session shutdown",
        descendantsGone,
      );
    } else {
      console.log(
        "  note — no persistent App Server descendants were observed after thread start; descendant cleanup was not exercised",
      );
    }
    if (!parentGone || !descendantsGone)
      await forceStopTree(primary, [...knownDescendants]);
  }
  clearTimeout(timeout);
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  rmSync(cwd, { recursive: true, force: true });
  if (inheritedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
  else process.env.PI_SUBAGENT_DEPTH = inheritedDepth;
}

if (failures.length === 0) {
  console.log(`\n${SUCCESS_MARKER}`);
} else {
  console.error(`\nCODEX_RESUME_LIVE_SMOKE_FAIL — ${failures.join("; ")}`);
  process.exitCode = interruption ? 128 : 1;
}
