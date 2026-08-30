// Authenticated Phase 3 release gates for Pi and Claude managed Runs.
//
// Usage: node --import tsx scripts/managed-provider-live-smoke.mjs pi steering
//        node --import tsx scripts/managed-provider-live-smoke.mjs claude resume

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createSubagentDelivery } from "../extensions/subagent/delivery.ts";
import { createClaudeHarness } from "../extensions/subagent/harnesses/claude/harness.ts";
import { createHarnessRegistry } from "../extensions/subagent/harnesses/contract.ts";
import { createPiHarness } from "../extensions/subagent/harnesses/pi/harness.ts";
import { createSubagentRuns } from "../extensions/subagent/runs.ts";
import { createSubagentManager } from "../extensions/subagent/subagents.ts";

const provider = process.argv[2];
const mode = process.argv[3];
if (
  !(
    ["pi", "claude"].includes(provider) && ["steering", "resume"].includes(mode)
  )
) {
  throw new Error("expected provider (pi|claude) and mode (steering|resume)");
}

const timeoutMs = Number(process.env.MANAGED_AGENT_LIVE_TIMEOUT_MS ?? 300_000);
const upper = provider.toUpperCase();
const successMarker = `${upper}_${mode.toUpperCase()}_LIVE_SMOKE_PASS`;
const failureMarker = `${upper}_${mode.toUpperCase()}_LIVE_SMOKE_FAIL`;
const inheritedDepth = process.env.PI_SUBAGENT_DEPTH;
process.env.PI_SUBAGENT_DEPTH = "0";
const cwd = mkdtempSync(path.join(tmpdir(), `${provider}-${mode}-live-smoke-`));
const failures = [];
const notifications = [];
const traceShapes = process.env.MANAGED_AGENT_TRACE_SHAPES === "1";
let interrupted;
let timeout;

function traceShape(label, shape) {
  if (traceShapes) console.log(`  trace — ${label}: ${JSON.stringify(shape)}`);
}

function check(name, condition) {
  console.log(`  ${condition ? "ok" : "FAIL"} — ${name}`);
  if (!condition) failures.push(name);
}

let rejectInterruption;
const interruption = new Promise((_, reject) => {
  rejectInterruption = reject;
});
const onSignal = (signal) => {
  interrupted = signal;
  rejectInterruption(new Error(`interrupted by ${signal}`));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

let rejectTimeout;
const timedOut = new Promise((_, reject) => {
  rejectTimeout = reject;
});
timeout = setTimeout(
  () => rejectTimeout(new Error(`live smoke timed out after ${timeoutMs}ms`)),
  timeoutMs,
);
timeout.unref();

const providerState = {
  attempts: 0,
  active: 0,
  disposed: 0,
  results: 0,
  confirmedUsers: 0,
  firstResultBeforeGuidance: false,
  controlUuids: new Set(),
};

function piHarness() {
  return createPiHarness({
    sessionFactory: async (options) => {
      const { session } = await createAgentSession(options);
      providerState.attempts++;
      providerState.active++;
      let disposed = false;
      return {
        session: new Proxy(session, {
          get(target, property) {
            if (property === "dispose") {
              return () => {
                if (!disposed) {
                  disposed = true;
                  providerState.disposed++;
                  providerState.active--;
                }
                return target.dispose();
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
    },
  });
}

function claudeHarness() {
  return createClaudeHarness(async () => (params) => {
    let inputIndex = 0;
    const observedPrompt =
      typeof params.prompt === "string"
        ? params.prompt
        : {
            async *[Symbol.asyncIterator]() {
              for await (const message of params.prompt) {
                if (inputIndex++ > 0 && message.uuid)
                  providerState.controlUuids.add(message.uuid);
                traceShape("Claude input", {
                  index: inputIndex,
                  type: message.type,
                  priority: message.priority ?? null,
                  shouldQuery: message.shouldQuery ?? null,
                  contentTypes: Array.isArray(message.message?.content)
                    ? message.message.content.map((block) => block.type)
                    : [typeof message.message?.content],
                });
                yield message;
              }
            },
          };
    const query = claudeQuery({ ...params, prompt: observedPrompt });
    providerState.attempts++;
    providerState.active++;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      providerState.disposed++;
      providerState.active--;
    };
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const message of query) {
            const correlation =
              message.type === "result"
                ? message.user_message_uuid
                : message.type === "user"
                  ? message.uuid
                  : undefined;
            const confirmsGuidance =
              typeof correlation === "string" &&
              providerState.controlUuids.has(correlation);
            if (message.type === "result") {
              if (
                providerState.results === 0 &&
                providerState.confirmedUsers === 0 &&
                !confirmsGuidance
              ) {
                providerState.firstResultBeforeGuidance = true;
              }
              providerState.results++;
            }
            if (confirmsGuidance) providerState.confirmedUsers++;
            traceShape("Claude output", {
              type: message.type,
              subtype: message.subtype ?? null,
              isReplay: message.isReplay === true,
              correlation:
                typeof correlation !== "string"
                  ? "missing"
                  : confirmsGuidance
                    ? "control"
                    : "other",
              queuedTurnCount:
                typeof message.queued_turn_count === "number"
                  ? message.queued_turn_count
                  : null,
              isError: message.is_error === true,
              keys: Object.keys(message).sort(),
              errorCount: Array.isArray(message.errors)
                ? message.errors.length
                : 0,
            });
            yield message;
          }
        } finally {
          // Harness cleanup still calls close; this finally covers provider
          // failure or an iterator that terminates itself first.
          dispose();
        }
      },
      close() {
        try {
          query.close();
        } finally {
          dispose();
        }
      },
    };
  });
}

const runs = createSubagentRuns();
const delivery = createSubagentDelivery({
  runs,
  push: (notification) => notifications.push(notification),
});
const harness = provider === "pi" ? piHarness() : claudeHarness();
const manager = createSubagentManager({
  harnesses: createHarnessRegistry([harness]),
  runs,
});
const config = {
  name: `${provider}-${mode}-live`,
  description: `Live ${provider} ${mode} release smoke`,
  harness: provider,
  fields: {},
  systemPrompt:
    "Keep user-provided context across turns. Follow steering exactly and answer briefly.",
};

async function settle(settled) {
  return Promise.race([settled, timedOut, interruption]);
}

function register(started, subagentId) {
  delivery.register(
    started.runId,
    config.name,
    started.settled,
    subagentId ?? started.subagentId,
  );
}

async function cancellationProbe(subagentId) {
  const resumed = manager.resume({
    subagentId,
    description: "live cancellation cleanup probe",
    prompt:
      "Run this exact shell command: `sleep 45`. Do not answer before it finishes.",
  });
  if (resumed.outcome !== "started")
    throw new Error(`cancellation probe did not start: ${resumed.outcome}`);
  register(resumed, subagentId);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  delivery.cancel([resumed.runId]);
  const result = await settle(resumed.settled);
  check(
    "forced cancellation settles cancelled",
    result.lifecycle.phase === "cancelled",
  );
}

async function steeringSmoke() {
  console.log(`\n=== steer one live ${provider} managed Run ===`);
  const marker = `${provider}-steer-${randomUUID()}`;
  const started = manager.start({
    config,
    description: "live steering proof",
    prompt:
      "Run this exact shell command: `sleep 10`. Do not answer before it finishes. Then follow any guidance received while running.",
    cwd,
    projectTrusted: false,
  });
  register(started);
  const admission = delivery.steer(
    started.runId,
    `Include this exact marker in the final answer: ${marker}`,
  );
  check("steering is admitted locally", admission === "accepted");
  const result = await settle(started.settled);
  const stored = delivery.result(started.runId);
  const matchingUsers = result.messages.filter(
    (fact) =>
      fact.role === "user" &&
      fact.parts.some(
        (part) => part.type === "text" && part.text.includes(marker),
      ),
  );
  check("one managed Run completes", result.lifecycle.phase === "completed");
  check(
    "guidance is provider-confirmed exactly once",
    matchingUsers.length === 1,
  );
  check("the final Result reflects guidance", stored?.output.includes(marker));
  if (provider === "claude") {
    check(
      "Claude crosses at least two provider Results",
      providerState.results >= 2,
    );
    check(
      "Claude observes an intermediate Result before guidance consumption",
      providerState.firstResultBeforeGuidance,
    );
  }
  await cancellationProbe(started.subagentId);
}

async function resumeSmoke() {
  console.log(
    `\n=== start, idle, resume, and steer one live ${provider} Subagent ===`,
  );
  const retainedMarker = `${provider}-resume-${randomUUID()}`;
  const steeringMarker = `${provider}-resumed-steer-${randomUUID()}`;
  const first = manager.start({
    config,
    description: "establish retained marker",
    prompt: `Remember this exact marker for a later Run: ${retainedMarker}. Include it in your brief confirmation.`,
    cwd,
    projectTrusted: false,
  });
  register(first);
  const firstResult = await settle(first.settled);
  const immutableFirst = structuredClone(delivery.result(first.runId));
  check("first Run completes", firstResult.lifecycle.phase === "completed");
  check(
    "first Result establishes context",
    immutableFirst?.output.includes(retainedMarker),
  );
  check(
    "first execution is idle before resume",
    provider === "pi" ? providerState.active === 1 : providerState.active === 0,
  );

  const resumePrompt =
    "Run this exact shell command: `sleep 10`. Then return the marker remembered from the prior Run and follow any new guidance.";
  check(
    "the resumed prompt does not replay the marker",
    !resumePrompt.includes(retainedMarker),
  );
  if (provider === "claude") {
    providerState.results = 0;
    providerState.confirmedUsers = 0;
    providerState.firstResultBeforeGuidance = false;
    providerState.controlUuids.clear();
  }
  const resumed = manager.resume({
    subagentId: first.subagentId,
    description: "recall and steer retained context",
    prompt: resumePrompt,
  });
  if (resumed.outcome !== "started")
    throw new Error(`resume did not start: ${resumed.outcome}`);
  register(resumed, first.subagentId);
  check(
    "resumed steering is admitted",
    delivery.steer(
      resumed.runId,
      `Also include this exact marker: ${steeringMarker}`,
    ) === "accepted",
  );
  const secondResult = await settle(resumed.settled);
  const secondStored = delivery.result(resumed.runId);
  check("resumed Run completes", secondResult.lifecycle.phase === "completed");
  check(
    "resume depends on retained context",
    secondStored?.output.includes(retainedMarker),
  );
  check(
    "resumed steering affects the answer",
    secondStored?.output.includes(steeringMarker),
  );
  if (provider === "claude") {
    check(
      "resumed Claude steering crosses a provider Result",
      providerState.results >= 2 && providerState.firstResultBeforeGuidance,
    );
  }
  check("resume uses a distinct Run id", resumed.runId !== first.runId);
  check(
    "both Results remain independently retrievable",
    !!delivery.result(first.runId) && !!secondStored,
  );
  check(
    "first Result remains immutable",
    JSON.stringify(delivery.result(first.runId)) ===
      JSON.stringify(immutableFirst),
  );
  check("each Run emits its own notification", notifications.length === 2);
  if (provider === "pi")
    check("Pi retains exactly one SDK session", providerState.attempts === 1);
  else
    check(
      "Claude creates a fresh Query for resume",
      providerState.attempts === 2,
    );
  await cancellationProbe(first.subagentId);
}

try {
  if (mode === "steering") await steeringSmoke();
  else await resumeSmoke();
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
  check(
    "Session shutdown leaves no active provider execution",
    providerState.active === 0,
  );
  check(
    "every created provider execution is disposed",
    providerState.disposed === providerState.attempts,
  );
  const publicState = JSON.stringify({ notifications });
  check(
    "public notifications contain no provider identities",
    !/session_id|sessionId|conversationId|queryId/.test(publicState),
  );
  rmSync(cwd, { recursive: true, force: true });
  if (inheritedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
  else process.env.PI_SUBAGENT_DEPTH = inheritedDepth;
}

if (failures.length === 0) console.log(`\n${successMarker}`);
else {
  console.error(`\n${failureMarker} — ${failures.join("; ")}`);
  process.exitCode = interrupted ? 128 : 1;
}
