import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import {
  CODEX_CAPABILITIES,
  CODEX_MALFORMED_FRAME_CATEGORY,
  CODEX_STDERR_CATEGORY,
  CODEX_STEER_REFUSED_CATEGORY,
  CODEX_TRANSPORT_LOST_CATEGORY,
  codexProbeIsClear,
  MISSING_CODEX_ANSWER_MESSAGE,
} from "../../backend/codex/index.ts";
import { DEPTH_ENV_KEY } from "../../backend/depth.ts";
import type { RunId, RunResult, SubagentId } from "../../domain/index.ts";
import { DEFAULT_RUNTIME_POLICY } from "../../runtime/policy.ts";
import {
  codexRigRequest,
  quiesce,
  until,
  untilProcessGone,
  untilSteered,
  untilTerminal,
  untilTurnStarted,
  untilWrote,
  withCodexSession,
} from "./codex-rig.ts";
import type { CodexTurnScript } from "./stand-in-app-server.ts";
import { CODEX_STAND_IN_ROOT } from "./stand-in-app-server.ts";

/**
 * The Codex behaviours the shared suite cannot ask about.
 *
 * Everything provider-neutral is proven by the conformance suite; these are
 * the cells that are Codex's own, and almost all of them are the M0 spike's
 * three findings made into assertions. They are named for what they prove
 * rather than for the mechanism, so a later reader cannot mistake one for a
 * duplicate of a shared scenario and delete it:
 *
 * - The event stream is **Subagent-scoped**, so late events are a routing
 *   decision. If `a frame for a settled Turn reaches no Run and is counted`
 *   goes, nothing is left checking ADR-0024 for the one backend where the
 *   event source does not disappear with the Run.
 * - Usage is **conversation-cumulative**, so a resumed Run has to be
 *   differenced against a baseline. `a resumed Run is charged for its own work
 *   only` is the assertion ADR-0027's second exception rests on.
 * - **Process loss produces no protocol signal.** `a process that dies
 *   mid-Turn fails the Run with its partial output` and `a request the server
 *   never answers cannot hold a Run open` are the two loss signals, and
 *   neither of them is on the wire.
 */

/** Narrow a start to the one outcome most tests are about. */
function startedRun(outcome: { readonly outcome: string }): {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
} {
  if (outcome.outcome !== "started") {
    throw new Error(`expected a started Run, got '${outcome.outcome}'`);
  }
  return outcome as never;
}

/** The stored result of a settled Run, or a failure naming what came back. */
function resultOf(read: { readonly outcome: string }): RunResult {
  if (read.outcome !== "result") {
    throw new Error(`expected a stored result, got '${read.outcome}'`);
  }
  return (read as unknown as { readonly result: RunResult }).result;
}

/** One Turn that runs a command and answers. The ordinary shape. */
const ANSWERS: CodexTurnScript = {
  frames: [
    {
      frame: "item-started",
      item: { kind: "command", id: "c1", command: "npm test" },
    },
    {
      frame: "item-completed",
      item: {
        kind: "command",
        id: "c1",
        command: "npm test",
        status: "completed",
        output: "12 passing",
      },
    },
    {
      frame: "item-completed",
      item: {
        kind: "agentMessage",
        id: "m1",
        text: "twelve tests pass",
        phase: "final_answer",
      },
    },
    {
      frame: "usage",
      total: { totalTokens: 500, inputTokens: 450, outputTokens: 50 },
      last: { totalTokens: 500 },
      window: 272_000,
    },
    { frame: "completed" },
  ],
};

const texts = (result: RunResult): readonly string[] =>
  result.transcript.map((item) =>
    item.parts
      .map((part) => (part.kind === "text" ? part.text : `[${part.name}]`))
      .join(""),
  );

/* ============================================================== */
/* Opening: the process, the root, and the reader                  */
/* ============================================================== */

test("Codex declares resume and steering, and no terminal transcript snapshot", () => {
  // `turn/completed` does carry the Turn's items, but they have already been
  // reported one by one as they happened: replaying them would duplicate the
  // transcript rather than reconcile it. So the reconciliation carries turns
  // and the capability says there is no snapshot.
  assert.deepEqual(CODEX_CAPABILITIES, {
    resume: true,
    steer: true,
    terminalTranscriptSnapshot: false,
  });
});

test("opening spawns the App Server, initializes, and starts the ephemeral root", async () => {
  const outcome = await withCodexSession({ scripts: [ANSWERS] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(
        yield* rig.supervisor.start(codexRigRequest()),
      );
      yield* untilTurnStarted(rig);
      return {
        probeWhileRunning: rig.probe(),
        record: rig.standIn.record(),
        runId: started.runId,
      };
    }),
  );

  assert.deepEqual(outcome.value.record.methods.slice(0, 4), [
    "initialize",
    "initialized",
    "thread/start",
    "turn/start",
  ]);
  // The posture is fixed regardless of the Subagent's forwarded trust value.
  assert.deepEqual(outcome.value.record.threadParameters, {
    cwd: "/work",
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.equal(outcome.value.probeWhileRunning.liveProcesses, 1);
  assert.equal(outcome.value.probeWhileRunning.readerFibers, 1);
  assert.equal(outcome.value.probeWhileRunning.retainedRoots, 1);
  assert.equal(outcome.tallyAfterClose.opens, 1);
  assert.equal(codexProbeIsClear(outcome.nativeProbeAfterClose), true);
  assert.equal(outcome.noLeaks, true);
});

test("the child is spawned with the operator's environment plus the depth key", async () => {
  const outcome = await withCodexSession(
    { scripts: [ANSWERS], env: { PATH: "/usr/bin", HOME: "/home/x" } },
    (rig) =>
      Effect.gen(function* () {
        yield* rig.supervisor.start(codexRigRequest({ childDepth: 1 }));
        yield* untilTurnStarted(rig);
        return rig.standIn.record().requests;
      }),
  );

  assert.deepEqual(outcome.value, [
    {
      command: "codex",
      args: ["app-server"],
      cwd: "/work",
      env: { PATH: "/usr/bin", HOME: "/home/x", [DEPTH_ENV_KEY]: "1" },
    },
  ]);
});

test("a missing binary is backend unavailable with no Run and nothing held", async () => {
  const outcome = await withCodexSession({ spawnFails: true }, (rig) =>
    Effect.gen(function* () {
      const start = yield* rig.supervisor.start(codexRigRequest());
      const published = yield* SubscriptionRef.get(rig.repository.index);
      return {
        start: start.outcome,
        published: published.size,
        probe: rig.probe(),
      };
    }),
  );

  assert.equal(outcome.value.start, "backend unavailable");
  assert.equal(outcome.value.published, 0);
  assert.equal(codexProbeIsClear(outcome.value.probe), true);
  assert.equal(outcome.tallyAfterClose.opens, 0);
});

test("an initialize the adapter cannot read is backend unavailable, and the child is killed", async () => {
  const outcome = await withCodexSession({ malformedInitialize: true }, (rig) =>
    Effect.gen(function* () {
      const start = yield* rig.supervisor.start(codexRigRequest());
      const published = yield* SubscriptionRef.get(rig.repository.index);
      return {
        start: start.outcome,
        published: published.size,
        probe: rig.probe(),
        alive: rig.standIn.alive(),
        stdinEnded: rig.standIn.record().stdinEnded,
      };
    }),
  );

  // No provider text crosses: the public answer is the category, and the
  // caller turns it into `backend unavailable`.
  assert.equal(outcome.value.start, "backend unavailable");
  assert.equal(outcome.value.published, 0);
  assert.equal(outcome.value.alive, false);
  assert.equal(outcome.value.stdinEnded, true);
  assert.equal(codexProbeIsClear(outcome.value.probe), true);
});

test("a refused thread start is backend unavailable", async () => {
  const outcome = await withCodexSession({ refuseThreadStart: true }, (rig) =>
    Effect.map(
      rig.supervisor.start(codexRigRequest()),
      (start) => start.outcome,
    ),
  );

  assert.equal(outcome.value, "backend unavailable");
  assert.equal(codexProbeIsClear(outcome.nativeProbeAfterClose), true);
});

test("a thread start that never answers is backend unavailable once the budget expires", async () => {
  const outcome = await withCodexSession(
    {
      hangThreadStart: true,
      testClock: true,
      policy: { ...DEFAULT_RUNTIME_POLICY, openBudgetMillis: 1_000 },
      requestBudgetMillis: 60_000,
    },
    (rig) =>
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          rig.supervisor.start(codexRigRequest()),
        );
        yield* until(
          "the thread start to be written",
          Effect.sync(() =>
            rig.standIn.record().methods.includes("thread/start"),
          ),
        );
        yield* TestClock.adjust(1_001);
        const start = yield* Fiber.join(starting);
        return { start: start.outcome, alive: rig.standIn.alive() };
      }),
  );

  assert.equal(outcome.value.start, "backend unavailable");
  assert.equal(outcome.value.alive, false);
  assert.equal(codexProbeIsClear(outcome.nativeProbeAfterClose), true);
});

/* ============================================================== */
/* One Turn, and what it reports                                   */
/* ============================================================== */

test("one Turn is one Run, and its items read like any other backend's", async () => {
  const outcome = await withCodexSession({ scripts: [ANSWERS] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(
        yield* rig.supervisor.start(codexRigRequest()),
      );
      yield* untilTerminal(rig, started.runId);
      yield* quiesce();
      return resultOf(yield* rig.store.read(started.runId));
    }),
  );

  const result = outcome.value;
  assert.equal(result.status, "completed");
  assert.equal(result.finalOutput, "twelve tests pass");
  assert.deepEqual(texts(result), ["[command_execution]", "twelve tests pass"]);
  assert.deepEqual(
    result.tools.map((tool) => [tool.name, tool.status, tool.outputSummary]),
    [["command_execution", "completed", "12 passing"]],
  );
  assert.equal(result.usage.totals.input, 450);
  assert.equal(result.usage.totals.output, 50);
  assert.equal(result.usage.turns, 1);
  assert.deepEqual(result.usage.context, { tokens: 500, window: 272_000 });
  assert.deepEqual(result.diagnostics, []);
});

test("the first Turn carries the Profile prompt, and a resumed Turn does not", async () => {
  const outcome = await withCodexSession(
    { scripts: [ANSWERS, ANSWERS] },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        const second = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "now the other thing",
          }),
        );
        yield* untilTerminal(rig, second.runId);
        return rig.standIn
          .record()
          .writes.filter((write) => write.method === "turn/start")
          .map((write) => {
            const input = (write.params?.input ?? []) as readonly Record<
              string,
              unknown
            >[];
            return input[0]?.text;
          });
      }),
  );

  assert.deepEqual(outcome.value, [
    "Build it.\n\ndo the thing",
    "now the other thing",
  ]);
});

test("a resumed Turn runs on the same retained root", async () => {
  const outcome = await withCodexSession(
    { scripts: [ANSWERS, ANSWERS] },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        const second = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "again",
          }),
        );
        yield* untilTerminal(rig, second.runId);
        return rig.standIn.record();
      }),
  );

  // One `thread/start`, two `turn/start`, both against the same root. There is
  // no `thread/resume` and no stored rollout: sequential Turns on one retained
  // ephemeral thread are the resume mechanism, as ADR-0021 chose.
  assert.equal(
    outcome.value.methods.filter((method) => method === "thread/start").length,
    1,
  );
  assert.deepEqual(
    outcome.value.writes
      .filter((write) => write.method === "turn/start")
      .map((write) => write.params?.threadId),
    [CODEX_STAND_IN_ROOT, CODEX_STAND_IN_ROOT],
  );
  assert.equal(outcome.value.turnIds.length, 2);
  assert.notEqual(outcome.value.turnIds[0], outcome.value.turnIds[1]);
});

test("a Turn that completes with no final answer fails with a fixed message", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "aside",
                phase: "commentary",
              },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return resultOf(yield* rig.store.read(started.runId));
      }),
  );

  assert.equal(outcome.value.status, "failed");
  assert.equal(outcome.value.errorMessage, MISSING_CODEX_ANSWER_MESSAGE);
  // The commentary is still the Run's output: a failed Run keeps what it saw.
  assert.deepEqual(texts(outcome.value), ["aside"]);
});

test("a Turn the server reports as failed fails with a confined diagnostic", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "error",
              message: "the model is unavailable for thread root-thread",
            },
            { frame: "completed", status: "failed", errorMessage: "gave up" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return resultOf(yield* rig.store.read(started.runId));
      }),
  );

  assert.equal(outcome.value.status, "failed");
  assert.ok(outcome.value.errorMessage?.endsWith("[redacted]"));
  assert.deepEqual(
    outcome.value.diagnostics.map((diagnostic) => diagnostic.category),
    ["backend-failure", "backend-failure"],
  );
  for (const diagnostic of outcome.value.diagnostics) {
    assert.equal(diagnostic.message.includes("root-thread"), false);
    assert.equal(diagnostic.message.includes("unavailable"), false);
  }
});

/* ============================================================== */
/* Routing: one stream, many Runs                                  */
/* ============================================================== */

test("a frame for a settled Turn reaches no Run and is counted", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        ANSWERS,
        {
          turnId: "turn-2",
          frames: [
            // A frame carrying the *first* Turn's id, arriving while the
            // second Run is the one listening. Codex's stream outlives every
            // Run, so this is a routing decision rather than a closed source.
            {
              frame: "for-turn",
              turnId: "turn-1",
              item: {
                kind: "agentMessage",
                id: "stale",
                text: "from the Turn before",
              },
            },
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m2",
                text: "the second answer",
              },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        const second = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "again",
          }),
        );
        yield* untilTerminal(rig, second.runId);
        yield* quiesce();
        return {
          first: resultOf(yield* rig.store.read(first.runId)),
          second: resultOf(yield* rig.store.read(second.runId)),
          tally: rig.tally(),
        };
      }),
  );

  // Positively, in both directions: the current Turn's frames arrived, and the
  // stale one reached neither Run and was counted. Asserting only the second
  // half would pass for an adapter that dropped everything.
  assert.deepEqual(texts(outcome.value.second), ["the second answer"]);
  assert.equal(
    texts(outcome.value.second).includes("from the Turn before"),
    false,
  );
  assert.equal(
    texts(outcome.value.first).includes("from the Turn before"),
    false,
  );
  assert.ok(outcome.value.tally.lateFrames >= 1);
});

test("a frame for a turn nobody ever listened to reaches no Run", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "for-turn",
              turnId: "turn-from-another-thread",
              item: { kind: "agentMessage", id: "x", text: "not ours" },
            },
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "ours" },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return {
          result: resultOf(yield* rig.store.read(started.runId)),
          tally: rig.tally(),
        };
      }),
  );

  assert.deepEqual(texts(outcome.value.result), ["ours"]);
  assert.ok(outcome.value.tally.lateFrames >= 1);
});

test("the reader answers a client-bound request that arrives between Runs", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "done" },
            },
            { frame: "completed" },
            // Issued *after* the Turn is over, so no Run is listening. The
            // spike found that a client-bound request the client ignores
            // stalls the server, which is why the reader outlives every Run.
            { frame: "server-request", method: "elicitation/create" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return rig.standIn.record();
      }),
  );

  assert.equal(outcome.value.serverRequests, 1);
  assert.equal(outcome.value.serverRequestAnswers, 1);
});

/* ============================================================== */
/* Resume, loss, and admission                                     */
/* ============================================================== */

test("a resumed Run is charged for its own work only", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "first" },
            },
            {
              frame: "usage",
              total: {
                totalTokens: 1_000,
                inputTokens: 900,
                outputTokens: 100,
              },
              last: { totalTokens: 1_000 },
            },
            { frame: "completed" },
          ],
        },
        {
          frames: [
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m2", text: "second" },
            },
            {
              // Conversation-cumulative, as the spike recorded: the running
              // total for the whole thread rather than this Turn's spend.
              frame: "usage",
              total: {
                totalTokens: 1_400,
                inputTokens: 1_240,
                outputTokens: 160,
              },
              last: { totalTokens: 400 },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        const second = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "again",
          }),
        );
        yield* untilTerminal(rig, second.runId);
        yield* quiesce();
        return {
          first: resultOf(yield* rig.store.read(first.runId)),
          second: resultOf(yield* rig.store.read(second.runId)),
        };
      }),
  );

  assert.equal(outcome.value.first.usage.totals.input, 900);
  assert.equal(outcome.value.second.usage.totals.input, 340);
  assert.equal(outcome.value.second.usage.totals.output, 60);
  // The gauge is the last request's occupancy, not the conversation's bill.
  assert.deepEqual(outcome.value.second.usage.context, { tokens: 400 });
  // And the resumed Run's transcript holds its own Turn and nothing else.
  assert.deepEqual(texts(outcome.value.first), ["first"]);
  assert.deepEqual(texts(outcome.value.second), ["second"]);
});

test("a process that dies mid-Turn fails the Run with its partial output", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "got this far",
                phase: "commentary",
              },
            },
            // No terminal Turn frame will ever arrive. The spike killed an App
            // Server mid-Turn and waited fifteen seconds for one.
            { frame: "exit", code: null, signal: "SIGKILL" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return {
          result: resultOf(yield* rig.store.read(started.runId)),
          probe: rig.probe(),
        };
      }),
  );

  assert.equal(outcome.value.result.status, "failed");
  assert.deepEqual(
    outcome.value.result.diagnostics.map((diagnostic) => diagnostic.category),
    ["transport-loss"],
  );
  assert.equal(
    outcome.value.result.errorMessage,
    `${CODEX_TRANSPORT_LOST_CATEGORY}: [redacted]`,
  );
  assert.deepEqual(texts(outcome.value.result), ["got this far"]);
  assert.equal(outcome.value.probe.pendingRequests, 0);
});

test("resume is admitted while the root is live and lost once the process has gone", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "done" },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        yield* quiesce();
        // Live: the process is up and the root is retained.
        const beforeLoss = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        // That resume started a Turn the stand-in has no script for, so it is
        // holding. Cancel it and then kill the App Server underneath.
        const second = startedRun(beforeLoss);
        yield* untilTurnStarted(rig, 1);
        yield* rig.supervisor.cancel([second.runId]);
        yield* untilTerminal(rig, second.runId);
        rig.standIn.exitNow({ code: null, signal: "SIGKILL" });
        yield* quiesce();
        const afterLoss = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        const stillLost = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        return {
          beforeLoss: beforeLoss.outcome,
          afterLoss: afterLoss.outcome,
          stillLost: stillLost.outcome,
        };
      }),
  );

  assert.equal(outcome.value.beforeLoss, "started");
  // Monotonic: nothing moves a lost conversation back.
  assert.equal(outcome.value.afterLoss, "conversation lost");
  assert.equal(outcome.value.stillLost, "conversation lost");
});

test("a request the server never answers cannot hold a Run open", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [{ hangStart: true }],
      testClock: true,
      requestBudgetMillis: 1_000,
      escalationMillis: 500,
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilWrote(rig, "turn/start");
        yield* TestClock.adjust(1_001);
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return {
          result: resultOf(yield* rig.store.read(started.runId)),
          probe: rig.probe(),
        };
      }),
  );

  assert.equal(outcome.value.result.status, "failed");
  assert.deepEqual(
    outcome.value.result.diagnostics.map((diagnostic) => diagnostic.category),
    ["transport-loss"],
  );
  assert.equal(outcome.value.probe.pendingRequests, 0);
});

/* ============================================================== */
/* Steering                                                        */
/* ============================================================== */

test("guidance becomes a user observation only when the server echoes its id", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          turnId: "turn-1",
          frames: [
            { frame: "hold" },
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "with the guidance",
              },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        const steer = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "also check the types",
        });
        yield* untilSteered(rig);
        rig.standIn.resume();
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return {
          steer: steer.outcome,
          result: resultOf(yield* rig.store.read(started.runId)),
          record: rig.standIn.record(),
          probe: rig.probe(),
        };
      }),
  );

  assert.equal(outcome.value.steer, "accepted");
  assert.deepEqual(outcome.value.record.steers, ["also check the types"]);
  // `expectedTurnId` is the protocol refusing guidance for the wrong Turn.
  assert.deepEqual(outcome.value.record.steerTurnIds, ["turn-1"]);
  assert.deepEqual(texts(outcome.value.result), [
    "also check the types",
    "with the guidance",
  ]);
  assert.deepEqual(
    outcome.value.result.transcript.map((item) => item.role),
    ["user", "assistant"],
  );
  assert.equal(outcome.value.probe.inFlightSteers, 0);
});

test("guidance the server never echoes is delivered and never claimed", async () => {
  const outcome = await withCodexSession(
    {
      echoSteer: false,
      scripts: [
        {
          frames: [
            { frame: "hold" },
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "answered anyway" },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "quietly",
        });
        yield* untilSteered(rig);
        rig.standIn.resume();
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return resultOf(yield* rig.store.read(started.runId));
      }),
  );

  // A transcript showing guidance the model never read is the one lie this
  // seam must not tell. Admission said the Control was accepted, which was
  // true; nothing else about it is.
  assert.deepEqual(texts(outcome.value), ["answered anyway"]);
  assert.deepEqual(outcome.value.diagnostics, []);
});

test("guidance the server refuses is a control diagnostic and nothing else", async () => {
  const outcome = await withCodexSession(
    {
      steerPolicies: ["refuse"],
      scripts: [
        {
          frames: [
            { frame: "hold" },
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "unsteered" },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "no thanks",
        });
        yield* untilSteered(rig);
        rig.standIn.resume();
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return resultOf(yield* rig.store.read(started.runId));
      }),
  );

  assert.deepEqual(texts(outcome.value), ["unsteered"]);
  assert.deepEqual(outcome.value.diagnostics, [
    {
      category: "control",
      message: `${CODEX_STEER_REFUSED_CATEGORY}: [redacted]`,
    },
  ]);
});

test("only one steer is in flight at a time", async () => {
  const outcome = await withCodexSession(
    {
      steerPolicies: ["hang", "accept"],
      scripts: [
        {
          frames: [
            { frame: "hold" },
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "eventually" },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        const first = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "one",
        });
        yield* untilSteered(rig);
        const second = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "two",
        });
        yield* quiesce();
        return {
          outcomes: [first.outcome, second.outcome],
          record: rig.standIn.record(),
          probe: rig.probe(),
        };
      }),
  );

  // Both were admitted; only the first reached the server, because the loop
  // awaits each request. The second stays in ADR-0026's bounded mailbox, which
  // is where the bound is and where a caller learns there is no room.
  assert.deepEqual(outcome.value.outcomes, ["accepted", "accepted"]);
  assert.deepEqual(outcome.value.record.steers, ["one"]);
  assert.equal(outcome.value.record.maxConcurrentSteers, 1);
  assert.equal(outcome.value.probe.inFlightSteers, 1);
  assert.equal(codexProbeIsClear(outcome.nativeProbeAfterClose), true);
});

test("a steer sent before a cancel still confirms afterwards", async () => {
  const outcome = await withCodexSession(
    {
      echoSteer: false,
      scripts: [{ frames: [{ frame: "hold" }] }],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "before the cancel",
        });
        yield* untilSteered(rig);
        const clientId = String(
          rig.standIn
            .record()
            .writes.find((write) => write.method === "turn/steer")?.params
            ?.clientUserMessageId,
        );
        // The echo arrives *after* the cancel is admitted. ADR-0012: a steer
        // already sent keeps its correlation live, because the model really
        // did read it and the transcript should say so.
        yield* rig.supervisor.cancel([started.runId]);
        rig.standIn.write({
          frame: "item-completed",
          item: {
            kind: "userMessage",
            id: "u1",
            clientId,
            text: "before the cancel",
          },
        });
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return resultOf(yield* rig.store.read(started.runId));
      }),
  );

  assert.equal(outcome.value.status, "cancelled");
  assert.equal(outcome.value.cancellationReason, "requested");
});

/* ============================================================== */
/* Cancellation                                                    */
/* ============================================================== */

test("cancelling an active Turn interrupts it and leaves the root resumable", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "partial",
                phase: "commentary",
              },
            },
            { frame: "hold" },
          ],
        },
        ANSWERS,
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        // Every frame up to the `hold` has been written by now, so a quiesce
        // is enough to have them reduced: the reader is the only consumer and
        // the queue it drains is finite.
        yield* quiesce();
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        const resumed = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        });
        const second = startedRun(resumed);
        yield* untilTerminal(rig, second.runId);
        yield* quiesce();
        return {
          cancelled: resultOf(yield* rig.store.read(started.runId)),
          resumed: resultOf(yield* rig.store.read(second.runId)),
          record: rig.standIn.record(),
        };
      }),
  );

  assert.equal(outcome.value.cancelled.status, "cancelled");
  assert.deepEqual(texts(outcome.value.cancelled), ["partial"]);
  // The interrupt was written, and no signal was needed: the Turn reported
  // itself interrupted, so the ladder stood down.
  assert.ok(outcome.value.record.methods.includes("turn/interrupt"));
  assert.deepEqual(outcome.value.record.signals, []);
  // The process, the root, and the Subagent all survived the interrupt.
  assert.equal(outcome.value.resumed.status, "completed");
});

test("a Turn that ignores its interrupt is escalated to SIGTERM and then SIGKILL", async () => {
  const outcome = await withCodexSession(
    {
      testClock: true,
      escalationMillis: 5_000,
      onInterrupt: "ignore",
      ignoreSigterm: true,
      ignoreStdinEnd: true,
      scripts: [{ frames: [{ frame: "hold" }] }],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilWrote(rig, "turn/interrupt");
        yield* TestClock.adjust(5_001);
        const afterFirst = [...rig.standIn.record().signals];
        yield* TestClock.adjust(5_001);
        yield* untilProcessGone(rig);
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        const lost = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        });
        return {
          afterFirst,
          signals: rig.standIn.record().signals,
          exit: rig.standIn.record().exit,
          lost: lost.outcome,
        };
      }),
  );

  assert.deepEqual(outcome.value.afterFirst, ["SIGTERM"]);
  assert.deepEqual(outcome.value.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(outcome.value.exit, { code: null, signal: "SIGKILL" });
  // A killed App Server ends the retained ephemeral thread. There is nothing
  // to resume, and recovery is a new Subagent.
  assert.equal(outcome.value.lost, "conversation lost");
});

test("a final answer already observed survives a later cancel", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "the answer",
                phase: "final_answer",
              },
            },
            { frame: "hold" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        // The final answer was written before the `hold`, so it is reduced by
        // the time the cancel is admitted.
        yield* quiesce();
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return resultOf(yield* rig.store.read(started.runId));
      }),
  );

  // A cancel that arrived after the work finished is a request against a Run
  // that was already done.
  assert.equal(outcome.value.status, "completed");
  assert.equal(outcome.value.finalOutput, "the answer");
});

/* ============================================================== */
/* Background terminals, stderr, and malformed frames              */
/* ============================================================== */

test("a result is unavailable while a background command the Run started is running", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          frames: [
            {
              frame: "item-started",
              item: { kind: "command", id: "bg", command: "npm run dev" },
            },
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "started the server",
              },
            },
            { frame: "completed" },
            // The command is still running: the Turn is over and its terminal
            // is not. Nothing else arrives until the test says so.
            { frame: "hold" },
            {
              frame: "item-completed",
              item: {
                kind: "command",
                id: "bg",
                command: "npm run dev",
                status: "completed",
              },
            },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilWrote(rig, "turn/start");
        yield* until(
          "the Turn to finish",
          Effect.map(rig.repository.lookup(started.runId), (known) =>
            known.state === "active"
              ? known.snapshot.phase === "finalizing"
              : true,
          ),
        );
        yield* quiesce();
        const beforeTheTerminalClosed = yield* rig.supervisor.result(
          started.runId,
        );
        rig.standIn.resume();
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return {
          beforeTheTerminalClosed: beforeTheTerminalClosed.outcome,
          result: resultOf(yield* rig.store.read(started.runId)),
        };
      }),
  );

  // The Run had captured its ending and was in `finalizing`; the result was
  // not retrievable until the terminal it started had closed.
  assert.equal(outcome.value.beforeTheTerminalClosed, "RunNotTerminal");
  assert.equal(outcome.value.result.status, "completed");
});

test("the child's stderr is one bounded diagnostic with its identities removed", async () => {
  const outcome = await withCodexSession(
    {
      rootId: "root-secret",
      scripts: [
        {
          turnId: "turn-secret",
          frames: [
            {
              frame: "stderr",
              text: 'WARN {"threadId":"root-secret","turnId":"turn-secret"} slow disk at /Users/someone/.codex\n',
            },
            { frame: "stderr", text: "a second complaint\n" },
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "done anyway" },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return resultOf(yield* rig.store.read(started.runId));
      }),
  );

  const diagnostics = outcome.value.diagnostics;
  assert.equal(
    diagnostics.length,
    1,
    "stderr produced more than one diagnostic",
  );
  const [diagnostic] = diagnostics;
  assert.equal(diagnostic?.category, "backend-failure");
  assert.ok(diagnostic?.message.startsWith(CODEX_STDERR_CATEGORY));
  assert.equal(diagnostic?.message.includes("root-secret"), false);
  assert.equal(diagnostic?.message.includes("turn-secret"), false);
  assert.equal(outcome.value.status, "completed");
});

test("a declared method whose payload does not fit is one diagnostic, not a crash", async () => {
  const outcome = await withCodexSession(
    {
      scripts: [
        {
          turnId: "turn-1",
          frames: [
            {
              frame: "raw",
              line: '{"method":"thread/tokenUsage/updated","params":{"threadId":"root-thread","turnId":"turn-1","tokenUsage":{}}}',
            },
            {
              frame: "item-completed",
              item: { kind: "agentMessage", id: "m1", text: "unbothered" },
            },
            { frame: "completed" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return {
          result: resultOf(yield* rig.store.read(started.runId)),
          tally: rig.tally(),
        };
      }),
  );

  assert.equal(outcome.value.result.status, "completed");
  assert.deepEqual(outcome.value.result.diagnostics, [
    {
      category: "backend-failure",
      message: `${CODEX_MALFORMED_FRAME_CATEGORY}: [redacted]`,
    },
  ]);
  assert.equal(outcome.value.tally.malformedFrames, 1);
});

test("a line past the framing bound fails the Run rather than being truncated", async () => {
  const outcome = await withCodexSession(
    {
      maxLineLength: 256,
      scripts: [
        {
          frames: [
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "before the flood",
                phase: "commentary",
              },
            },
            { frame: "oversized", length: 512 },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        return {
          result: resultOf(yield* rig.store.read(started.runId)),
          tally: rig.tally(),
        };
      }),
  );

  assert.equal(outcome.value.result.status, "failed");
  assert.deepEqual(
    outcome.value.result.diagnostics.map((diagnostic) => diagnostic.category),
    ["transport-loss"],
  );
  assert.deepEqual(texts(outcome.value.result), ["before the flood"]);
  assert.equal(outcome.value.tally.oversizedLines, 1);
});

/* ============================================================== */
/* Close                                                          */
/* ============================================================== */

test("closing the Session ends stdin once and leaves nothing held", async () => {
  const outcome = await withCodexSession({ scripts: [ANSWERS] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(
        yield* rig.supervisor.start(codexRigRequest()),
      );
      yield* untilTerminal(rig, started.runId);
      yield* quiesce();
      // Twice, deliberately: shutdown closes every BackendAgent and the
      // Session Scope's finalizer closes them again.
      yield* rig.supervisor.shutdown();
      yield* rig.supervisor.shutdown();
      return {
        record: rig.standIn.record(),
        tally: rig.tally(),
      };
    }),
  );

  assert.equal(outcome.value.record.stdinEnded, true);
  assert.deepEqual(outcome.value.record.signals, []);
  assert.deepEqual(outcome.value.record.exit, { code: 0, signal: null });
  // One effective close, however many times it was asked for.
  assert.equal(outcome.tallyAfterClose.closes, 1);
  assert.equal(codexProbeIsClear(outcome.nativeProbeAfterClose), true);
  assert.equal(outcome.noLeaks, true);
});

test("an interrupt one Turn honoured does not disarm the ladder for the next", async () => {
  // The regression this exists for: a stand-down reason kept on the transport
  // rather than on the Run is set by the first cancelled Turn and never
  // cleared, so every later Run's escalation quietly stands down and a wedged
  // App Server survives. The first Turn here cooperates and the second
  // ignores its interrupt, which is the only shape that tells the two apart.
  const outcome = await withCodexSession(
    {
      testClock: true,
      escalationMillis: 5_000,
      interruptPolicies: ["complete", "ignore"],
      ignoreSigterm: true,
      ignoreStdinEnd: true,
      scripts: [
        { frames: [{ frame: "hold" }] },
        { frames: [{ frame: "hold" }] },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        /** Let every armed rung expire, however many the ladder has left. */
        const letTheLadderRun = Effect.gen(function* () {
          for (let step = 0; step < 8; step += 1) {
            if (!rig.standIn.alive()) return;
            yield* TestClock.adjust(5_001);
            yield* quiesce();
          }
        });

        const first = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* untilTurnStarted(rig);
        yield* rig.supervisor.cancel([first.runId]);
        yield* untilTerminal(rig, first.runId);
        yield* letTheLadderRun;
        // The Turn reported itself interrupted, so its ladder stood down: no
        // signal, and a live process with a live root behind it.
        const cooperativeSignals = [...rig.standIn.record().signals];
        const stillAlive = rig.standIn.alive();

        const second = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "again",
          }),
        );
        yield* untilTurnStarted(rig, 1);
        yield* rig.supervisor.cancel([second.runId]);
        yield* untilWrote(rig, "turn/interrupt", 2);
        yield* letTheLadderRun;
        yield* untilTerminal(rig, second.runId);
        yield* quiesce();
        const lost = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "again",
        });
        return {
          cooperativeSignals,
          stillAlive,
          signals: rig.standIn.record().signals,
          exit: rig.standIn.record().exit,
          lost: lost.outcome,
        };
      }),
  );

  // The Turn that reported itself interrupted was never signalled, and the
  // App Server it was running on survived.
  assert.deepEqual(outcome.value.cooperativeSignals, []);
  assert.equal(outcome.value.stillAlive, true);
  // The Turn that ignored its interrupt was signalled anyway — which is the
  // whole point: the first Turn's cooperation disarmed nothing.
  assert.deepEqual(outcome.value.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(outcome.value.exit, { code: null, signal: "SIGKILL" });
  assert.equal(outcome.value.lost, "conversation lost");
});

test("a background command past the cleanup budget escalates, and the Run still settles", async () => {
  // The other half of the background-terminal rule. The wait is a scope
  // finalizer precisely so the runtime's cleanup budget bounds it: a terminal
  // that never reports completion must not leave a Run in `finalizing`
  // forever. Past the budget the core takes over — it records a
  // `cleanup-escalation` diagnostic, closes the BackendAgent, and marks the
  // conversation lost — and closing the BackendAgent is what ends the
  // terminal, because it kills the process the terminal belongs to.
  const outcome = await withCodexSession(
    {
      testClock: true,
      policy: { ...DEFAULT_RUNTIME_POLICY, cleanupBudgetMillis: 1_000 },
      scripts: [
        {
          frames: [
            {
              frame: "item-started",
              item: { kind: "command", id: "bg", command: "npm run dev" },
            },
            {
              frame: "item-completed",
              item: {
                kind: "agentMessage",
                id: "m1",
                text: "started the server",
                phase: "final_answer",
              },
            },
            { frame: "completed" },
            // The command never completes, and nothing releases the hold.
            { frame: "hold" },
          ],
        },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(codexRigRequest()),
        );
        yield* until(
          "the Run to reach finalizing",
          Effect.map(rig.repository.lookup(started.runId), (known) =>
            known.state === "active"
              ? known.snapshot.phase === "finalizing"
              : true,
          ),
        );
        yield* quiesce();
        const beforeTheBudget = yield* rig.supervisor.result(started.runId);

        yield* TestClock.adjust(1_001);
        yield* untilTerminal(rig, started.runId);
        yield* quiesce();
        const lost = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "again",
        });
        return {
          beforeTheBudget: beforeTheBudget.outcome,
          result: resultOf(yield* rig.store.read(started.runId)),
          lost: lost.outcome,
          alive: rig.standIn.alive(),
        };
      }),
  );

  // Held while the terminal was running, and settled once the budget ran out.
  assert.equal(outcome.value.beforeTheBudget, "RunNotTerminal");
  assert.equal(outcome.value.result.status, "completed");
  assert.ok(
    outcome.value.result.diagnostics.some(
      (diagnostic) => diagnostic.category === "cleanup-escalation",
    ),
    `no cleanup escalation was recorded: ${JSON.stringify(outcome.value.result.diagnostics)}`,
  );
  // The BackendAgent was closed, which ended the process the terminal belonged
  // to, and the conversation went with it.
  assert.equal(outcome.value.alive, false);
  assert.equal(outcome.value.lost, "conversation lost");
  assert.equal(codexProbeIsClear(outcome.nativeProbeAfterClose), true);
});
