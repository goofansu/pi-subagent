import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Scope } from "effect";
import type { BackendAgent, ExecutionIO } from "../backend/contract.ts";
import {
  createRunProjection,
  DEFAULT_BACKEND_ID,
  type Profile,
  type RunObservation,
  type RunProjection,
  reduceRun,
  runId,
  type SubagentContext,
  subagentId,
} from "../domain/index.ts";
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
import {
  quiesce,
  rigRequest,
  startedRun,
  untilTerminal,
  withSession,
} from "./session-rig.ts";

/**
 * The one-shot fake: a backend that declares nothing.
 *
 * Its whole job is to be the backend that cannot do things, so that the rules
 * about *not* being able to do them are testable. A capability the core
 * enforces has to be enforced without calling the backend at all — otherwise
 * `unsupported` would cost a provider round trip — and the only way to check
 * that is with a backend that would notice being called.
 *
 * Most of these go through the supervisor, because that is what enforces the
 * rules. The last three are about the fake's *own* state — a closed
 * BackendAgent refusing work, and a backend that retains nothing between Runs
 * — and those are reached through the contract directly, because the whole
 * point is that the core is not involved.
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

/**
 * Run one execution against an already-open BackendAgent and fold what it
 * emitted.
 *
 * Deliberately not a lifecycle: no arbitration, no settlement, no result. It
 * is the smallest thing that can ask a fake what it says, for the tests that
 * are about the fake rather than about the runtime.
 */
function executeOnce(
  agent: BackendAgent,
  id: string,
): Effect.Effect<{
  readonly observations: readonly RunObservation[];
  readonly projection: RunProjection;
  readonly ending: string | undefined;
}> {
  return Effect.gen(function* () {
    const observations: RunObservation[] = [];
    let projection = createRunProjection();
    const io: ExecutionIO = {
      emit: (observation) =>
        Effect.sync(() => {
          observations.push(observation);
          projection = reduceRun(projection, observation).projection;
        }),
      controls: { take: Effect.succeed(undefined) },
    };
    const scope = yield* Scope.make();
    const bundle = yield* agent
      .execute(
        { runId: runId(id), description: "summarize", prompt: "summarize it" },
        io,
      )
      .pipe(Scope.provide(scope));
    yield* Scope.close(scope, Exit.void);
    projection = reduceRun(projection, {
      kind: "ending",
      ending: bundle.ending,
    }).projection;
    return { observations, projection, ending: bundle.ending.ending };
  });
}

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
    }).pipe(Effect.orDie),
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
  const { value } = await withSession(
    {
      resumable: false,
      steps: [[emitText("a summary"), { step: "complete" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, started.runId);
        return (yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        })).outcome;
      }),
  );

  // Not "conversation lost": this backend never had one to lose, and saying so
  // honestly is the difference between the two outcomes.
  assert.equal(value, "resume unsupported");
});

test("a Control offered to this backend is refused without it being called", async () => {
  const { value } = await withSession(
    {
      resumable: false,
      steps: [[emitText("a summary"), { step: "complete" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        const outcomes = [
          (yield* rig.supervisor.steer(started.runId, {
            type: "steer",
            text: "also check the tests",
          })).outcome,
          (yield* rig.supervisor.steer(started.runId, {
            type: "steer",
            text: "and the docs",
          })).outcome,
        ];
        yield* untilTerminal(rig, started.runId);
        return {
          outcomes,
          received: rig.backend.counters().controlsReceived,
          concurrent: rig.backend.counters().maxConcurrentControls,
          read: (yield* rig.supervisor.result(started.runId)).outcome,
        };
      }),
  );

  assert.deepEqual(value.outcomes, ["unsupported", "unsupported"]);
  // The backend saw nothing, so `unsupported` cost no provider work.
  assert.deepEqual(value.received, []);
  assert.equal(value.concurrent, 0);
  assert.equal(value.read, "result");
});

test("with no snapshot, the streamed projection is the result", async () => {
  const { value } = await withSession(
    {
      resumable: false,
      steps: [
        [
          emitToolCall("read_file", "c1"),
          emitToolProgress("c1", "completed", "40 lines"),
          emitText("the streamed summary"),
          { step: "cumulative-usage", total: { input: 60, output: 12 } },
          // No reconciliation: this backend has no snapshot and fabricates none.
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, started.runId);
        return yield* rig.supervisor.result(started.runId);
      }),
  );

  assert.equal(value.outcome, "result");
  if (value.outcome !== "result") return;
  const { result } = value;
  assert.equal(result.finalOutput, "the streamed summary");
  assert.deepEqual(
    result.transcript.map((item) =>
      item.parts.map((part) => (part.kind === "text" ? part.text : part.name)),
    ),
    [["read_file"], ["the streamed summary"]],
  );
  assert.deepEqual(result.usage.totals, {
    input: 60,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
  assert.deepEqual(result.tools, [
    {
      callId: "c1",
      name: "read_file",
      status: "completed",
      outputSummary: "40 lines",
    },
  ]);
});

test("every counter returns to zero when the Session Scope closes", async () => {
  const trace: string[] = [];
  const { value, noLeaks } = await withSession(
    {
      resumable: false,
      trace,
      steps: [[emitText("a summary"), { step: "complete" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return rig.backend;
      }),
  );

  const counters = value.counters();
  assert.equal(counters.opens - counters.closes, 0);
  assert.equal(counters.liveExecutions, 0);
  assert.equal(counters.liveSubscriptions, 0);
  assert.equal(counters.executionsStarted, 1);
  assert.equal(trace[trace.length - 1], "agent-closed");
  assert.equal(noLeaks, true);
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
      return yield* executeOnce(agent, "run-1");
    }),
  );

  // ADR-0023 exception 3: closure is enforced by the backend's own state,
  // never by trusting a provider to reject work after disposal.
  assert.equal(outcome.ending, "failed");
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
      // Two Runs on one BackendAgent, reached directly: the supervisor would
      // not admit the second, because this backend declares no resume. What
      // is being checked is what the *backend* retains, not what the core
      // allows.
      const firstRun = yield* executeOnce(agent, "run-1");
      const secondRun = yield* executeOnce(agent, "run-2");
      return { first: firstRun, second: secondRun };
    }),
  );

  // Nothing to replay, and the second Run's baseline is zero again because
  // there is no retained conversation to have spent anything.
  assert.deepEqual(
    second.projection.transcript.map((item) =>
      item.parts.map((part) => (part.kind === "text" ? part.text : part.name)),
    ),
    [["second summary"]],
  );
  assert.equal(first.projection.usage.totals.input, 50);
  assert.equal(second.projection.usage.totals.input, 50);
  assert.deepEqual(handle.history(), [
    { role: "assistant", parts: [{ kind: "text", text: "second summary" }] },
  ]);
});
