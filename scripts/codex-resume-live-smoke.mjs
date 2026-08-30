// Authenticated release smoke for one stable Codex Subagent across two Runs.
// It spends real quota and must print CODEX_RESUME_LIVE_SMOKE_PASS.

import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSubagentDelivery } from "../extensions/subagent/delivery.ts";
import { createCodexHarness } from "../extensions/subagent/harnesses/codex/harness.ts";
import { createHarnessRegistry } from "../extensions/subagent/harnesses/contract.ts";
import { createSubagentRuns } from "../extensions/subagent/runs.ts";
import { createSubagentManager } from "../extensions/subagent/subagents.ts";

const LIVE_TIMEOUT_MS = 240_000;
const SUCCESS_MARKER = "CODEX_RESUME_LIVE_SMOKE_PASS";
const inheritedDepth = process.env.PI_SUBAGENT_DEPTH;
process.env.PI_SUBAGENT_DEPTH = "0";
const cwd = mkdtempSync(path.join(tmpdir(), "codex-resume-live-smoke-"));
const failures = [];
const notifications = [];
const children = [];
let attemptsStarted = 0;
let attemptsDisposed = 0;
let activeAttempts = 0;
let interruption;
let timeout;

function check(name, condition) {
  console.log(`  ${condition ? "ok" : "FAIL"} — ${name}`);
  if (!condition) failures.push(name);
}

let rejectInterruption;
const interrupted = new Promise((_, reject) => {
  rejectInterruption = reject;
});
const onSignal = (signal) => {
  interruption = signal;
  rejectInterruption(new Error(`interrupted by ${signal}`));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

const timedOut = new Promise((_, reject) => {
  timeout = setTimeout(
    () => reject(new Error(`live smoke timed out after ${LIVE_TIMEOUT_MS}ms`)),
    LIVE_TIMEOUT_MS,
  );
  timeout.unref();
});

const runs = createSubagentRuns();
const delivery = createSubagentDelivery({
  runs,
  push: (notification) => notifications.push(notification),
});
const spawn = (command, args, options) => {
  const child = spawnProcess(command, args, options);
  attemptsStarted++;
  activeAttempts++;
  children.push(child);
  child.once("close", () => {
    attemptsDisposed++;
    activeAttempts--;
  });
  return child;
};
const harnesses = createHarnessRegistry([createCodexHarness({ spawn })]);
const manager = createSubagentManager({ harnesses, runs });

async function settleWithinGate(settled) {
  return Promise.race([settled, timedOut, interrupted]);
}

try {
  console.log("\n=== start, idle, and resume one live Codex Subagent ===");
  const marker = `codex-resume-${randomUUID()}`;
  const config = {
    name: "codex-resume-live",
    description: "Live Codex resume release smoke",
    harness: "codex",
    fields: {},
    systemPrompt:
      "Retain user-provided context for later turns. Answer briefly and exactly when asked for a marker.",
  };
  const first = manager.start({
    config,
    description: "establish retained marker",
    prompt: `Remember this unique marker for a later turn: ${marker}. Confirm that you stored it and include the exact marker in your answer.`,
    cwd,
    projectTrusted: false,
  });
  delivery.register(first.runId, config.name, first.settled, first.subagentId);
  const firstResult = await settleWithinGate(first.settled);
  const firstStored = structuredClone(delivery.result(first.runId));
  check("first Run completes", firstResult.lifecycle.phase === "completed");
  check(
    "first Result establishes the unique marker",
    firstStored?.output.includes(marker),
  );
  check("first Attempt has started", attemptsStarted === 1);
  check(
    "first Attempt is disposed while the Subagent is idle",
    attemptsDisposed === 1 && activeAttempts === 0,
  );

  const resumePrompt =
    "Return only the unique marker I asked you to remember in the previous turn.";
  check(
    "the parent does not replay the marker",
    !resumePrompt.includes(marker),
  );
  const resumed = manager.resume({
    subagentId: first.subagentId,
    description: "recall retained marker",
    prompt: resumePrompt,
  });
  if (resumed.outcome !== "started") {
    throw new Error(`resume was not started: ${resumed.outcome}`);
  }
  delivery.register(
    resumed.runId,
    resumed.agent,
    resumed.settled,
    first.subagentId,
  );
  const secondResult = await settleWithinGate(resumed.settled);
  const secondStored = delivery.result(resumed.runId);

  check(
    "resume keeps the stable Subagent id",
    secondStored?.subagentId === first.subagentId,
  );
  check("resume returns a distinct Run id", resumed.runId !== first.runId);
  check(
    "a fresh second Attempt starts",
    attemptsStarted === 2 && new Set(children).size === 2,
  );
  check(
    "the second Attempt is disposed after settlement",
    attemptsDisposed === 2 && activeAttempts === 0,
  );
  check("second Run completes", secondResult.lifecycle.phase === "completed");
  check(
    "second Result depends on retained context",
    secondStored?.output.trim() === marker,
  );
  check(
    "first Result remains immutable",
    JSON.stringify(delivery.result(first.runId)) ===
      JSON.stringify(firstStored),
  );
  check(
    "both Results are independently retrievable",
    !!delivery.result(first.runId) && !!secondStored,
  );
  check(
    "each Run emits its own notification",
    notifications.length === 2 &&
      notifications[0]?.id === first.runId &&
      notifications[1]?.id === resumed.runId,
  );
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
    !/threadId|turnId|itemId|requestId|sessionId|conversationId/.test(
      publicRecords,
    ),
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timeout);
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await manager.shutdown().catch((error) => {
    failures.push(
      `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  delivery.shutdown();
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
