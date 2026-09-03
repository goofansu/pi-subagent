// The v2 runtime-level live gate for the Pi backend.
//
// Usage: node --import tsx scripts/pi-live-smoke.mjs
//
// Builds a real Session runtime over the real Pi adapter and drives the six
// operations the M4 exit gate names — start, resume, steer, cancel, timeout,
// and shutdown — against a real model. Then it reads both probes after the
// Session Scope has closed, because "no retained native listener or session
// after closure" is the one exit-gate item that cannot be argued from code.
//
// Credentials follow the existing live-smoke conventions: a usable model and
// credentials in the normal Pi agent directory. Override the model with
// PI_LIVE_MODEL and the overall bound with PI_LIVE_TIMEOUT_MS. This
// spends provider quota and is not part of `npm run check`.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { createPiBackendSet } from "../extensions/subagent/host/pi-backends.ts";
import { sessionRuntimeLayer } from "../extensions/subagent/runtime/composition.ts";
import {
  createRuntimeCounters,
  probeIsClear,
} from "../extensions/subagent/runtime/counters.ts";
import { DEFAULT_RUNTIME_POLICY } from "../extensions/subagent/runtime/policy.ts";
import { RunRepository } from "../extensions/subagent/runtime/repository.ts";
import { SubagentSupervisor } from "../extensions/subagent/runtime/supervisor.ts";

const SUCCESS_MARKER = "PI_LIVE_SMOKE_PASS";
const FAILURE_MARKER = "PI_LIVE_SMOKE_FAIL";

const timeoutMs = Number(process.env.PI_LIVE_TIMEOUT_MS ?? 300_000);
const model = process.env.PI_LIVE_MODEL;
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

/** A Profile directory holding one specialist, for this run only. */
function profileDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), "v2-pi-live-smoke-"));
  const agents = path.join(root, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "live-smoke.md"),
    [
      "---",
      "description: A specialist that answers briefly for the v2 live gate.",
      ...(model ? [`model: ${model}`] : []),
      "---",
      "You answer in as few words as possible and you never ask questions.",
      "",
    ].join("\n"),
  );
  return root;
}

const cwd = mkdtempSync(path.join(tmpdir(), "v2-pi-live-smoke-cwd-"));
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
    for (let step = 0; step < 2_000_000; step += 1) {
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

/** Run one Session over a fresh Pi backend set, and report both probes. */
async function inSession(policy, body) {
  const set = createPiBackendSet();
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
          backendSet: set.set,
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
  return { value, probe: readProbe(), nativeProbe: set.probe() };
}

function started(outcome, what) {
  if (outcome.outcome !== "started") {
    throw new Error(`${what} answered '${outcome.outcome}'`);
  }
  return outcome;
}

async function driveMainSession() {
  const retained = `RETAINED-${randomUUID().slice(0, 8)}`;
  const steered = `STEERED-${randomUUID().slice(0, 8)}`;

  const { value, probe, nativeProbe } = await inSession(undefined, (rig) =>
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
      const steerable = started(
        yield* rig.supervisor.start(
          request({
            description: "count slowly",
            prompt: "Count from one to twenty, one number per line, then stop.",
          }),
        ),
        "start for steering",
      );
      const steerOutcome = yield* rig.supervisor.steer(steerable.runId, {
        type: "steer",
        text: `Before you finish, also include the exact marker ${steered}.`,
      });
      yield* untilTerminal(rig.repository, steerable.runId);
      const steeredResult = yield* rig.supervisor.result(steerable.runId);

      /* ---- cancel ---- */
      const cancellable = started(
        yield* rig.supervisor.start(
          request({
            description: "a long task",
            prompt:
              "Write a very long essay about the history of the bicycle. Take your time.",
          }),
        ),
        "start for cancelling",
      );
      // Wait until the Run has actually begun before asking it to stop, so
      // the cancel is a cancel rather than a race with admission.
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

      /* ---- shutdown ---- */
      // Delivery is initiated in a fork rather than awaited, so give the
      // forks a turn before shutting down: a Session that closes with a
      // notice still in flight drops it, which is correct behaviour and would
      // make the count below say something other than what it means.
      yield* quiesce;
      yield* rig.supervisor.shutdown();
      const afterShutdown = yield* rig.supervisor.start(request({}));

      return {
        firstResult,
        resumedResult,
        steerOutcome,
        steeredResult,
        cancelOutcomes,
        cancelledResult,
        afterShutdown,
        firstRunId: first.runId,
        resumedRunId: resumed.runId,
        settledRunIds: [
          first.runId,
          resumed.runId,
          steerable.runId,
          cancellable.runId,
        ],
      };
    }),
  );

  const output = (read) =>
    read.outcome === "result" ? read.result.finalOutput : "";
  const status = (read) =>
    read.outcome === "result" ? read.result.status : read.outcome;

  check("start settles completed", status(value.firstResult) === "completed");
  check(
    "start returns the answer",
    output(value.firstResult).includes(retained),
  );
  check(
    "resume runs on the retained conversation",
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
      value.resumedResult.result.usage.totals.input > 0,
  );
  check("steering is admitted", value.steerOutcome.outcome === "accepted");
  check(
    "steering reaches the answer",
    output(value.steeredResult).includes(steered),
  );
  check(
    "cancel is admitted and the Run settles cancelled",
    value.cancelOutcomes[0]?.outcome === "admitted" &&
      status(value.cancelledResult) === "cancelled",
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
    `the Pi adapter probe is clear after closure (${JSON.stringify(nativeProbe)})`,
    Object.values(nativeProbe).every((held) => held === 0),
  );
}

async function driveTimeoutSession() {
  const { value, probe, nativeProbe } = await inSession(
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
        yield* untilTerminal(rig.repository, timed.runId);
        return yield* rig.supervisor.result(timed.runId);
      }),
  );

  check(
    "a Run past its default timeout is cancelled with reason timeout",
    value.outcome === "result" &&
      value.result.status === "cancelled" &&
      value.result.cancellationReason === "timeout",
  );
  check(
    `the runtime probe is clear after the timeout Session (${JSON.stringify(probe)})`,
    probeIsClear(probe),
  );
  check(
    `the Pi adapter probe is clear after the timeout Session (${JSON.stringify(nativeProbe)})`,
    Object.values(nativeProbe).every((held) => held === 0),
  );
}

try {
  console.log("v2 Pi runtime live gate");
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
