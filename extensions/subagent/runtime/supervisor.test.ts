import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { backendId, runId as makeRunId, subagentId } from "../domain/index.ts";
import { createFakeNotificationSink } from "../testing/fake-sink.ts";
import {
  createFakeResumableBackend,
  type FakeBackendHandle,
} from "../testing/fakes/backend.ts";
import { emitActivity, emitText, scripts } from "../testing/fakes/script.ts";
import { idInSameSessionAs, parseAllocatedId } from "../testing/identifiers.ts";
import {
  RIG_PROFILE,
  rigRequest as request,
  startedRun,
  untilTerminal,
  withSession,
} from "../testing/session-rig.ts";
import { untilExecutions } from "../testing/stress-policy.ts";
import { sessionRuntimeLayer } from "./composition.ts";
import { probeIsClear } from "./counters.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";
import { RunRepository } from "./repository.ts";
import { ResultStore } from "./result-store.ts";
import { RUN_STAGES } from "./run-scope.ts";
import { openBudgetExceededMessage, SubagentSupervisor } from "./supervisor.ts";

/**
 * The supervisor, driven through its public operations.
 *
 * This is the seam every later M2 test uses, so the first tests of it are the
 * ones that fix its shape: what a start returns, what admission refuses, what
 * a failed open leaves behind, and the order settlement goes in. Nothing here
 * lets real time pass and nothing sleeps.
 */

test("a start opens a Subagent, runs it, and its result is retrievable the instant it is terminal", async () => {
  const { value, noLeaks } = await withSession(
    { steps: [[emitText("on it"), emitText("the answer")]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));

        yield* untilTerminal(rig, started.runId);
        // The invariant the settlement order exists for: the moment the
        // snapshot is terminal, the result is there.
        const known = yield* rig.repository.lookup(started.runId);
        const result = yield* rig.supervisor.result(started.runId);

        return {
          state: known.state,
          status:
            known.state === "terminal"
              ? known.snapshot.terminalStatus
              : undefined,
          result,
          stages: rig.supervisor.stages(),
        };
      }),
  );

  assert.equal(value?.state, "terminal");
  assert.equal(value?.status, "completed");
  assert.equal(value?.result.outcome, "result");
  if (value?.result.outcome === "result") {
    assert.equal(value.result.result.finalOutput, "the answer");
    assert.equal(value.result.result.agent, "explore");
    assert.equal(value.result.result.description, "look around");
    assert.deepEqual(
      value.result.result.transcript.map((item) =>
        item.parts
          .map((part) => (part.kind === "text" ? part.text : ""))
          .join(""),
      ),
      ["on it", "the answer"],
    );
  }
  assert.equal(noLeaks, true);
});

test("settlement goes in the roadmap's order, and the result is committed before the terminal snapshot", async () => {
  const { value } = await withSession({ steps: [[emitText("done")]] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(yield* rig.supervisor.start(request()));
      yield* untilTerminal(rig, started.runId);
      return rig.supervisor
        .stages()
        .map((stage) => stage.slice(stage.indexOf(":") + 1));
    }),
  );

  assert.deepEqual(value, [
    RUN_STAGES.candidateCaptured,
    RUN_STAGES.intakeSealed,
    RUN_STAGES.finalizingPublished,
    RUN_STAGES.executionScopeClosed,
    RUN_STAGES.observationsDrained,
    RUN_STAGES.resultProduced,
    RUN_STAGES.runScopeClosed,
    RUN_STAGES.resultCommitted,
    RUN_STAGES.terminalPublished,
    RUN_STAGES.waitersWoken,
    RUN_STAGES.deliveryInitiated,
  ]);
});

test("the repository shows running, then finalizing, then the terminal phase", async () => {
  const release = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      steps: [[emitText("working"), { step: "await-gate", gate: "finish" }]],
      gates: { finish: release },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));

        const running = yield* rig.repository.get(started.runId);
        const duringRun = yield* rig.supervisor.result(started.runId);

        yield* Deferred.succeed(release, undefined);
        yield* untilTerminal(rig, started.runId);
        const settled = yield* rig.repository.get(started.runId);
        const afterRun = yield* rig.supervisor.result(started.runId);

        return {
          runningPhase: running?.phase,
          duringRun: duringRun.outcome,
          settledPhase: settled?.phase,
          afterRun: afterRun.outcome,
        };
      }),
  );

  assert.deepEqual(value, {
    runningPhase: "running",
    // While the Run is active, there is no result and saying so is the answer.
    duringRun: "RunNotTerminal",
    settledPhase: "completed",
    afterRun: "result",
  });
});

test("two concurrent starts against a capacity of one produce one started and one at capacity", async () => {
  const policy: RuntimePolicy = { ...DEFAULT_RUNTIME_POLICY, maxActiveRuns: 1 };
  const release = await Effect.runPromise(Deferred.make<void>());

  const { value } = await withSession(
    {
      policy,
      steps: [[{ step: "await-gate", gate: "hold" }], [emitText("second")]],
      gates: { hold: release },
    },
    (rig) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [rig.supervisor.start(request()), rig.supervisor.start(request())],
          { concurrency: 2 },
        );
        yield* Deferred.succeed(release, undefined);
        return [first.outcome, second.outcome].sort();
      }),
  );

  // Exactly one winner, and the loser learned immediately — nothing queued.
  assert.deepEqual(value, ["at capacity", "started"]);
});

test("a start whose backend cannot open returns backend unavailable and leaves nothing", async () => {
  const trace: string[] = [];
  const { value, noLeaks } = await withSession(
    {
      trace,
      open: { open: "fails", reason: "the provider refused the connection" },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = yield* rig.supervisor.start(request());
        // Nothing was published, and nothing was reserved that is still held.
        return {
          started,
          published: (yield* rig.repository.list()).length,
          active: yield* rig.repository.activeCount(),
          accounted: yield* rig.store.accountedBytes(),
          // A second start can still be admitted: the capacity claim went back.
          next: (yield* rig.supervisor.start(request())).outcome,
        };
      }),
  );

  assert.deepEqual(value?.started, {
    outcome: "backend unavailable",
    diagnostic: { category: "backend-failure", message: "[redacted]" },
  });
  assert.equal(value?.published, 0);
  assert.equal(value?.active, 0);
  assert.equal(value?.accounted, 0);
  assert.equal(value?.next, "backend unavailable");
  // The provider's own words stayed with the adapter.
  assert.deepEqual(trace, [
    "agent-open-failed:the provider refused the connection",
    "agent-open-failed:the provider refused the connection",
  ]);
  assert.equal(noLeaks, true);
});

test("identifiers spent by a start that failed at open never come back", async () => {
  const { value } = await withSession(
    { open: { open: "fails", reason: "no" } },
    (rig) =>
      Effect.gen(function* () {
        yield* rig.supervisor.start(request());
        // The first start spent one identifier of each kind before it failed;
        // the next allocation of each kind must be past them.
        const nextSubagent = yield* rig.repository.allocateSubagentId();
        const nextRun = yield* rig.repository.allocateRunId();
        // Nobody ever received the abandoned pair, so the only way to name it
        // is as the first of each kind in the Session that just minted these.
        return {
          nextSubagent,
          nextRun,
          firstRunSpent: yield* rig.repository.isSpent(
            idInSameSessionAs(nextRun, "run", 1),
          ),
          firstSubagentSpent: yield* rig.repository.isSpent(
            idInSameSessionAs(nextSubagent, "subagent", 1),
          ),
        };
      }),
  );

  assert.equal(value?.firstSubagentSpent, true);
  assert.equal(value?.firstRunSpent, true);
  // And second of each kind, not first: what was spent was never handed out.
  assert.equal(parseAllocatedId(value?.nextSubagent ?? "").sequence, 2);
  assert.equal(parseAllocatedId(value?.nextRun ?? "").sequence, 2);
});

test("an unknown agent and an invalid Profile are different answers", async () => {
  const { value } = await withSession(
    {
      profiles: [],
    },
    (rig) =>
      Effect.gen(function* () {
        return {
          unknown: yield* rig.supervisor.start(request({ agent: "nobody" })),
        };
      }),
  );

  assert.deepEqual(value?.unknown, {
    outcome: "unknown agent",
    agent: "nobody",
  });
});

test("a start past the delegation depth is refused before anything is allocated", async () => {
  const { value } = await withSession({ maxDelegationDepth: 1 }, (rig) =>
    Effect.gen(function* () {
      const refused = yield* rig.supervisor.start(request({ childDepth: 5 }));
      return {
        refused,
        published: (yield* rig.repository.list()).length,
        // Nothing was allocated, so the first allocation is still the first.
        nextRun: yield* rig.repository.allocateRunId(),
      };
    }),
  );

  assert.deepEqual(value?.refused, {
    outcome: "delegation-depth exceeded",
    depth: 5,
  });
  assert.equal(value?.published, 0);
  assert.equal(parseAllocatedId(value?.nextRun ?? "").sequence, 1);
});

test("a resume on a running Subagent is refused, and on an idle one it starts", async () => {
  const release = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      steps: [
        [{ step: "await-gate", gate: "hold" }, emitText("first")],
        [emitText("second")],
      ],
      gates: { hold: release },
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));

        const whileRunning = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again please",
        });

        yield* Deferred.succeed(release, undefined);
        yield* untilTerminal(rig, started.runId);

        const whenIdle = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again please",
        });
        if (whenIdle.outcome === "started") {
          yield* untilTerminal(rig, whenIdle.runId);
        }
        const unknown = yield* rig.supervisor.resume({
          subagentId: started.subagentId.replace(
            "1",
            "9",
          ) as typeof started.subagentId,
          description: "d",
          prompt: "p",
        });

        return {
          whileRunning: whileRunning.outcome,
          whenIdle: whenIdle.outcome,
          unknown: unknown.outcome,
          second:
            whenIdle.outcome === "started"
              ? yield* rig.supervisor.result(whenIdle.runId)
              : undefined,
        };
      }),
  );

  assert.equal(value?.whileRunning, "Subagent already running");
  assert.equal(value?.whenIdle, "started");
  assert.equal(value?.unknown, "unknown Subagent");
  assert.equal(value?.second?.outcome, "result");
});

test("a resume after the conversation is lost reports the loss, not a failure", async () => {
  const { value } = await withSession(
    {
      steps: [
        [emitText("once"), { step: "lose-conversation" }],
        [emitText("twice")],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        const refused = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        });
        return {
          refused: refused.outcome,
          executions: rig.backend.counters().executionsStarted,
          // The Subagent is still there and still idle: a lost conversation
          // is not a closed Subagent.
          active: yield* rig.repository.activeCount(),
        };
      }),
  );

  assert.equal(value?.refused, "conversation lost");
  assert.equal(value?.executions, 1);
  assert.equal(value?.active, 0);
});

test("a start whose backend hangs while opening is rejected when the budget runs out", async () => {
  const policy: RuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    openBudgetMillis: 5_000,
  };
  const backend = createFakeResumableBackend({
    scripts: scripts([]),
    open: { open: "hangs" },
  });

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const supervisor = yield* SubagentSupervisor;
      const repository = yield* RunRepository;
      const store = yield* ResultStore;
      const starting = yield* Effect.forkChild(supervisor.start(request()));
      // No real time passes: the budget expires because the test clock says so.
      yield* TestClock.adjust(policy.openBudgetMillis + 1);
      const started = yield* Fiber.join(starting);
      return {
        started,
        published: (yield* repository.list()).length,
        accounted: yield* store.accountedBytes(),
        probe: probeIsClear(supervisor.probe()),
      };
    }).pipe(
      Effect.provide(
        sessionRuntimeLayer({
          backends: [backend.backend],
          sink: createFakeNotificationSink(),
          profiles: {
            from: "list",
            profiles: [{ ...RIG_PROFILE, backend: backend.backend.id }],
          },
          policy,
        }),
      ),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    ),
  );

  assert.equal(outcome.started.outcome, "backend unavailable");
  if (outcome.started.outcome === "backend unavailable") {
    assert.equal(outcome.started.diagnostic.category, "backend-failure");
    // No provider text — the backend never got to say anything — and the
    // reason names the budget, so a maintainer can tell a hung open from an
    // adapter that died.
    assert.equal(
      outcome.started.diagnostic.message,
      openBudgetExceededMessage(policy.openBudgetMillis),
    );
  }
  assert.equal(outcome.published, 0);
  assert.equal(outcome.accounted, 0);
  assert.equal(outcome.probe, true);
  assert.equal(backend.counters().opens, 0);
});

test("a resume on a backend that cannot resume is refused without provider I/O", async () => {
  const { value } = await withSession(
    { resumable: false, steps: [[emitText("once")], [emitText("twice")]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        const refused = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        });
        return {
          refused: refused.outcome,
          executions: rig.backend.counters().executionsStarted,
        };
      }),
  );

  assert.equal(value?.refused, "resume unsupported");
  // One execution: the refusal reached no provider.
  assert.equal(value?.executions, 1);
});

test("a malformed observation becomes a diagnostic on the Run and the execution continues", async () => {
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("before"),
          {
            step: "emit",
            observation: {
              kind: "message",
              role: "user",
              parts: [],
              threadId: "t-1",
            } as never,
          },
          emitText("after"),
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        return {
          result: yield* rig.supervisor.result(started.runId),
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.equal(value?.result.outcome, "result");
  if (value?.result.outcome !== "result") return;
  const { result } = value.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.category),
    ["backend-failure"],
  );
  assert.match(result.diagnostics[0].message, /cannot read/);
  // The reason names the key, and never the value.
  assert.match(result.diagnostics[0].message, /threadId/);
  // The valid observations either side of it were reduced in order.
  assert.deepEqual(
    result.transcript.map((item) =>
      item.parts
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join(""),
    ),
    ["before", "after"],
  );
  assert.equal(value.counters.seamDecodeFailures, 1);
});

test("a defect in the execution settles the Run as failed with its observations kept", async () => {
  const { value, noLeaks } = await withSession(
    {
      steps: [
        [
          emitText("got this far"),
          emitActivity("thinking"),
          { step: "defect", message: "the adapter threw" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        return {
          result: yield* rig.supervisor.result(started.runId),
          snapshot: yield* rig.repository.get(started.runId),
        };
      }),
  );

  assert.equal(value?.result.outcome, "result");
  if (value?.result.outcome !== "result") return;
  const { result } = value.result;
  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "the backend execution failed");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.category),
    ["backend-failure"],
  );
  // Whatever the adapter threw stayed with the adapter.
  assert.equal(result.diagnostics[0].message, "[redacted]");
  assert.equal(result.finalOutput, "got this far");
  // A settled Run is quiet.
  assert.equal(value.snapshot?.activity, undefined);
  assert.equal(noLeaks, true);
});

test("an ending announced in the stream wins, and the bundle's is late", async () => {
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("the answer"),
          { step: "announce-ending", ending: { ending: "answered" } },
          emitText("said after the ending"),
          { step: "fail", message: "and then it said it failed" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        return {
          result: yield* rig.supervisor.result(started.runId),
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.equal(value?.result.outcome, "result");
  if (value?.result.outcome !== "result") return;
  // First ending wins.
  assert.equal(value.result.result.status, "completed");
  assert.equal(value.result.result.finalOutput, "the answer");
  assert.ok(value.counters.lateEndings >= 1);
  // The bundle was a second candidate for a Run that already had one.
  assert.ok(value.counters.duplicateSettlements >= 1);
});

test("emitting after intake is sealed is a no-op that counts a late event", async () => {
  // The fake emits from its execution scope's finalizer, which runs after
  // settlement has sealed intake. The contract says emit never fails, so this
  // has to be a counted no-op rather than a throw at an adapter on its way out.
  const { value } = await withSession(
    {
      steps: [
        [
          {
            step: "emit-in-finalizer",
            observation: {
              kind: "message",
              role: "assistant",
              parts: [{ kind: "text", text: "said during teardown" }],
            },
          },
          emitText("the answer"),
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        const first = yield* rig.supervisor.result(started.runId);
        const again = yield* rig.supervisor.result(started.runId);
        return { first, again, counters: rig.supervisor.counters() };
      }),
  );

  assert.equal(value?.first.outcome, "result");
  if (value?.first.outcome !== "result") return;
  // The late observation reached nothing.
  assert.equal(value.first.result.finalOutput, "the answer");
  assert.deepEqual(
    value.first.result.transcript.map((item) =>
      item.parts
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join(""),
    ),
    ["the answer"],
  );
  assert.equal(value.counters.lateEvents, 1);
  // And repeated reads give the same immutable value.
  assert.equal(value.again.outcome, "result");
  if (value.again.outcome === "result") {
    assert.deepEqual(value.again.result, value.first.result);
  }
});

test("one undecodable stored entry read through agent_result counts once", async () => {
  const { value } = await withSession(
    {
      steps: [[emitText("the answer")]],
      resultEncoder: (_result, encode) => ({
        ...(encode(_result) as Record<string, unknown>),
        unexpected: true,
      }),
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        // Delivery reads first and discovers the stored form is undecodable.
        for (let step = 0; step < 10; step += 1) {
          if (rig.sink.unannounceableRuns().length > 0) break;
          yield* Effect.yieldNow;
        }
        assert.deepEqual(rig.sink.unannounceableRuns(), [started.runId]);
        const result = yield* rig.supervisor.result(started.runId);
        return { result, counters: rig.supervisor.counters() };
      }),
  );

  assert.equal(value.result.outcome, "ResultExpired");
  assert.equal(value.counters.unreadableResults, 1);
});

test("a terminal Run with no Result store entry counts once", async () => {
  const { value } = await withSession({}, (rig) =>
    Effect.gen(function* () {
      const id = makeRunId("run-missing-result");
      yield* rig.repository.publish(
        {
          runId: id,
          subagentId: subagentId("subagent-missing-result"),
          backendId: backendId("fake-resumable"),
          agent: "explore",
          description: "missing output",
        },
        0,
      );
      yield* rig.repository.transition(id, "execution-ended");
      yield* rig.repository.transition(id, "settled-failed", 1);

      const result = yield* rig.supervisor.result(id);
      return { result, counters: rig.supervisor.counters() };
    }),
  );

  assert.equal(value.result.outcome, "ResultExpired");
  assert.equal(value.counters.unreadableResults, 1);
});

test("a result for an id no Run ever had is unknown, not expired", async () => {
  const { value } = await withSession({}, (rig) =>
    rig.supervisor.result(makeRunId("run-never")),
  );

  assert.deepEqual(value, { outcome: "unknown Run", runId: "run-never" });
});

test("closing the Session Scope closes every BackendAgent beneath it", async () => {
  const trace: string[] = [];
  let handle: FakeBackendHandle | undefined;
  const { noLeaks } = await withSession(
    { trace, steps: [[emitText("done")]] },
    (rig) =>
      Effect.gen(function* () {
        handle = rig.backend;
        const started = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, started.runId);
        // Still open while the Session is: a settled Run leaves its Subagent
        // idle, not closed.
        assert.equal(rig.backend.counters().closes, 0);
      }),
  );

  assert.equal(handle?.counters().opens, 1);
  assert.equal(handle?.counters().closes, 1);
  assert.equal(handle?.counters().liveExecutions, 0);
  assert.equal(handle?.counters().liveSubscriptions, 0);
  assert.equal(noLeaks, true);
  assert.ok(trace.includes("agent-closed"));
});

test("a Run that outlives the body is still closed by the Session Scope", async () => {
  const never = await Effect.runPromise(Deferred.make<void>());
  let handle: FakeBackendHandle | undefined;
  const { noLeaks } = await withSession(
    { steps: [[{ step: "await-gate", gate: "never" }]], gates: { never } },
    (rig) =>
      Effect.gen(function* () {
        handle = rig.backend;
        const started = yield* rig.supervisor.start(request());
        assert.equal(started.outcome, "started");
        yield* untilExecutions(rig, 1);
        // Left running deliberately. Closing the Session Scope has to reach it.
      }),
  );

  assert.equal(handle?.counters().closes, 1);
  assert.equal(handle?.counters().liveExecutions, 0);
  assert.equal(handle?.counters().liveSubscriptions, 0);
  assert.equal(noLeaks, true);
});

test("no test in this file lets a fiber outlive its Session", async () => {
  // A guard on the guard: `withSession` reads the probe after the Session
  // Scope has closed, and every test above asserts on the value it returned.
  const { noLeaks } = await withSession({}, () => Effect.succeed(0));
  assert.equal(noLeaks, true);
});

/** Unused in this file, kept so the fiber import is not dead. */
export type Unused = Fiber.Fiber<void, never>;
