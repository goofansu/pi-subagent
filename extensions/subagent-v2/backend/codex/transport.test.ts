import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Queue, type Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  type CodexStandInAppServer,
  type CodexStandInOptions,
  createStandInAppServer,
} from "../../testing/codex/stand-in-app-server.ts";
import { createCodexProbeCounters, createCodexTallyCounters } from "./probe.ts";
import { initializeParams, threadStartParams } from "./protocol.ts";
import { redactCodexIdentities } from "./translate.ts";
import {
  CODEX_METHOD_NOT_SUPPORTED,
  type CodexFrame,
  type CodexTransport,
  startCodexTransport,
} from "./transport.ts";

/**
 * The transport, driven directly against the stand-in.
 *
 * These are the tests about the two loss signals the protocol does not
 * provide. Everything else about the adapter is proven through the Session —
 * that is where the behaviour a user sees lives — but a request bound and a
 * signal ladder are transport facts, and proving them here means the test can
 * advance a clock and read a process's signal record without a Run in the way.
 *
 * Every one of them runs on a test clock. Nothing sleeps.
 */

interface Driven {
  readonly transport: CodexTransport;
  readonly standIn: CodexStandInAppServer;
  readonly probe: () => ReturnType<
    ReturnType<typeof createCodexProbeCounters>["read"]
  >;
  readonly tally: () => ReturnType<
    ReturnType<typeof createCodexTallyCounters>["read"]
  >;
  /** Every frame the reader would have seen, taken without waiting. */
  readonly framesNow: () => Effect.Effect<readonly CodexFrame[]>;
}

interface TransportOptions extends CodexStandInOptions {
  readonly requestBudgetMillis?: number;
  readonly escalationMillis?: number;
  readonly maxLineLength?: number;
}

function withTransport<A>(
  options: TransportOptions,
  body: (driven: Driven) => Effect.Effect<A, never, Scope.Scope>,
): Promise<A> {
  const {
    requestBudgetMillis,
    escalationMillis,
    maxLineLength,
    ...standInOptions
  } = options;
  const standIn = createStandInAppServer(standInOptions);
  const probe = createCodexProbeCounters();
  const tally = createCodexTallyCounters();

  const program = Effect.gen(function* () {
    const started = yield* startCodexTransport({
      spawn: standIn.spawn,
      request: {
        command: "codex",
        args: ["app-server"],
        cwd: "/work",
        env: {},
      },
      probe,
      tally,
      ...(requestBudgetMillis === undefined ? {} : { requestBudgetMillis }),
      ...(escalationMillis === undefined ? {} : { escalationMillis }),
      ...(maxLineLength === undefined ? {} : { maxLineLength }),
    });
    if (started.outcome !== "started") throw new Error("the spawn failed");
    const transport = started.transport;
    return yield* body({
      transport,
      standIn,
      probe: probe.read,
      tally: tally.read,
      // `clear` rather than repeated takes: what has been framed by now is
      // exactly what is in the queue, and a take would wait for more.
      framesNow: () => Queue.clear(transport.frames),
    });
  });

  return Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
}

test("initialize and thread start resolve, and the probe returns to zero", async () => {
  const outcome = await withTransport({}, (driven) =>
    Effect.gen(function* () {
      const initialize = yield* driven.transport.request(
        "initialize",
        initializeParams(),
      );
      const thread = yield* driven.transport.request(
        "thread/start",
        threadStartParams({ cwd: "/work" }),
      );
      return {
        initialize: initialize.outcome,
        thread: thread.outcome,
        probe: driven.probe(),
        methods: driven.standIn.record().methods,
      };
    }),
  );

  assert.equal(outcome.initialize, "result");
  assert.equal(outcome.thread, "result");
  assert.equal(outcome.probe.pendingRequests, 0);
  assert.equal(outcome.probe.liveProcesses, 1);
  assert.deepEqual(outcome.methods, ["initialize", "thread/start"]);
});

test("a refused request is refused, and keeps the server's own words out", async () => {
  const outcome = await withTransport({ refuseThreadStart: true }, (driven) =>
    Effect.map(
      driven.transport.request(
        "thread/start",
        threadStartParams({ cwd: "/w" }),
      ),
      (answer) => answer,
    ),
  );

  // `refused` and nothing else: there is no field on the outcome for the
  // server's message, because that message is exactly the free-form provider
  // text ADR-0024 keeps adapter-local.
  assert.deepEqual(outcome, { outcome: "refused" });
});

test("a request the server never answers expires and escalates", async () => {
  const outcome = await withTransport(
    {
      hangInitialize: true,
      requestBudgetMillis: 1_000,
      escalationMillis: 500,
      ignoreStdinEnd: true,
      ignoreSigterm: true,
    },
    (driven) =>
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(
          driven.transport.request("initialize", initializeParams()),
        );
        // The bound expires. Nothing on the wire will ever say so — the spike
        // found a request issued to a dead peer neither resolves nor rejects —
        // so the adapter's own clock is the only signal there is.
        yield* TestClock.adjust(1_001);
        const answer = yield* Fiber.join(pending);
        const lostAt = yield* Deferred.isDone(driven.transport.lost);
        // The ladder: SIGTERM, then SIGKILL for a child that ignores it.
        yield* TestClock.adjust(501);
        yield* TestClock.adjust(501);
        yield* TestClock.adjust(501);
        return {
          answer: answer.outcome,
          lostAt,
          signals: driven.standIn.record().signals,
          exit: driven.standIn.record().exit,
          pendingRequests: driven.probe().pendingRequests,
        };
      }),
  );

  assert.equal(outcome.answer, "lost");
  assert.equal(outcome.lostAt, true);
  assert.equal(outcome.pendingRequests, 0);
  assert.deepEqual(outcome.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(outcome.exit, { code: null, signal: "SIGKILL" });
});

test("an ignored SIGTERM is followed by SIGKILL, with no real time passing", async () => {
  const startedAt = Date.now();

  const outcome = await withTransport(
    { escalationMillis: 5_000, ignoreStdinEnd: true, ignoreSigterm: true },
    (driven) =>
      Effect.gen(function* () {
        const closing = yield* Effect.forkChild(driven.transport.close());
        yield* TestClock.adjust(5_001);
        const afterFirst = [...driven.standIn.record().signals];
        yield* TestClock.adjust(5_001);
        yield* TestClock.adjust(5_001);
        yield* Fiber.join(closing);
        return {
          afterFirst,
          signals: driven.standIn.record().signals,
          stdinEnded: driven.standIn.record().stdinEnded,
          alive: driven.standIn.alive(),
        };
      }),
  );

  assert.deepEqual(outcome.afterFirst, ["SIGTERM"]);
  assert.deepEqual(outcome.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(outcome.stdinEnded, true);
  assert.equal(outcome.alive, false);
  assert.ok(Date.now() - startedAt < 60_000, "real time passed");
});

test("close ends stdin, and a child that goes needs no signal at all", async () => {
  const outcome = await withTransport({}, (driven) =>
    Effect.gen(function* () {
      yield* driven.transport.close();
      return {
        signals: driven.standIn.record().signals,
        exit: driven.standIn.record().exit,
        probe: driven.probe(),
      };
    }),
  );

  assert.deepEqual(outcome.signals, []);
  assert.deepEqual(outcome.exit, { code: 0, signal: null });
  assert.equal(outcome.probe.liveProcesses, 0);
});

test("close after the child is already gone returns at once, and twice is once", async () => {
  const outcome = await withTransport({}, (driven) =>
    Effect.gen(function* () {
      driven.standIn.exitNow({ code: null, signal: "SIGKILL" });
      yield* driven.transport.close();
      yield* driven.transport.close();
      return {
        stdinEnded: driven.standIn.record().stdinEnded,
        signals: driven.standIn.record().signals,
        lost: driven.transport.isLost(),
      };
    }),
  );

  // Nothing was asked of a process that had already exited.
  assert.equal(outcome.stdinEnded, false);
  assert.deepEqual(outcome.signals, []);
  assert.equal(outcome.lost, true);
});

test("a spontaneous exit settles every pending request and completes the loss signal", async () => {
  const outcome = await withTransport(
    {
      hangInitialize: true,
      hangThreadStart: true,
      requestBudgetMillis: 60_000,
    },
    (driven) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(
          driven.transport.request("initialize", initializeParams()),
        );
        const second = yield* Effect.forkChild(
          driven.transport.request(
            "thread/start",
            threadStartParams({ cwd: "/w" }),
          ),
        );
        yield* Effect.yieldNow;
        driven.standIn.exitNow({ code: null, signal: "SIGKILL" });
        const answers = [
          (yield* Fiber.join(first)).outcome,
          (yield* Fiber.join(second)).outcome,
        ];
        return {
          answers,
          lost: yield* Deferred.isDone(driven.transport.lost),
          exited: yield* Deferred.isDone(driven.transport.exited),
          pendingRequests: driven.probe().pendingRequests,
          liveProcesses: driven.probe().liveProcesses,
        };
      }),
  );

  assert.deepEqual(outcome.answers, ["lost", "lost"]);
  assert.equal(outcome.lost, true);
  assert.equal(outcome.exited, true);
  assert.equal(outcome.pendingRequests, 0);
  assert.equal(outcome.liveProcesses, 0);
});

test("a request written after the transport is lost is lost immediately", async () => {
  const outcome = await withTransport({}, (driven) =>
    Effect.gen(function* () {
      driven.standIn.exitNow();
      const answer = yield* driven.transport.request(
        "initialize",
        initializeParams(),
      );
      return {
        answer: answer.outcome,
        methods: driven.standIn.record().methods,
      };
    }),
  );

  assert.equal(outcome.answer, "lost");
  assert.deepEqual(outcome.methods, []);
});

test("every client-bound request is answered with a JSON-RPC error", async () => {
  const outcome = await withTransport(
    {
      scripts: [
        {
          frames: [
            { frame: "server-request", method: "elicitation/create" },
            { frame: "server-request", method: "permission/request" },
          ],
        },
      ],
    },
    (driven) =>
      Effect.gen(function* () {
        // Between Runs, deliberately: the reader owns the stream for the
        // BackendAgent's life precisely so this is answered whether or not a
        // Run is active. The spike found that an unanswered one stalls the
        // server.
        yield* driven.transport.request("turn/start", {
          threadId: "root",
          input: [],
        });
        return driven.standIn.record();
      }),
  );

  assert.equal(outcome.serverRequests, 2);
  assert.equal(outcome.serverRequestAnswers, 2);
  const errors = outcome.writes
    .filter((write) => write.method === undefined && write.error !== undefined)
    .map((write) => write.error);
  assert.deepEqual(errors, [
    { ...CODEX_METHOD_NOT_SUPPORTED },
    { ...CODEX_METHOD_NOT_SUPPORTED },
  ]);
});

test("a line past the framing bound is transport loss, not a silent truncation", async () => {
  const outcome = await withTransport(
    { maxLineLength: 32, hangInitialize: true, requestBudgetMillis: 60_000 },
    (driven) =>
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(
          driven.transport.request("initialize", initializeParams()),
        );
        yield* Effect.yieldNow;
        driven.standIn.write({ frame: "oversized", length: 64 });
        const answer = yield* Fiber.join(pending);
        return {
          answer: answer.outcome,
          lost: yield* Deferred.isDone(driven.transport.lost),
          oversized: driven.tally().oversizedLines,
        };
      }),
  );

  assert.equal(outcome.answer, "lost");
  assert.equal(outcome.lost, true);
  assert.equal(outcome.oversized, 1);
});

test("provider identities are stripped from text on its way across", async () => {
  // The transport hands the child's stderr on unredacted; redaction is applied
  // where the identities are known, which is the Run. Both halves are here so
  // the rule is one assertion rather than two half-assertions.
  const redacted = redactCodexIdentities(
    'failed: {"threadId":"root-9","turnId":"turn-9"} while running turn-9 for root-9',
    ["root-9", "turn-9"],
  );

  assert.equal(redacted.includes("root-9"), false);
  assert.equal(redacted.includes("turn-9"), false);
  assert.equal(redacted.includes("[redacted]"), true);
});

test("a longer identity is redacted before a shorter one it contains", () => {
  const redacted = redactCodexIdentities("turn-1 and turn-12 differ", [
    "turn-1",
    "turn-12",
  ]);

  assert.equal(redacted.includes("turn-12"), false);
  assert.equal(redacted, "[redacted] and [redacted] differ");
});

test("an unknown method is framed as nothing, and a declared one that does not fit is one frame", async () => {
  const outcome = await withTransport({}, (driven) =>
    Effect.gen(function* () {
      // Undeclared: a real method the spike saw and this adapter never reads.
      driven.standIn.write({
        frame: "raw",
        line: '{"method":"account/rateLimits/updated","params":{"threadId":"root"}}',
      });
      // Declared, with a payload the declaration rejects. Not a crash, and not
      // a lost stream: one frame the Run turns into a bounded diagnostic.
      driven.standIn.write({
        frame: "raw",
        line: '{"method":"turn/completed","params":{"threadId":"root","turn":{}}}',
      });
      // Not JSON at all, which the App Server does not emit and which is not a
      // reason to lose a conversation either.
      driven.standIn.write({ frame: "raw", line: "not json" });
      const framed = yield* driven.framesNow();
      return {
        framed,
        malformed: driven.tally().malformedFrames,
        lost: driven.transport.isLost(),
      };
    }),
  );

  assert.deepEqual(outcome.framed, [
    { kind: "malformed", method: "turn/completed" },
  ]);
  assert.equal(outcome.malformed, 2);
  assert.equal(outcome.lost, false);
});

test("a notification is framed with its turn id, which is what routing needs", async () => {
  const outcome = await withTransport({}, (driven) =>
    Effect.gen(function* () {
      driven.standIn.write({
        frame: "for-turn",
        turnId: "turn-7",
        item: { kind: "agentMessage", id: "m1", text: "hello" },
      });
      driven.standIn.write({ frame: "stderr", text: "a warning\n" });
      return yield* driven.framesNow();
    }),
  );

  assert.deepEqual(outcome, [
    {
      kind: "notification",
      notification: {
        method: "item/completed",
        turnId: "turn-7",
        item: { type: "agentMessage", id: "m1", text: "hello" },
      },
    },
    { kind: "stderr", text: "a warning\n" },
  ]);
});

test("a trailing line with no newline is still framed when the child exits", async () => {
  const outcome = await withTransport({}, (driven) =>
    Effect.gen(function* () {
      // A child that died mid-write leaves its last frame unterminated. It is
      // still a frame the server wrote, and the exit watch is the last chance
      // to read it.
      driven.standIn.write({
        frame: "partial-line",
        text: '{"method":"turn/completed","params":{"threadId":"root","turn":{"id":"turn-1","status":"failed","items":[]}}}',
      });
      driven.standIn.exitNow({ code: null, signal: "SIGKILL" });
      return yield* driven.framesNow();
    }),
  );

  assert.deepEqual(outcome, [
    {
      kind: "notification",
      notification: {
        method: "turn/completed",
        turnId: "turn-1",
        status: "failed",
        items: [],
      },
    },
    // Behind it, and only behind it: the loss frame is what tells a Run that
    // everything the child was ever going to say has now been said.
    { kind: "lost" },
  ]);
});
