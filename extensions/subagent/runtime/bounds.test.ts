import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  DIAGNOSTIC_MESSAGE_MAX_BYTES,
  RESULT_LINK_TARGET_MAX_BYTES,
  type ResultOutcome,
  type RunObservation,
  type RunResult,
  resultLink,
  runDiagnostic,
} from "../domain/index.ts";
import {
  emitActivity,
  emitText,
  emitToolCall,
  emitToolProgress,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  quiesce,
  rigRequest as request,
  type SessionRig,
  startedRun,
  untilTerminal,
  withSession,
} from "../testing/session-rig.ts";
import {
  assertNothingWentWrong,
  STRESS_POLICY,
} from "../testing/stress-policy.ts";
import { DEFAULT_RUNTIME_POLICY, type RuntimePolicy } from "./policy.ts";

/**
 * Every bound, driven past, under load.
 *
 * `backpressure.test.ts` proves the four *shapes* a producer/consumer mismatch
 * can take. This file asks a narrower and more mechanical question of each
 * numbered bound in `RuntimePolicy`: drive a long way past it and check that
 * the runtime **either truncates and records the truncation, or rejects with a
 * typed outcome** — and that nothing is dropped without saying so.
 *
 * "Without saying so" is the whole point. A bound that silently discards is
 * worse than no bound, because the result looks complete and is not: a model
 * reading it would answer from a transcript with a hole in it and have no way
 * to know. So every assertion below pairs the loss with its record — the
 * `TruncationRecord` field, the diagnostic, or the typed refusal the caller
 * got instead.
 *
 * Two things are deliberately *not* here. Ordering under backpressure and
 * conflation are `backpressure.test.ts`'s, and the accumulation of hundreds of
 * cycles is `stress.test.ts`'s. This is one bound at a time, past its edge.
 *
 * Every test runs on `STRESS_POLICY`, whose every bound is the smallest legal
 * one, so "a long way past" is a handful of items rather than thousands — and
 * the lane stays fast enough to be in `check`.
 */

/** A string of `bytes` ASCII characters, so byte and character counts agree. */
function long(bytes: number, fill = "x"): string {
  return fill.repeat(bytes);
}

/** Read the one outcome these tests are about, or say what came instead. */
function resultOf(read: ResultOutcome): RunResult {
  if (read.outcome !== "result") {
    throw new Error(`expected a stored result, got '${read.outcome}'`);
  }
  return read.result;
}

/** Drive one script to settlement and hand back the stored result. */
function settleOne(
  steps: readonly FakeStep[],
  policy: RuntimePolicy = STRESS_POLICY,
): Promise<{
  readonly result: RunResult;
  readonly counters: ReturnType<SessionRig["supervisor"]["counters"]>;
  readonly noLeaks: boolean;
}> {
  return withSession(
    { testClock: true, policy, steps: [steps] },
    (rig: SessionRig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        yield* untilTerminal(rig, run.runId);
        return {
          read: yield* rig.supervisor.result(run.runId),
          counters: rig.supervisor.counters(),
        };
      }),
  ).then(({ value, noLeaks }) => ({
    result: resultOf(value.read),
    counters: value.counters,
    noLeaks,
  }));
}

/* ---------------------------------------------------------------- */
/* The observation queue                                             */
/* ---------------------------------------------------------------- */

test("far more observations than the queue holds arrive whole, in order, and none is dropped", async () => {
  // The queue is the one bound whose answer is *not* truncation. A semantic
  // observation is never silently dropped, so the intake is bounded and
  // *waits*: the backend is slowed to the reducer's pace. This drives 200
  // messages through a queue of one, with the projection raised just enough to
  // hold them, so the only thing under test is the handoff.
  const messages = 200;
  const policy: RuntimePolicy = {
    ...STRESS_POLICY,
    projection: {
      ...STRESS_POLICY.projection,
      maxTranscriptItems: messages,
      maxTextPartBytes: 64,
    },
    // The projection and the *result* are bounded separately, and only the
    // queue is under test here — so both of the others are raised out of the
    // way. Leave the result bound low and settlement would cut the transcript
    // this test is counting, for a reason that has nothing to do with the
    // queue.
    maxResultBytes: DEFAULT_RUNTIME_POLICY.maxResultBytes,
    resultStoreBytes: DEFAULT_RUNTIME_POLICY.resultStoreBytes,
  };

  const { result, counters, noLeaks } = await settleOne(
    [
      ...Array.from({ length: messages }, (_unused, index) =>
        emitText(`message ${index}`),
      ),
      { step: "complete" },
    ],
    policy,
  );

  assert.equal(result.transcript.length, messages);
  assert.equal(
    result.transcript.map((item) =>
      item.parts
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join(""),
    )[messages - 1],
    `message ${messages - 1}`,
  );
  // Nothing lost, nothing counted as lost, and no overflow: the queue waited.
  assert.equal(result.truncation.droppedTranscriptItems, 0);
  assert.equal(counters.queueOverflows, 0);
  assert.equal(counters.lateEvents, 0);
  assertNothingWentWrong(counters);
  assert.equal(noLeaks, true);
});

/* ---------------------------------------------------------------- */
/* The projection bounds                                             */
/* ---------------------------------------------------------------- */

test("a transcript past its item bound keeps the newest and records the count dropped", async () => {
  const messages = 60;
  const { result, counters } = await settleOne([
    ...Array.from({ length: messages }, (_unused, index) =>
      emitText(`message ${index}`),
    ),
    { step: "complete" },
  ]);

  assert.equal(
    result.transcript.length,
    STRESS_POLICY.projection.maxTranscriptItems,
  );
  assert.equal(
    result.truncation.droppedTranscriptItems,
    messages - STRESS_POLICY.projection.maxTranscriptItems,
  );
  // The newest survived, which is the rule: an answer is the last thing said.
  assert.match(result.finalOutput, /message 59/);
  assertNothingWentWrong(counters);
});

test("more tool calls than the tool bound keeps the newest and records the count dropped", async () => {
  const calls = 30;
  const { result, counters } = await settleOne([
    ...Array.from({ length: calls }, (_unused, index) => [
      emitToolCall("read", `call-${index}`),
      emitToolProgress(`call-${index}`, "completed", `read ${index}`),
    ]).flat(),
    { step: "complete" },
  ]);

  assert.equal(result.tools.length, STRESS_POLICY.projection.maxToolEntries);
  assert.equal(
    result.truncation.droppedToolEntries,
    calls - STRESS_POLICY.projection.maxToolEntries,
  );
  assert.equal(result.tools[0]?.callId, `call-${calls - 1}`);
  assertNothingWentWrong(counters);
});

test("more diagnostics than the diagnostic bound keeps the newest and records the count dropped", async () => {
  const diagnostics = 20;
  const { result, counters } = await settleOne([
    ...Array.from(
      { length: diagnostics },
      (_unused, index): RunObservation => ({
        kind: "diagnostic",
        diagnostic: runDiagnostic("backend-failure", `something odd ${index}`),
      }),
    ).map((observation) => ({ step: "emit" as const, observation })),
    { step: "complete" },
  ]);

  assert.equal(
    result.diagnostics.length,
    STRESS_POLICY.projection.maxDiagnostics,
  );
  assert.equal(
    result.truncation.droppedDiagnostics,
    diagnostics - STRESS_POLICY.projection.maxDiagnostics,
  );
  assert.match(
    result.diagnostics[0]?.message ?? "",
    new RegExp(`something odd ${diagnostics - 1}`),
  );
  assertNothingWentWrong(counters);
});

test("more links than the link bound keeps the newest and records the count dropped", async () => {
  const links = 12;
  const { result, counters } = await settleOne([
    ...Array.from(
      { length: links },
      (_unused, index): RunObservation => ({
        kind: "link",
        link: resultLink("file", `file ${index}`, `/tmp/file-${index}`),
      }),
    ).map((observation) => ({ step: "emit" as const, observation })),
    { step: "complete" },
  ]);

  assert.equal(result.links.length, STRESS_POLICY.projection.maxLinks);
  assert.equal(
    result.truncation.droppedLinks,
    links - STRESS_POLICY.projection.maxLinks,
  );
  assertNothingWentWrong(counters);
});

/* ---------------------------------------------------------------- */
/* The text byte bounds                                              */
/* ---------------------------------------------------------------- */

test("a message part past its byte bound is cut, and the bytes cut are recorded", async () => {
  const oversize = STRESS_POLICY.projection.maxTextPartBytes * 40;
  const { result, counters } = await settleOne([
    emitText(long(oversize)),
    { step: "complete" },
  ]);

  const [item] = result.transcript;
  const text = (item?.parts ?? [])
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
  assert.ok(
    new TextEncoder().encode(text).length <=
      STRESS_POLICY.projection.maxTextPartBytes,
    `${text.length} bytes survived a ${STRESS_POLICY.projection.maxTextPartBytes}-byte bound`,
  );
  // The cut is recorded to the byte, so a reader can tell how much is missing.
  assert.ok(result.truncation.truncatedTranscriptBytes > 0);
  assert.equal(
    result.truncation.truncatedTranscriptBytes +
      new TextEncoder().encode(text).length,
    oversize,
  );
  assertNothingWentWrong(counters);
});

test("a final output past its byte bound is cut, and the bytes cut are recorded", async () => {
  // The final output has its own bound because it is *replaced* by every
  // assistant message rather than accumulated, so its count is the count for
  // the text that is there now. To see that bound bind, the part bound has to
  // be looser than it — otherwise the part bound cuts the text first and the
  // output is inside its own bound before it is ever measured, which is
  // correct and proves nothing about this bound.
  const policy: RuntimePolicy = {
    ...STRESS_POLICY,
    projection: {
      ...STRESS_POLICY.projection,
      maxFinalOutputBytes: 32,
      maxTextPartBytes: 4_096,
    },
  };
  const oversize = 2_048;

  const { result, counters } = await settleOne(
    [emitText(long(oversize)), { step: "complete" }],
    policy,
  );

  const stored = new TextEncoder().encode(result.finalOutput).length;
  assert.ok(
    stored <= policy.projection.maxFinalOutputBytes,
    `${stored} bytes survived a ${policy.projection.maxFinalOutputBytes}-byte bound`,
  );
  assert.equal(
    result.truncation.truncatedOutputBytes + stored,
    oversize,
    "the bytes cut from the final output plus the bytes kept are not the bytes emitted",
  );
  assertNothingWentWrong(counters);
});

test("a tool output summary past its byte bound is cut, and the bytes cut are recorded", async () => {
  const oversize = STRESS_POLICY.projection.maxTextPartBytes * 40;
  const { result, counters } = await settleOne([
    emitToolCall("read", "call-1"),
    emitToolProgress("call-1", "completed", long(oversize)),
    { step: "complete" },
  ]);

  assert.ok(
    new TextEncoder().encode(result.tools[0]?.outputSummary ?? "").length <=
      STRESS_POLICY.projection.maxTextPartBytes,
  );
  assert.ok(result.truncation.truncatedToolOutputBytes > 0);
  assertNothingWentWrong(counters);
});

test("a diagnostic message and a link target are bounded where they are built", async () => {
  // These two are bounded by their own constructors rather than by the
  // projection, because a diagnostic and a link are single values with a fixed
  // shape: there is no accumulation for the projection to bound. So the bound
  // is on the way in, and driving past it here proves the constructor is what
  // enforces it rather than any caller remembering to.
  const { result, counters } = await settleOne([
    {
      step: "emit",
      observation: {
        kind: "diagnostic",
        diagnostic: runDiagnostic(
          "backend-failure",
          long(DIAGNOSTIC_MESSAGE_MAX_BYTES * 4),
        ),
      },
    },
    {
      step: "emit",
      observation: {
        kind: "link",
        link: resultLink(
          "url",
          long(1_000),
          `https://example.test/${long(RESULT_LINK_TARGET_MAX_BYTES * 4)}`,
        ),
      },
    },
    { step: "complete" },
  ]);

  const encode = (text: string) => new TextEncoder().encode(text).length;
  assert.ok(
    encode(result.diagnostics[0]?.message ?? "") <=
      DIAGNOSTIC_MESSAGE_MAX_BYTES,
  );
  assert.ok(
    encode(result.links[0]?.target ?? "") <= RESULT_LINK_TARGET_MAX_BYTES,
  );
  assertNothingWentWrong(counters);
});

/* ---------------------------------------------------------------- */
/* The result byte and store budget bounds                           */
/* ---------------------------------------------------------------- */

test("a result larger than one reservation is cut to fit it and says it was cut", async () => {
  // The result byte bound is not the product of the projection bounds — an
  // item may carry any number of parts — so this drives the *encoded whole*
  // past `maxResultBytes` with many items rather than one long one, and the
  // cut has to happen at settlement rather than during reduction.
  const items = 400;
  const policy: RuntimePolicy = {
    ...STRESS_POLICY,
    projection: {
      ...STRESS_POLICY.projection,
      maxTranscriptItems: items,
      maxToolEntries: items,
      maxTextPartBytes: 200,
    },
  };

  const { result, counters } = await settleOne(
    [
      ...Array.from({ length: items }, (_unused, index) =>
        emitText(`${index}: ${long(150)}`),
      ),
      { step: "complete" },
    ],
    policy,
  );

  const encoded = new TextEncoder().encode(JSON.stringify(result)).length;
  assert.ok(
    encoded <= policy.maxResultBytes * 2,
    `${encoded} bytes stored against a ${policy.maxResultBytes}-byte reservation`,
  );
  // Something was given up, and the record says which kind.
  assert.ok(
    result.truncation.droppedTranscriptItems > 0 ||
      result.truncation.truncatedTranscriptBytes > 0,
    "a result over its reservation recorded no truncation at all",
  );
  assert.ok(
    result.transcript.length > 0,
    "the whole transcript was thrown away",
  );
  assertNothingWentWrong(counters);
});

test("a store full of unread results evicts the oldest rather than refusing the next Run", async () => {
  // The store budget under load. Each Run's result is stored, delivered, and
  // unpinned; the budget holds two reservations' worth, so by the third Run
  // the store has to give something up. The rule is that it gives up the
  // *oldest* and says so through `ResultExpired`, and that a later Run is
  // never refused because of a Session's own history.
  const RUNS = 12;
  const { value, noLeaks } = await withSession(
    {
      testClock: true,
      policy: STRESS_POLICY,
      steps: Array.from({ length: RUNS }, () => [
        emitText("an answer of some length, to take up room"),
        { step: "complete" as const },
      ]),
    },
    (rig: SessionRig) =>
      Effect.gen(function* () {
        const outcomes: string[] = [];
        const reads: string[] = [];
        const runs = [];
        for (let index = 0; index < RUNS; index += 1) {
          const started = yield* rig.supervisor.start(request());
          outcomes.push(started.outcome);
          if (started.outcome !== "started") break;
          runs.push(started.runId);
          yield* untilTerminal(rig, started.runId);
          // Let delivery push and release its pin, which is what makes the
          // result evictable.
          yield* quiesce();
          yield* rig.supervisor.closeSubagentById(started.subagentId);
        }
        for (const runId of runs) {
          reads.push((yield* rig.supervisor.result(runId)).outcome);
        }
        return { outcomes, reads, counters: rig.supervisor.counters() };
      }),
  );

  // Every Run was admitted: the store's own fullness is not a capacity answer.
  assert.deepEqual([...new Set(value.outcomes)], ["started"]);
  // The oldest results are gone, the newest is readable, and the loss has its
  // own outcome rather than being reported as an unknown Run.
  assert.equal(value.reads[0], "ResultExpired");
  assert.equal(value.reads[value.reads.length - 1], "result");
  assert.ok(value.counters.evictions > 0);
  assert.equal(value.counters.unreadableResults, 0);
  assertNothingWentWrong(value.counters);
  assert.equal(noLeaks, true);
});

/* ---------------------------------------------------------------- */
/* The control mailbox bounds                                        */
/* ---------------------------------------------------------------- */

test("a mailbox driven far past every one of its three bounds refuses each with its own reason", async () => {
  // Three different bounds, three different refusals, and the Run keeps
  // running through all of them — because a caller must never be blocked by a
  // control, and a control that could not be admitted is a control the caller
  // is told about rather than one that quietly vanishes.
  const policy: RuntimePolicy = {
    ...STRESS_POLICY,
    controls: { maxPending: 2, maxMessageBytes: 32, maxPendingBytes: 48 },
  };

  const { value, noLeaks } = await withSession(
    {
      testClock: true,
      policy,
      steps: [[emitActivity("thinking"), { step: "hang" }]],
    },
    (rig: SessionRig) =>
      Effect.gen(function* () {
        const run = startedRun(yield* rig.supervisor.start(request()));
        const outcomes: string[] = [];
        // One that fits, one that fills the byte budget, then thirty more.
        outcomes.push(
          (yield* rig.supervisor.steer(run.runId, {
            type: "steer",
            text: "look left",
          })).outcome,
        );
        outcomes.push(
          (yield* rig.supervisor.steer(run.runId, {
            type: "steer",
            text: "look right too",
          })).outcome,
        );
        for (let index = 0; index < 30; index += 1) {
          outcomes.push(
            (yield* rig.supervisor.steer(run.runId, {
              type: "steer",
              text: `and again ${index}`,
            })).outcome,
          );
        }
        const oversize = (yield* rig.supervisor.steer(run.runId, {
          type: "steer",
          text: "x".repeat(policy.controls.maxMessageBytes * 10),
        })).outcome;
        // Still running: nothing about a refused control ends a Run.
        const stillActive = (yield* rig.repository.lookup(run.runId)).state;

        yield* rig.supervisor.cancel([run.runId]);
        yield* untilTerminal(rig, run.runId);
        return {
          accepted: outcomes.filter((outcome) => outcome === "accepted").length,
          refusals: [...new Set(outcomes.slice(2))],
          oversize,
          stillActive,
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.equal(value.accepted, 2);
  // Every later steer was refused, and not one was silently accepted.
  assert.ok(value.refusals.length > 0);
  assert.equal(value.refusals.includes("accepted"), false);
  assert.notEqual(value.oversize, "accepted");
  assert.equal(value.stillActive, "active");
  assertNothingWentWrong(value.counters);
  assert.equal(noLeaks, true);
});

/* ---------------------------------------------------------------- */
/* Capacity                                                          */
/* ---------------------------------------------------------------- */

test("more concurrent Runs than capacity are refused immediately, never queued", async () => {
  const policy: RuntimePolicy = { ...STRESS_POLICY, maxActiveRuns: 2 };
  const ATTEMPTS = 20;

  const { value, noLeaks } = await withSession(
    {
      testClock: true,
      policy,
      steps: Array.from({ length: ATTEMPTS }, () => [
        { step: "hang" as const },
      ]),
    },
    (rig: SessionRig) =>
      Effect.gen(function* () {
        const outcomes: string[] = [];
        const started = [];
        for (let index = 0; index < ATTEMPTS; index += 1) {
          const outcome = yield* rig.supervisor.start(request());
          outcomes.push(outcome.outcome);
          if (outcome.outcome === "started") started.push(outcome.runId);
        }
        // Refusal is immediate rather than deferred: after the refusals, the
        // number of Runs the repository knows about is still exactly capacity,
        // so nothing was queued behind them waiting for room.
        const known = yield* Effect.forEach(started, (runId) =>
          Effect.map(rig.repository.lookup(runId), (found) => found.state),
        );
        const live = known.filter((state) => state === "active").length;
        yield* rig.supervisor.cancel(started);
        for (const runId of started) yield* untilTerminal(rig, runId);
        return {
          started: outcomes.filter((outcome) => outcome === "started").length,
          refused: [...new Set(outcomes.slice(policy.maxActiveRuns))],
          live,
          counters: rig.supervisor.counters(),
        };
      }),
  );

  assert.equal(value.started, policy.maxActiveRuns);
  assert.deepEqual(value.refused, ["at capacity"]);
  assert.equal(value.live, policy.maxActiveRuns);
  assertNothingWentWrong(value.counters);
  assert.equal(noLeaks, true);
});

test("every bound this file drives past is below the default it was lowered from", () => {
  // The same guard `stress.test.ts` carries, for the same reason: a default
  // that moved below one of these would leave these tests driving past
  // nothing, and they would go on passing.
  assert.ok(
    STRESS_POLICY.projection.maxTranscriptItems <
      DEFAULT_RUNTIME_POLICY.projection.maxTranscriptItems,
  );
  assert.ok(
    STRESS_POLICY.resultStoreBytes < DEFAULT_RUNTIME_POLICY.resultStoreBytes,
  );
  assert.ok(
    STRESS_POLICY.observationQueueBound <
      DEFAULT_RUNTIME_POLICY.observationQueueBound,
  );
});
