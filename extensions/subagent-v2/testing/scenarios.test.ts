import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import type { BackendAgent } from "../backend/contract.ts";
import {
  answeredEnding,
  backendId,
  cancelledEnding,
  DEFAULT_BACKEND_ID,
  type Profile,
  runId,
  type SubagentContext,
  subagentId,
} from "../domain/index.ts";
import { DRIVER_STAGES, type DriverIdentity, driveRun } from "./driver.ts";
import {
  createFakeResumableBackend,
  type FakeBackendHandle,
  type FakeBackendOptions,
} from "./fakes/backend.ts";
import {
  emitActivity,
  emitText,
  emitToolCall,
  emitToolProgress,
  type FakeStep,
  scripts,
} from "./fakes/script.ts";

/**
 * The six lifecycle scenarios the milestone requires, end to end.
 *
 * The point of this file is that the whole of the M1 lifecycle is
 * demonstrable with no supervisor, no host, and no provider SDK: a fake
 * backend reading a script, the test-only driver, and the pure domain. If one
 * of these six breaks when M2 lands, the supervisor changed a product rule
 * rather than a mechanism.
 *
 * Every wait is on a `Deferred` the test completes. No test here sleeps, and
 * the one scenario where time is part of the story uses `TestClock`.
 */

const profile: Profile = {
  name: "reviewer",
  description: "Reviews diffs",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Be terse.",
};

const context: SubagentContext = {
  subagentId: subagentId("subagent-1"),
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

const identity: DriverIdentity = {
  subagentId: subagentId("subagent-1"),
  backendId: backendId("fake-resumable"),
  agent: "reviewer",
  description: "review the diff",
};

const input = (id: string) => ({
  runId: runId(id),
  description: "review the diff",
  prompt: "look at the diff",
});

/**
 * Open a BackendAgent in a fresh scope, do something with it, and close the
 * scope. The Subagent Scope in miniature.
 */
function withSubagent<A>(
  handle: FakeBackendHandle,
  body: (agent: BackendAgent) => Effect.Effect<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const agent = yield* handle.backend
        .open(profile, context)
        .pipe(Scope.provide(scope));
      const value = yield* body(agent);
      yield* Scope.close(scope, Exit.void);
      return value;
    }),
  );
}

function resumable(
  options: Partial<FakeBackendOptions> & Pick<FakeBackendOptions, "scripts">,
): FakeBackendHandle {
  return createFakeResumableBackend(options);
}

/* ============================================================== */
/* 1. start → progress → complete → result                        */
/* ============================================================== */

test("start, progress, complete, result: the result reflects every observation in order", async () => {
  const trace: string[] = [];
  const handle = resumable({
    trace,
    scripts: scripts([
      emitActivity("reading the diff"),
      emitToolCall("read_file", "c1"),
      emitToolProgress("c1", "running"),
      emitToolProgress("c1", "completed", "180 lines"),
      emitText("The diff looks fine."),
      { step: "cumulative-usage", total: { input: 100, output: 40 } },
      { step: "complete" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1"), trace }),
  );

  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.finalOutput, "The diff looks fine.");
  assert.deepEqual(
    outcome.observations.map((observation) => observation.kind),
    [
      "activity",
      "message",
      "tool_progress",
      "tool_progress",
      "message",
      "usage",
    ],
  );
  assert.deepEqual(outcome.result.tools, [
    {
      callId: "c1",
      name: "read_file",
      status: "completed",
      outputSummary: "180 lines",
    },
  ]);
  assert.deepEqual(outcome.result.usage.totals, {
    input: 100,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
  assert.equal(outcome.result.usage.turns, 1);
  // A settled Run is quiet.
  assert.equal("activity" in outcome.projection, false);
  assert.deepEqual(outcome.phases, ["running", "finalizing", "completed"]);
});

test("the result is produced only after the execution scope has closed", async () => {
  const trace: string[] = [];
  const handle = resumable({
    trace,
    scripts: scripts([emitText("done"), { step: "complete" }]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1"), trace }),
  );

  assert.deepEqual(outcome.trace, [
    "agent-opened",
    "execution-started:run-1",
    DRIVER_STAGES.executionResolved,
    "execution-released:run-1",
    DRIVER_STAGES.executionScopeClosed,
    DRIVER_STAGES.resultProduced,
    // The Subagent Scope outlives the Run, and closes after it.
    "agent-closed",
  ]);
});

test("a terminal snapshot heals the streamed projection before settlement", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("a partial answer"),
      { step: "cumulative-usage", total: { input: 90 } },
      {
        step: "complete",
        reconciliation: {
          transcript: [
            {
              role: "assistant",
              parts: [{ kind: "text", text: "the whole answer" }],
            },
          ],
          finalOutput: "the whole answer",
          usage: { input: 100, output: 50 },
          turns: 3,
        },
      },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1") }),
  );

  assert.equal(outcome.result.finalOutput, "the whole answer");
  assert.deepEqual(outcome.result.transcript, [
    { role: "assistant", parts: [{ kind: "text", text: "the whole answer" }] },
  ]);
  // Replaced, not added to: the streamed 90 is gone rather than summed.
  assert.equal(outcome.result.usage.totals.input, 100);
  assert.equal(outcome.result.usage.turns, 3);
});

/* ============================================================== */
/* 2. start → steer → confirm/reject → complete                   */
/* ============================================================== */

test("start, steer, confirm, complete: a confirmed Control becomes a user observation", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("starting"),
      { step: "await-control", confirm: true },
      emitText("adjusted"),
      { step: "complete" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, {
      input: input("run-1"),
      controls: [{ type: "steer", text: "check the tests too" }],
    }),
  );

  assert.deepEqual(handle.counters().controlsReceived, ["check the tests too"]);
  assert.deepEqual(
    outcome.result.transcript.map((item) => [
      item.role,
      item.parts.map((part) => (part.kind === "text" ? part.text : part.name)),
    ]),
    [
      ["assistant", ["starting"]],
      ["user", ["check the tests too"]],
      ["assistant", ["adjusted"]],
    ],
  );
  assert.equal(outcome.result.status, "completed");
});

test("start, steer, reject, complete: an unconfirmed Control appears nowhere", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("starting"),
      { step: "await-control", confirm: false },
      emitText("unchanged"),
      { step: "complete" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, {
      input: input("run-1"),
      controls: [{ type: "steer", text: "guidance nobody confirmed" }],
    }),
  );

  // Delivered to the backend...
  assert.deepEqual(handle.counters().controlsReceived, [
    "guidance nobody confirmed",
  ]);
  // ...and never fabricated into the transcript, because the provider gave no
  // evidence that a model consumed it.
  assert.deepEqual(
    outcome.result.transcript.map((item) => item.role),
    ["assistant", "assistant"],
  );
});

test("Controls are delivered serially and in admission order", async () => {
  const handle = resumable({
    scripts: scripts([
      { step: "await-control", confirm: true },
      { step: "await-control", confirm: true },
      { step: "await-control", confirm: true },
      { step: "complete" },
    ]),
  });

  await withSubagent(handle, (agent) =>
    driveRun(agent, identity, {
      input: input("run-1"),
      controls: ["first", "second", "third"].map((text) => ({
        type: "steer" as const,
        text,
      })),
    }),
  );

  const counters = handle.counters();
  assert.deepEqual(counters.controlsReceived, ["first", "second", "third"]);
  assert.equal(counters.maxConcurrentControls, 1);
});

/* ============================================================== */
/* 3. start → cancel → partial result                             */
/* ============================================================== */

test("start, cancel, partial result: interruption yields a cancelled Run that keeps what it had", async () => {
  // A gate the test never completes, so the script is genuinely mid-flight
  // when the cancellation arrives. Created outside an Effect because the fake
  // is built before the scenario runs.
  const hold = Deferred.makeUnsafe<void>();
  const handle = resumable({
    gates: { hold },
    scripts: scripts([
      emitText("a partial answer"),
      { step: "cumulative-usage", total: { input: 20 } },
      emitToolCall("bash", "c1"),
      { step: "await-gate", gate: "hold" },
      emitText("never said"),
      { step: "complete" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      const cancelWhen = yield* Deferred.make<void>();
      const run = yield* Effect.forkChild(
        driveRun(agent, identity, { input: input("run-1"), cancelWhen }),
      );
      yield* Deferred.succeed(cancelWhen, undefined);
      return yield* Fiber.join(run);
    }),
  );

  assert.equal(outcome.resolution, "interrupted");
  assert.equal(outcome.result.status, "cancelled");
  assert.equal(outcome.result.cancellationReason, "requested");
  // Partial output survives.
  assert.equal(outcome.result.finalOutput, "a partial answer");
  assert.equal(outcome.result.usage.totals.input, 20);
  // A tool that never reported an outcome is marked, not left running.
  assert.deepEqual(
    outcome.result.tools.map((entry) => entry.status),
    ["cancelled"],
  );
  assert.deepEqual(outcome.phases, ["running", "finalizing", "cancelled"]);
  // And nothing leaked.
  const counters = handle.counters();
  assert.equal(counters.liveExecutions, 0);
  assert.equal(counters.liveSubscriptions, 0);
});

test("a Run may settle with no observations at all", async () => {
  const handle = resumable({ scripts: scripts([{ step: "hang" }]) });

  const outcome = await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      const cancelWhen = yield* Deferred.make<void>();
      const run = yield* Effect.forkChild(
        driveRun(agent, identity, { input: input("run-1"), cancelWhen }),
      );
      yield* Deferred.succeed(cancelWhen, undefined);
      return yield* Fiber.join(run);
    }),
  );

  assert.equal(outcome.result.status, "cancelled");
  assert.deepEqual(outcome.result.transcript, []);
  assert.equal(outcome.result.finalOutput, "");
  assert.equal(outcome.result.usage.totals.input, 0);
  assert.deepEqual(outcome.observations, []);
});

test("cancelling a Run whose backend hangs costs no real time", async () => {
  const startedAt = Date.now();
  const handle = resumable({
    scripts: scripts([emitText("waiting"), { step: "hang" }]),
  });

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const agent = yield* handle.backend
        .open(profile, context)
        .pipe(Scope.provide(scope));
      const cancelWhen = yield* Deferred.make<void>();
      const run = yield* Effect.forkChild(
        driveRun(agent, identity, { input: input("run-1"), cancelWhen }),
      );
      // An hour of patience, then cancel. The clock is a test clock, so the
      // hour costs nothing.
      yield* TestClock.adjust("1 hour");
      yield* Deferred.succeed(cancelWhen, undefined);
      const value = yield* Fiber.join(run);
      yield* Scope.close(scope, Exit.void);
      return value;
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assert.equal(outcome.result.status, "cancelled");
  assert.equal(outcome.result.finalOutput, "waiting");
  assert.ok(Date.now() - startedAt < 30_000);
});

/* ============================================================== */
/* 4. start → fail → diagnostic + partial result                  */
/* ============================================================== */

test("start, fail, diagnostic and partial result: a scripted failure keeps what the Run had", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("got this far"),
      emitToolCall("bash", "c1"),
      {
        step: "emit",
        observation: {
          kind: "diagnostic",
          diagnostic: {
            category: "backend-failure",
            message: "the backend gave up",
          },
        },
      },
      { step: "fail", message: "the backend gave up" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1") }),
  );

  assert.equal(outcome.resolution, "completed", "the backend failed politely");
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.errorMessage, "the backend gave up");
  assert.equal(outcome.result.finalOutput, "got this far");
  assert.deepEqual(outcome.result.diagnostics, [
    { category: "backend-failure", message: "the backend gave up" },
  ]);
  assert.deepEqual(
    outcome.result.tools.map((entry) => entry.status),
    ["failed"],
  );
});

test("a backend that throws is classified as failed, with a redacted diagnostic", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("got this far"),
      { step: "defect", message: "provider text nobody should keep" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1") }),
  );

  assert.equal(outcome.resolution, "defect");
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.finalOutput, "got this far");
  assert.deepEqual(outcome.result.diagnostics, [
    { category: "backend-failure", message: "[redacted]" },
  ]);
  // The defect's own words never reach the result.
  assert.equal(
    JSON.stringify(outcome.result).includes("provider text nobody should keep"),
    false,
  );
});

test("a failing observation sink cannot strand the execution", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("first"),
      emitText("second"),
      emitText("third"),
      { step: "complete" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1"), sinkFailsAt: 2 }),
  );

  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.finalOutput, "first");
  const counters = handle.counters();
  assert.equal(counters.liveExecutions, 0, "the execution was released");
  assert.equal(counters.liveSubscriptions, 0);
});

/* ============================================================== */
/* 5. complete → resume → new Run-local usage                     */
/* ============================================================== */

test("complete, resume, new Run-local usage: the second Run is charged only for its own work", async () => {
  const handle = resumable({
    scripts: scripts(
      [
        emitText("first answer"),
        { step: "cumulative-usage", total: { input: 100, output: 40 } },
        { step: "complete" },
      ],
      [
        { step: "replay-history" },
        emitText("second answer"),
        { step: "cumulative-usage", total: { input: 175, output: 65 } },
        { step: "complete" },
      ],
    ),
  });

  const { first, second } = await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      const firstRun = yield* driveRun(agent, identity, {
        input: input("run-1"),
      });
      // Resume is admissible only once an identity exists.
      assert.equal(agent.admitResume(), "admitted");
      const secondRun = yield* driveRun(agent, identity, {
        input: input("run-2"),
      });
      return { first: firstRun, second: secondRun };
    }),
  );

  assert.deepEqual(first.result.usage.totals, {
    input: 100,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
  // The provider's cumulative total includes both Runs...
  assert.deepEqual(handle.cumulativeTotals(), {
    input: 175,
    output: 65,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // ...and the second Run is charged for the difference alone.
  assert.deepEqual(second.result.usage.totals, {
    input: 75,
    output: 25,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
  // A replayed transcript is not new work.
  assert.equal(second.result.usage.turns, 1);
  assert.equal(second.result.finalOutput, "second answer");
  assert.notEqual(first.result.runId, second.result.runId);
});

test("the two Runs' results are independent and immutable", async () => {
  const handle = resumable({
    scripts: scripts(
      [emitText("first"), { step: "complete" }],
      [emitText("second"), { step: "complete" }],
    ),
  });

  const { first, second } = await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      const firstRun = yield* driveRun(agent, identity, {
        input: input("run-1"),
      });
      const secondRun = yield* driveRun(agent, identity, {
        input: input("run-2"),
      });
      return { first: firstRun, second: secondRun };
    }),
  );

  assert.equal(first.result.finalOutput, "first");
  assert.equal(second.result.finalOutput, "second");
  assert.equal(Object.isFrozen(first.result), true);
  assert.deepEqual(first.result.transcript.length, 1);
});

test("a BackendAgent has no identity to resume until its first Run starts", async () => {
  const handle = resumable({
    scripts: scripts([emitText("first"), { step: "complete" }]),
  });

  await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      // Unopened in the provider sense: nothing to resume, reported through
      // the existing outcome rather than a fourth one.
      assert.equal(handle.identityAcquired(), false);
      assert.equal(agent.admitResume(), "conversation lost");

      yield* driveRun(agent, identity, { input: input("run-1") });

      assert.equal(handle.identityAcquired(), true);
      assert.equal(agent.admitResume(), "admitted");
    }),
  );
});

test("a script that declares conversation loss makes the next resume honest", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("first"),
      { step: "lose-conversation" },
      { step: "complete" },
    ]),
  });

  await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      yield* driveRun(agent, identity, { input: input("run-1") });

      assert.equal(agent.admitResume(), "conversation lost");
    }),
  );
});

/* ============================================================== */
/* 6. shutdown → all retained resources close                     */
/* ============================================================== */

test("shutdown, all retained resources close: every counter returns to zero", async () => {
  const trace: string[] = [];
  const handle = resumable({
    trace,
    scripts: scripts(
      [emitText("first"), { step: "complete" }],
      [emitText("second"), { step: "complete" }],
    ),
  });

  await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      yield* driveRun(agent, identity, { input: input("run-1"), trace });
      yield* driveRun(agent, identity, { input: input("run-2"), trace });
    }),
  );

  const counters = handle.counters();
  assert.equal(counters.opens, 1);
  assert.equal(counters.closes, 1);
  assert.equal(counters.executionsStarted, 2);
  assert.equal(counters.liveExecutions, 0);
  assert.equal(counters.liveSubscriptions, 0);
  assert.equal(trace[trace.length - 1], "agent-closed");
});

test("closing a BackendAgent twice is a no-op, not a second close", async () => {
  const handle = resumable({
    scripts: scripts([emitText("first"), { step: "complete" }]),
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const agent = yield* handle.backend
        .open(profile, context)
        .pipe(Scope.provide(scope));
      yield* agent.close();
      yield* agent.close();
      // And the scope closing calls it a third time.
      yield* Scope.close(scope, Exit.void);
    }),
  );

  assert.equal(handle.counters().closes, 1);
});

test("an execution refused after close is the backend's own state saying no", async () => {
  const handle = resumable({
    scripts: scripts([emitText("never runs"), { step: "complete" }]),
  });

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const agent = yield* handle.backend
        .open(profile, context)
        .pipe(Scope.provide(scope));
      yield* agent.close();
      const value = yield* driveRun(agent, identity, { input: input("run-1") });
      yield* Scope.close(scope, Exit.void);
      return value;
    }),
  );

  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.errorMessage, "the BackendAgent is closed");
  assert.deepEqual(outcome.observations, []);
  assert.equal(handle.counters().executionsStarted, 0);
});

/* ============================================================== */
/* Late observations                                              */
/* ============================================================== */

test("a scripted late observation is ignored and changes nothing", async () => {
  const lateSteps: readonly FakeStep[] = [
    emitText("the answer"),
    { step: "announce-ending", ending: answeredEnding() },
    emitText("a frame nobody asked for"),
    { step: "cumulative-usage", total: { input: 9_999 } },
    { step: "complete" },
  ];
  const handle = resumable({ scripts: scripts(lateSteps) });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1") }),
  );

  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.finalOutput, "the answer");
  assert.equal(outcome.result.usage.totals.input, 0);
  assert.deepEqual(
    outcome.reports.map((report) => report.report),
    [
      "applied",
      "applied",
      "ignored-late",
      "ignored-late",
      // The bundle's own ending, arriving after one already won.
      "ignored-late",
    ],
  );
  assert.deepEqual(outcome.bundleReport, {
    report: "ignored-late",
    kind: "ending",
  });
});

test("the first ending wins and the bundle's later one is reported late", async () => {
  const handle = resumable({
    scripts: scripts([
      emitText("the answer"),
      { step: "announce-ending", ending: cancelledEnding("shutdown") },
      { step: "complete", ending: answeredEnding() },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1") }),
  );

  assert.equal(outcome.result.status, "cancelled");
  assert.equal(outcome.result.cancellationReason, "shutdown");
  assert.deepEqual(outcome.bundleReport, {
    report: "ignored-late",
    kind: "ending",
  });
});
