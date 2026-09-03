// The runtime-level live gate for the Claude backend.
//
// Usage: node --import tsx scripts/claude-live-smoke.mjs
//
// Builds a real Session runtime over the production backend set and drives the
// six operations the M5 exit gate names — start, resume, steer, cancel,
// timeout, and shutdown — against a real streaming Query. Then it reads every
// probe after the Session Scope has closed, because "no retained Query, input
// stream, or conversation identity after closure" is the one exit-gate item
// that cannot be argued from code.
//
// Three of the checks are Claude's own and are the reason this script exists
// rather than being a copy of the Pi gate:
//
// - The resumed Run has to answer from the *first* Run's context, which proves
//   the conversation identity was acquired from a frame of the first Run and
//   attached to by the second.
// - A confirmed steer has to produce exactly **one** user observation. The
//   provider echoes the client's own uuid, and a transcript with two would mean
//   the adapter had counted an echo twice; a transcript with none would mean it
//   had a Run whose guidance reached the model and went unrecorded.
// - The cancelled Run must leave the conversation resumable, because the M0
//   spike found that aborting a Query does not destroy the conversation it was
//   attached to.
//
// Credentials follow the existing live-smoke conventions: an authenticated
// Claude Code SDK environment, the same one `npm run claude:steering-smoke`
// needs. Override the family with CLAUDE_LIVE_MODEL and the overall bound
// with CLAUDE_LIVE_TIMEOUT_MS. This spends provider quota and is not part
// of `npm run check`.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { createProductionBackendSet } from "../extensions/subagent/host/production-backends.ts";
import { sessionRuntimeLayer } from "../extensions/subagent/runtime/composition.ts";
import {
  createRuntimeCounters,
  probeIsClear,
} from "../extensions/subagent/runtime/counters.ts";
import { DEFAULT_RUNTIME_POLICY } from "../extensions/subagent/runtime/policy.ts";
import { RunRepository } from "../extensions/subagent/runtime/repository.ts";
import { SubagentSupervisor } from "../extensions/subagent/runtime/supervisor.ts";

const SUCCESS_MARKER = "CLAUDE_LIVE_SMOKE_PASS";
const FAILURE_MARKER = "CLAUDE_LIVE_SMOKE_FAIL";

const timeoutMs = Number(process.env.CLAUDE_LIVE_TIMEOUT_MS ?? 420_000);
const model = process.env.CLAUDE_LIVE_MODEL ?? "haiku";
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

const timer = setTimeout(
  () =>
    rejectInterruption(new Error(`live smoke timed out after ${timeoutMs}ms`)),
  timeoutMs,
);
timer.unref();

/** A Profile directory holding one Claude specialist, for this run only. */
function profileDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), "claude-live-smoke-"));
  const agents = path.join(root, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "live-smoke.md"),
    [
      "---",
      "description: A specialist that answers briefly for the Claude live gate.",
      "backend: claude",
      `model: ${model}`,
      "tools: Read",
      "---",
      "You answer in as few words as possible and you never ask questions.",
      "",
    ].join("\n"),
  );
  return root;
}

const cwd = mkdtempSync(path.join(tmpdir(), "claude-live-smoke-cwd-"));
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
  const held = createProductionBackendSet();
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
      yield* untilTerminal(rig.repository, first.runId);
      const firstResult = yield* rig.supervisor.result(first.runId);

      /* ---- resume ---- */
      const resumed = started(
        yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "recall the word",
          prompt:
            "What was the word I asked you to reply with? Reply with only that word.",
        }),
        "resume",
      );
      yield* untilTerminal(rig.repository, resumed.runId);
      const resumedResult = yield* rig.supervisor.result(resumed.runId);

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
      // Wait until the Query is actually running before steering, so the
      // guidance is a steer rather than a race with admission.
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
      // On the *first* Subagent, deliberately. A Subagent whose very first
      // Run is cancelled before its init frame arrives never acquired an
      // identity at all, and reporting that conversation as lost is correct
      // rather than a defect — it is the spike's Query-loss shape. What this
      // gate is about is the other finding: a cancelled Query does not
      // destroy a conversation that already exists.
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

      /* ---- the conversation survives a cancelled Query ---- */
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

      /* ---- shutdown ---- */
      // Delivery is initiated in a fork rather than awaited, so give the forks
      // a turn before shutting down: a Session that closes with a notice still
      // in flight drops it, which is correct behaviour and would make the
      // count below say something other than what it means.
      yield* quiesce;
      yield* rig.supervisor.shutdown();
      const afterShutdown = yield* rig.supervisor.start(request({}));

      return {
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
    "resume answers from the first Run's retained conversation",
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
    `a confirmed steer produced exactly one user observation (${confirmed.length})`,
    confirmed.length === 1 && confirmed[0] === value.steerText,
  );
  check(
    "cancel is admitted and the Run settles cancelled",
    value.cancelOutcomes[0]?.outcome === "admitted" &&
      status(value.cancelledResult) === "cancelled",
  );
  check(
    `a cancelled Query leaves the conversation resumable (${value.afterCancel}, ${status(value.afterCancelResult ?? { outcome: "none" })})`,
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
    !/session_id|sessionId|conversationId|queryId/.test(
      JSON.stringify(notifications),
    ),
  );
  check(
    `the runtime probe is clear after closure (${JSON.stringify(probe)})`,
    probeIsClear(probe),
  );
  check(
    `both adapter probes are clear after closure (${JSON.stringify(adapterProbes)})`,
    probesClear(adapterProbes),
  );
}

async function driveTimeoutSession() {
  const { value, probe, adapterProbes } = await inSession(
    // Tighter than the Pi gate's, because a Claude Query spends seconds
    // starting its subprocess before the first frame: the bound has to be
    // inside the first turn or a fast model finishes before it fires.
    { ...DEFAULT_RUNTIME_POLICY, defaultRunTimeoutMillis: 3_000 },
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
    `both adapter probes are clear after the timeout Session (${JSON.stringify(adapterProbes)})`,
    probesClear(adapterProbes),
  );
}

try {
  console.log(`Claude runtime live gate (model family: ${model})`);
  await driveMainSession();
  await driveTimeoutSession();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timer);
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
