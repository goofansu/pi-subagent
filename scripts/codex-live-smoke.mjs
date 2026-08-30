// Live release smoke for steerable Codex Runs. It spends real quota and needs
// an authenticated pinned Codex CLI:
//
//   node --import tsx scripts/codex-live-smoke.mjs
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSubagentDelivery } from "../extensions/subagent/delivery.ts";
import { runCodexAppServer } from "../extensions/subagent/harnesses/codex/app-server.ts";
import {
  createCodexHarness,
  createCodexTranslator,
} from "../extensions/subagent/harnesses/codex/harness.ts";
import { createHarnessRegistry } from "../extensions/subagent/harnesses/contract.ts";
import { createSubagentRuns } from "../extensions/subagent/runs.ts";
import { startSubagent } from "../extensions/subagent/standalone-run-helper.ts";

const LIVE_TIMEOUT_MS = 240_000;
const SUCCESS_MARKER = "CODEX_STEERING_LIVE_SMOKE_PASS";
const inheritedDepth = process.env.PI_SUBAGENT_DEPTH;
// The smoke is an operator-level release gate even when invoked by a coding
// agent whose own environment carries depth 1. Its child still receives the
// dispatcher's derived depth 1, so the production nesting guard is exercised.
process.env.PI_SUBAGENT_DEPTH = "0";
const cwd = mkdtempSync(path.join(tmpdir(), "codex-steering-live-smoke-"));
const failures = [];
let active;
let interruption;

function check(name, condition) {
  console.log(`  ${condition ? "ok" : "FAIL"} — ${name}`);
  if (!condition) failures.push(name);
}

function waitForInterruption() {
  return new Promise((_, reject) => {
    const onSignal = (signal) => {
      interruption = signal;
      reject(new Error(`interrupted by ${signal}`));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function waitForTimeout(onTimeout) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`live smoke timed out after ${LIVE_TIMEOUT_MS}ms`));
    }, LIVE_TIMEOUT_MS);
    timer.unref();
  });
}

async function runSteeringSmoke() {
  console.log("\n=== steer a live Codex Run and retrieve its Result ===");
  const marker = `codex-steer-${randomUUID()}`;
  const guidance = `After the command finishes, include this exact marker in your final answer: ${marker}`;
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({ runs, push: () => {} });
  const config = {
    name: "codex-live-smoke",
    description: "Live steering release smoke",
    harness: "codex",
    fields: {},
    systemPrompt: "Follow steering guidance received during the active Run.",
  };
  const started = startSubagent({
    config,
    description: "live steering release smoke",
    prompt:
      "Run this exact shell command: `sleep 12`. Do not give the final answer before it finishes. Then follow any steering guidance received during the Run.",
    cwd,
    projectTrusted: false,
    harnesses: createHarnessRegistry([createCodexHarness()]),
    runs,
  });
  delivery.register(started.id, config.name, started.settled);
  active = { delivery, id: started.id, settled: started.settled };

  const admission = delivery.steer(started.id, guidance);
  check("steering is admitted locally", admission === "accepted");
  const result = await Promise.race([
    started.settled,
    waitForTimeout(() => delivery.cancel([started.id])),
    waitForInterruption(),
  ]);
  await delivery.wait([started.id]);
  active = undefined;

  const userFacts = result.messages.filter((fact) => fact.role === "user");
  const correlatedGuidance = userFacts.filter((fact) =>
    fact.parts.some(
      (part) => part.type === "text" && part.text.includes(marker),
    ),
  );
  const retained = delivery.result(started.id);
  check("Run completes", result.lifecycle.phase === "completed");
  check(
    "one authoritative correlated user Fact contains the unique marker",
    correlatedGuidance.length === 1,
  );
  check("agent_result-style retrieval finds the terminal Result", !!retained);
  check(
    "retrieved Result reflects the steering marker",
    retained?.output.includes(marker) === true,
  );
  delivery.shutdown();
}

async function runInterruptSmoke() {
  console.log("\n=== interrupt a live Codex command ===");
  const translate = createCodexTranslator(cwd);
  const controller = new AbortController();
  let commandStarted = false;
  let turnStatus;
  const pending = runCodexAppServer({
    cwd,
    childDepth: 1,
    prompt: "Run this exact shell command: `sleep 45 && echo finished`",
    translate: (event) => {
      if (event.method === "turn/completed")
        turnStatus = event.params.turn.status;
      if (
        !commandStarted &&
        event.method === "item/started" &&
        event.params.item.type === "commandExecution"
      ) {
        commandStarted = true;
        controller.abort();
      }
      return translate(event);
    },
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: (chunk) => {
        const text = chunk.trim();
        if (text) console.log("  [stderr]", text.slice(0, 160));
      },
    },
    signal: controller.signal,
    missingAnswerMessage: "Live interrupt smoke ended without an answer.",
  });
  active = {
    delivery: {
      cancel: () => controller.abort(),
      shutdown: () => controller.abort(),
    },
    id: "interrupt-smoke",
    settled: pending,
  };
  const conclusion = await Promise.race([
    pending,
    waitForTimeout(() => controller.abort()),
    waitForInterruption(),
  ]);
  active = undefined;
  check("interrupt target command started", commandStarted);
  check(
    "interrupt transport settles cancelled",
    conclusion?.ending === "cancelled",
  );
  check("provider reports interrupted Turn", turnStatus === "interrupted");
}

try {
  await runSteeringSmoke();
  await runInterruptSmoke();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  if (active) {
    active.delivery.cancel([active.id]);
    active.delivery.shutdown();
    await active.settled.catch(() => {});
  }
  rmSync(cwd, { recursive: true, force: true });
  if (inheritedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
  else process.env.PI_SUBAGENT_DEPTH = inheritedDepth;
}

if (failures.length === 0) {
  console.log(`\n${SUCCESS_MARKER}`);
} else {
  console.error(`\nCODEX_STEERING_LIVE_SMOKE_FAIL — ${failures.join("; ")}`);
  process.exitCode = interruption ? 128 : 1;
}
