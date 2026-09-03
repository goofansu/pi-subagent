import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect } from "effect";
import type { RunResult } from "../domain/index.ts";
import { RUN_STAGES } from "../runtime/run-scope.ts";
import { emitText, emitToolCall, emitToolProgress } from "./fakes/script.ts";
import {
  quiesce,
  rigRequest,
  startedRun,
  untilTerminal,
  untilUnderWay,
  withSession,
} from "./session-rig.ts";

/**
 * The six lifecycle scenarios, end to end, through the supervisor.
 *
 * M1 wrote these against a throwaway driver, because there was no supervisor
 * to write them against. They now go through `start`, `steer`, `cancel`,
 * `wait`, `result`, and `shutdown` — the operations the product actually
 * exposes — which is what makes them evidence rather than agreement between
 * two things written together.
 *
 * The narrow properties each M1 test isolated (ending arbitration, usage
 * locality, reconciliation, capability enforcement, control ordering) now live
 * in the shared conformance suite, where every real adapter will run them from
 * M4. What is here is the *walk*: the whole of one scenario, in order, with
 * the things a caller observes checked at each step.
 */

const texts = (result: RunResult): string[] =>
  result.transcript.map((item) =>
    item.parts.map((part) => (part.kind === "text" ? part.text : "")).join(""),
  );

/* -------------------------------------------------------------- */
/* 1. Start, progress, complete, result                            */
/* -------------------------------------------------------------- */

test("start, progress, complete, result: the result is every observation, in order", async () => {
  const { value, noLeaks } = await withSession(
    {
      steps: [
        [
          emitText("looking"),
          emitToolCall("read_file", "c1"),
          emitToolProgress("c1", "completed", "40 lines"),
          { step: "cumulative-usage", total: { input: 60, output: 12 } },
          emitText("the answer"),
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        const waited = yield* rig.supervisor.wait([started.runId]);
        const read = yield* rig.supervisor.result(started.runId);
        yield* quiesce();
        return { started, waited, read, notices: rig.sink.received() };
      }),
  );

  assert.deepEqual(value.waited, [
    { outcome: "terminal", runId: value.started.runId, status: "completed" },
  ]);
  assert.equal(value.read.outcome, "result");
  if (value.read.outcome !== "result") return;
  const { result } = value.read;
  assert.equal(result.status, "completed");
  assert.equal(result.finalOutput, "the answer");
  assert.deepEqual(texts(result), ["looking", "", "the answer"]);
  assert.deepEqual(result.tools, [
    {
      callId: "c1",
      name: "read_file",
      status: "completed",
      outputSummary: "40 lines",
    },
  ]);
  assert.deepEqual(result.usage.totals, {
    input: 60,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
  assert.equal(result.usage.turns, 1);
  // One completion notice, pointing at the result rather than carrying it.
  assert.equal(value.notices.length, 1);
  assert.equal(value.notices[0].retrieveWith, "agent_result");
  assert.equal(noLeaks, true);
});

test("the result exists only after the execution scope has closed", async () => {
  const { value } = await withSession({ steps: [[emitText("done")]] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(yield* rig.supervisor.start(rigRequest()));
      yield* untilTerminal(rig, started.runId);
      return rig.supervisor.stages();
    }),
  );

  const closed = value.findIndex((stage) =>
    stage.endsWith(RUN_STAGES.executionScopeClosed),
  );
  const produced = value.findIndex((stage) =>
    stage.endsWith(RUN_STAGES.resultProduced),
  );
  assert.ok(closed !== -1 && produced !== -1);
  assert.ok(closed < produced, "the result existed before the finalizers ran");
});

/* -------------------------------------------------------------- */
/* 2. Start, steer, confirm, complete                              */
/* -------------------------------------------------------------- */

test("start, steer, confirm, complete: a confirmed Control becomes a user observation", async () => {
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("under way"),
          { step: "await-control", confirm: true },
          emitText("the answer"),
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilUnderWay(rig);
        const admitted = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "also check the tests",
        });
        yield* untilTerminal(rig, started.runId);
        return {
          admitted: admitted.outcome,
          read: yield* rig.supervisor.result(started.runId),
          received: rig.backend.counters().controlsReceived,
        };
      }),
  );

  assert.equal(value.admitted, "accepted");
  assert.deepEqual(value.received, ["also check the tests"]);
  assert.equal(value.read.outcome, "result");
  if (value.read.outcome !== "result") return;
  assert.deepEqual(texts(value.read.result), [
    "under way",
    "also check the tests",
    "the answer",
  ]);
});

test("start, steer, reject, complete: an unconfirmed Control appears nowhere", async () => {
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("under way"),
          { step: "await-control", confirm: false },
          emitText("the answer"),
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilUnderWay(rig);
        yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "guidance the provider ignored",
        });
        yield* untilTerminal(rig, started.runId);
        return {
          read: yield* rig.supervisor.result(started.runId),
          received: rig.backend.counters().controlsReceived,
        };
      }),
  );

  // The backend received it; the provider never confirmed it; so nothing about
  // it is claimed on the Run. `accepted` was never a promise that it landed.
  assert.deepEqual(value.received, ["guidance the provider ignored"]);
  assert.equal(value.read.outcome, "result");
  if (value.read.outcome !== "result") return;
  assert.deepEqual(texts(value.read.result), ["under way", "the answer"]);
});

/* -------------------------------------------------------------- */
/* 3. Start, cancel, partial result                                */
/* -------------------------------------------------------------- */

test("start, cancel, partial result: a cancelled Run keeps what it had", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value, noLeaks } = await withSession(
    {
      gates: { hold },
      steps: [
        [
          emitText("a partial answer"),
          emitToolCall("bash", "c1"),
          { step: "await-gate", gate: "hold" },
          emitText("never said"),
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilUnderWay(rig);
        for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
        const [cancelled] = yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        return {
          cancelled: cancelled.outcome,
          read: yield* rig.supervisor.result(started.runId),
          // Cancelling a Run does not close its Subagent.
          closes: rig.backend.counters().closes,
        };
      }),
  );

  assert.equal(value.cancelled, "admitted");
  assert.equal(value.closes, 0);
  assert.equal(value.read.outcome, "result");
  if (value.read.outcome !== "result") return;
  const { result } = value.read;
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancellationReason, "requested");
  assert.equal(result.finalOutput, "a partial answer");
  // A tool that never reported an outcome is marked with the Run's.
  assert.deepEqual(
    result.tools.map((entry) => entry.status),
    ["cancelled"],
  );
  assert.equal(noLeaks, true);
});

test("a Run whose backend hangs is cancellable, and no real time passes", async () => {
  const started = Date.now();
  const { value } = await withSession({ steps: [[{ step: "hang" }]] }, (rig) =>
    Effect.gen(function* () {
      const run = startedRun(yield* rig.supervisor.start(rigRequest()));
      yield* untilUnderWay(rig);
      yield* rig.supervisor.cancel([run.runId]);
      yield* untilTerminal(rig, run.runId);
      return yield* rig.supervisor.result(run.runId);
    }),
  );

  assert.equal(value.outcome, "result");
  if (value.outcome === "result")
    assert.equal(value.result.status, "cancelled");
  assert.ok(Date.now() - started < 5_000);
});

/* -------------------------------------------------------------- */
/* 4. Start, fail, diagnostic and partial result                   */
/* -------------------------------------------------------------- */

test("start, fail, partial result: a scripted failure keeps what the Run had", async () => {
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("as far as it got"),
          {
            step: "emit",
            observation: {
              kind: "diagnostic",
              diagnostic: {
                category: "transport-loss",
                message: "the connection dropped",
              },
            },
          },
          { step: "fail", message: "the provider gave up" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, run.runId);
        return yield* rig.supervisor.result(run.runId);
      }),
  );

  assert.equal(value.outcome, "result");
  if (value.outcome !== "result") return;
  const { result } = value;
  assert.equal(result.status, "failed");
  // A well-behaved backend fails through its ending, not through its Effect,
  // so its own message survives rather than being redacted.
  assert.equal(result.errorMessage, "the provider gave up");
  assert.equal(result.finalOutput, "as far as it got");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.category),
    ["transport-loss"],
  );
});

test("a backend that throws is classified as failed, with a redacted diagnostic", async () => {
  const { value } = await withSession(
    {
      steps: [
        [emitText("said this much"), { step: "defect", message: "boom" }],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, run.runId);
        return yield* rig.supervisor.result(run.runId);
      }),
  );

  assert.equal(value.outcome, "result");
  if (value.outcome !== "result") return;
  const { result } = value;
  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "the backend execution failed");
  assert.deepEqual(result.diagnostics, [
    { category: "backend-failure", message: "[redacted]" },
  ]);
  // Whatever it threw stayed with the adapter, and what it managed to say is
  // still on the Run.
  assert.equal(result.finalOutput, "said this much");
});

/* -------------------------------------------------------------- */
/* 5. Complete, resume, new Run-local usage                        */
/* -------------------------------------------------------------- */

test("complete, resume, result: the second Run is charged only for its own work", async () => {
  const { value } = await withSession(
    {
      steps: [
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
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, first.runId);

        const resumed = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "and now the other file",
        });
        if (resumed.outcome !== "started") {
          throw new Error(`resume answered '${resumed.outcome}'`);
        }
        yield* untilTerminal(rig, resumed.runId);
        yield* quiesce();

        return {
          first: yield* rig.supervisor.result(first.runId),
          second: yield* rig.supervisor.result(resumed.runId),
          cumulative: rig.backend.cumulativeTotals(),
          notices: rig.sink.received().length,
          sameSubagent: resumed.subagentId === first.subagentId,
          distinctRuns: resumed.runId !== first.runId,
        };
      }),
  );

  assert.equal(value.sameSubagent, true);
  assert.equal(value.distinctRuns, true);
  assert.equal(value.first.outcome, "result");
  assert.equal(value.second.outcome, "result");
  if (value.first.outcome !== "result" || value.second.outcome !== "result") {
    return;
  }
  assert.equal(value.first.result.usage.totals.input, 100);
  // The provider's cumulative reading is 175; the resumed Run reports the
  // difference, so it is not charged for the conversation before it.
  assert.equal(value.cumulative.input, 175);
  assert.equal(value.second.result.usage.totals.input, 75);
  assert.equal(value.second.result.usage.totals.output, 25);
  // The replayed history is on the second Run's transcript and cost nothing.
  assert.deepEqual(texts(value.second.result), [
    "first answer",
    "second answer",
  ]);
  // Two Runs, two notices.
  assert.equal(value.notices, 2);
});

test("the two Runs' results are independent and immutable", async () => {
  const { value } = await withSession(
    {
      steps: [
        [emitText("first"), { step: "complete" }],
        [emitText("second"), { step: "complete" }],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, first.runId);
        const resumed = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        if (resumed.outcome !== "started") throw new Error("resume refused");
        yield* untilTerminal(rig, resumed.runId);
        const firstAgain = yield* rig.supervisor.result(first.runId);
        // A reader that mutated its copy must not change what the store
        // holds: the store keeps results encoded, so a copy is a copy.
        if (firstAgain.outcome === "result") {
          (firstAgain.result as { finalOutput: string }).finalOutput = "edited";
        }
        return {
          firstAgain,
          afterEditing: yield* rig.supervisor.result(first.runId),
          second: yield* rig.supervisor.result(resumed.runId),
        };
      }),
  );

  assert.equal(value.firstAgain.outcome, "result");
  assert.equal(value.second.outcome, "result");
  if (
    value.afterEditing.outcome !== "result" ||
    value.second.outcome !== "result"
  ) {
    return;
  }
  // The second Run did not overwrite the first, and neither did its reader.
  assert.equal(value.afterEditing.result.finalOutput, "first");
  assert.equal(value.second.result.finalOutput, "second");
});

test("a resume before the first Run has run reports the conversation lost", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const { value } = await withSession(
    {
      // The Subagent exists but its BackendAgent has never executed, so there
      // is no provider identity to resume. ADR-0023's unopened BackendAgent
      // reports that through `conversation lost` rather than a fourth outcome.
      gates: { hold },
      steps: [[{ step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        const resumed = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        });
        return resumed.outcome;
      }),
  );

  assert.equal(value, "conversation lost");
});

test("a script that declares conversation loss makes the next resume honest", async () => {
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("the last thing it will ever say"),
          { step: "lose-conversation" },
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, started.runId);
        return {
          resumed: (yield* rig.supervisor.resume({
            subagentId: started.subagentId,
            description: "again",
            prompt: "again",
          })).outcome,
          // The Run itself settled normally: losing the conversation is not
          // losing the Run.
          read: (yield* rig.supervisor.result(started.runId)).outcome,
        };
      }),
  );

  assert.deepEqual(value, { resumed: "conversation lost", read: "result" });
});

/* -------------------------------------------------------------- */
/* 6. Shutdown, all retained resources close                       */
/* -------------------------------------------------------------- */

test("shutdown, all retained resources close: every counter returns to zero", async () => {
  const hold = await Effect.runPromise(Deferred.make<void>());
  const trace: string[] = [];
  const { value, noLeaks } = await withSession(
    {
      trace,
      gates: { hold },
      steps: [[emitText("under way"), { step: "await-gate", gate: "hold" }]],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilUnderWay(rig);
        yield* rig.supervisor.shutdown();
        return {
          // Shutdown clears the store and forgets every identity, so nothing
          // survives into a Session that did not start these Runs.
          forgotten: (yield* rig.repository.lookup(started.runId)).state,
          counters: rig.backend.counters(),
          stored: yield* rig.store.stored(),
          rejected: (yield* rig.supervisor.start(rigRequest())).outcome,
        };
      }),
  );

  assert.equal(value.forgotten, "unknown");
  assert.equal(value.counters.opens - value.counters.closes, 0);
  assert.equal(value.counters.liveExecutions, 0);
  assert.equal(value.counters.liveSubscriptions, 0);
  assert.deepEqual(value.stored, []);
  assert.equal(value.rejected, "shutting down");
  assert.ok(trace.includes("agent-closed"));
  assert.equal(noLeaks, true);
});

test("a scripted late observation is ignored and changes nothing", async () => {
  const { value } = await withSession(
    {
      steps: [
        [
          emitText("the answer"),
          { step: "announce-ending", ending: { ending: "answered" } },
          emitText("a frame nobody asked for"),
          { step: "cumulative-usage", total: { input: 9_999 } },
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* untilTerminal(rig, started.runId);
        return {
          read: yield* rig.supervisor.result(started.runId),
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.equal(value.read.outcome, "result");
  if (value.read.outcome !== "result") return;
  // A terminal projection is absorbing: everything after the ending is late.
  assert.deepEqual(texts(value.read.result), ["the answer"]);
  assert.equal(value.read.result.usage.totals.input, 0);
  // It reached the reducer and changed nothing, which is a different fact
  // from an emit that never got that far.
  assert.ok(value.counters.lateObservations >= 1);
  assert.equal(value.counters.lateEvents, 0);
  assert.ok(value.counters.lateEndings >= 1);
});

test("a tool result is its own transcript item and is not the Run's answer", async () => {
  // The `tool` role is the one generic-runtime addition M4 needed, so it is
  // proven against a fake as well as against Pi: every backend that runs tools
  // produces tool results, and attributing one to the assistant would make the
  // Run look as though the model had said it.
  const { value, noLeaks } = await withSession(
    {
      steps: [
        [
          emitToolCall("read_file", "c1"),
          emitToolProgress("c1", "completed", "40 lines"),
          emitText("40 lines of it", "tool"),
          emitText("the answer"),
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* rig.supervisor.wait([started.runId]);
        const read = yield* rig.supervisor.result(started.runId);
        yield* quiesce();
        return read;
      }),
  );

  assert.equal(value.outcome, "result");
  if (value.outcome !== "result") return;
  assert.deepEqual(
    value.result.transcript.map((item) => item.role),
    ["assistant", "tool", "assistant"],
  );
  // Only an assistant item is an answer; a tool item is evidence.
  assert.equal(value.result.finalOutput, "the answer");
  assert.equal(noLeaks, true);
});
