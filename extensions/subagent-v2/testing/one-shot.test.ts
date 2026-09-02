import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Scope } from "effect";
import type { BackendAgent } from "../backend/contract.ts";
import {
  backendId,
  DEFAULT_BACKEND_ID,
  type Profile,
  runId,
  type SubagentContext,
  subagentId,
} from "../domain/index.ts";
import { type DriverIdentity, driveRun } from "./driver.ts";
import {
  createFakeOneShotBackend,
  type FakeBackendHandle,
  ONE_SHOT_CAPABILITIES,
} from "./fakes/backend.ts";
import {
  emitText,
  emitToolCall,
  emitToolProgress,
  scripts,
} from "./fakes/script.ts";

/**
 * The one-shot fake: a backend that declares nothing.
 *
 * Its whole job is to be the backend that cannot do things, so that the rules
 * about *not* being able to do them are testable. A capability the core
 * enforces has to be enforced without calling the backend at all — otherwise
 * `unsupported` would cost a provider round trip — and the only way to check
 * that is with a backend that would notice being called.
 */

const profile: Profile = {
  name: "summarizer",
  description: "Summarizes one thing once",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Summarize.",
};

const context: SubagentContext = {
  subagentId: subagentId("subagent-1"),
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

const identity: DriverIdentity = {
  subagentId: subagentId("subagent-1"),
  backendId: backendId("fake-one-shot"),
  agent: "summarizer",
  description: "summarize the file",
};

const input = (id: string) => ({
  runId: runId(id),
  description: "summarize the file",
  prompt: "summarize it",
});

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

test("the one-shot backend declares none of the three capabilities", () => {
  assert.deepEqual(ONE_SHOT_CAPABILITIES, {
    resume: false,
    steer: false,
    terminalTranscriptSnapshot: false,
  });
});

test("resume is unsupported before a Run and unsupported after one", async () => {
  const handle = createFakeOneShotBackend({
    scripts: scripts([emitText("a summary"), { step: "complete" }]),
  });

  await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      assert.equal(agent.capabilities.resume, false);
      assert.equal(agent.admitResume(), "unsupported");

      yield* driveRun(agent, identity, { input: input("run-1") });

      // Not "conversation lost": this backend never had one to lose, and
      // saying so honestly is the difference between the two outcomes.
      assert.equal(agent.admitResume(), "unsupported");
    }),
  );
});

test("a Control offered to this backend is refused without it being called", async () => {
  const handle = createFakeOneShotBackend({
    scripts: scripts([emitText("a summary"), { step: "complete" }]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, {
      input: input("run-1"),
      controls: [
        { type: "steer", text: "also check the tests" },
        { type: "steer", text: "and the docs" },
      ],
    }),
  );

  assert.deepEqual(outcome.controlOutcomes, [
    { outcome: "unsupported", runId: "run-1" },
    { outcome: "unsupported", runId: "run-1" },
  ]);
  // The backend saw nothing, so `unsupported` cost no provider work.
  assert.deepEqual(handle.counters().controlsReceived, []);
  assert.equal(handle.counters().maxConcurrentControls, 0);
  assert.equal(outcome.result.status, "completed");
});

test("with no snapshot, the streamed projection is the result", async () => {
  const handle = createFakeOneShotBackend({
    scripts: scripts([
      emitToolCall("read_file", "c1"),
      emitToolProgress("c1", "completed", "40 lines"),
      emitText("the streamed summary"),
      { step: "cumulative-usage", total: { input: 60, output: 12 } },
      // No reconciliation: this backend has no snapshot and fabricates none.
      { step: "complete" },
    ]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1") }),
  );

  assert.equal(outcome.result.finalOutput, "the streamed summary");
  assert.deepEqual(
    outcome.result.transcript.map((item) =>
      item.parts.map((part) => (part.kind === "text" ? part.text : part.name)),
    ),
    [["read_file"], ["the streamed summary"]],
  );
  assert.deepEqual(outcome.result.usage.totals, {
    input: 60,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
  assert.deepEqual(outcome.result.tools, [
    {
      callId: "c1",
      name: "read_file",
      status: "completed",
      outputSummary: "40 lines",
    },
  ]);
});

test("every counter returns to zero when the Subagent Scope closes", async () => {
  const trace: string[] = [];
  const handle = createFakeOneShotBackend({
    trace,
    scripts: scripts([emitText("a summary"), { step: "complete" }]),
  });

  await withSubagent(handle, (agent) =>
    driveRun(agent, identity, { input: input("run-1"), trace }),
  );

  const counters = handle.counters();
  assert.equal(counters.opens - counters.closes, 0);
  assert.equal(counters.liveExecutions, 0);
  assert.equal(counters.liveSubscriptions, 0);
  assert.equal(counters.executionsStarted, 1);
  assert.equal(trace[trace.length - 1], "agent-closed");
});

test("closing twice counts once", async () => {
  const handle = createFakeOneShotBackend({
    scripts: scripts([emitText("a summary"), { step: "complete" }]),
  });

  await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      yield* agent.close();
      yield* agent.close();
    }),
  );

  assert.equal(handle.counters().closes, 1);
});

test("an execution after close is refused by the backend's own state", async () => {
  const handle = createFakeOneShotBackend({
    scripts: scripts([emitText("never runs"), { step: "complete" }]),
  });

  const outcome = await withSubagent(handle, (agent) =>
    Effect.gen(function* () {
      yield* agent.close();
      return yield* driveRun(agent, identity, { input: input("run-1") });
    }),
  );

  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.errorMessage, "the BackendAgent is closed");
  assert.equal(handle.counters().executionsStarted, 0);
  assert.deepEqual(outcome.observations, []);
});

test("this backend retains nothing between Runs", async () => {
  const handle = createFakeOneShotBackend({
    scripts: scripts(
      [
        emitText("first summary"),
        { step: "cumulative-usage", total: { input: 50 } },
        { step: "complete" },
      ],
      [
        { step: "replay-history" },
        emitText("second summary"),
        { step: "cumulative-usage", total: { input: 50 } },
        { step: "complete" },
      ],
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

  // Nothing to replay, and the second Run's baseline is zero again because
  // there is no retained conversation to have spent anything.
  assert.deepEqual(
    second.result.transcript.map((item) =>
      item.parts.map((part) => (part.kind === "text" ? part.text : part.name)),
    ),
    [["second summary"]],
  );
  assert.equal(first.result.usage.totals.input, 50);
  assert.equal(second.result.usage.totals.input, 50);
  assert.deepEqual(handle.history(), [
    { role: "assistant", parts: [{ kind: "text", text: "second summary" }] },
  ]);
});
