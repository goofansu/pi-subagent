import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Deferred, Effect, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import type { BackendAgent } from "../backend/contract.ts";
import {
  backendId,
  type Profile,
  type SubagentId,
  subagentId,
} from "../domain/index.ts";
import { makeCleanupEscalation } from "./cleanup-escalation.ts";
import { createRuntimeCounters } from "./counters.ts";
import { makeSubagentRecords } from "./subagent-records.ts";

const profile: Profile = {
  name: "explore",
  description: "look around",
  backend: backendId("fake"),
  fields: {},
  systemPrompt: "",
};

interface CleanupRig {
  readonly cleanup: ReturnType<typeof makeCleanupEscalation>;
  readonly counters: ReturnType<typeof createRuntimeCounters>;
  readonly records: ReturnType<typeof makeSubagentRecords>;
  readonly id: SubagentId;
  readonly agent: BackendAgent;
  readonly closes: () => number;
}

function closingAgent(
  close: Effect.Effect<void>,
  onClose: () => void,
): BackendAgent {
  return {
    capabilities: {
      resume: true,
      steer: false,
      terminalTranscriptSnapshot: false,
    },
    admitResume: () => "admitted",
    execute: () => Effect.die("cleanup tests do not execute a Run"),
    close: () => Effect.sync(onClose).pipe(Effect.andThen(close)),
  };
}

function withCleanup<A>(
  close: Effect.Effect<void> = Effect.void,
  body: (rig: CleanupRig) => Effect.Effect<A>,
): Promise<A> {
  const counters = createRuntimeCounters();
  const records = makeSubagentRecords();
  const id = subagentId("subagent-cleanup");
  let closeCalls = 0;
  const agent = closingAgent(close, () => {
    closeCalls += 1;
  });

  return Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const subagentScope = yield* Scope.make();
      records.insert({
        id,
        profile,
        context: {
          subagentId: id,
          cwd: "/tmp",
          childDepth: 0,
          projectTrusted: true,
        },
        agent,
        scope: subagentScope,
      });
      const cleanup = makeCleanupEscalation(counters, clock, 1_000, records);
      return yield* body({
        cleanup,
        counters,
        records,
        id,
        agent,
        closes: () => closeCalls,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
}

function hangingScope(
  gate: Deferred.Deferred<void>,
): Effect.Effect<Scope.Closeable> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(
      scope,
      Effect.uninterruptible(Deferred.await(gate)),
    );
    return scope;
  });
}

test("an in-budget native execution scope close yields no diagnostic and counts nothing", async () => {
  const value = await withCleanup(Effect.void, (rig) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const diagnostic = yield* rig.cleanup.closeExecutionScope({
        subagentId: rig.id,
        agent: rig.agent,
        scope,
      });
      return { diagnostic, counters: rig.counters.counters() };
    }),
  );

  assert.equal(value.diagnostic, undefined);
  assert.equal(value.counters.cleanupEscalations, 0);
});

test("an overrun yields one diagnostic, count, BackendAgent close, and lost Conversation", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const value = await withCleanup(Effect.void, (rig) =>
    Effect.gen(function* () {
      const scope = yield* hangingScope(gate);
      const closing = yield* Effect.forkChild(
        rig.cleanup.closeExecutionScope({
          subagentId: rig.id,
          agent: rig.agent,
          scope,
        }),
      );
      yield* TestClock.adjust(1_001);
      const diagnostic = yield* Fiber.join(closing);
      yield* Deferred.succeed(gate, undefined);
      return {
        diagnostic,
        counters: rig.counters.counters(),
        closes: rig.closes(),
        conversationLost: rig.records.get(rig.id)?.conversationLost,
      };
    }),
  );

  assert.equal(value.diagnostic?.category, "cleanup-escalation");
  assert.equal(value.counters.cleanupEscalations, 1);
  assert.equal(value.closes, 1);
  assert.equal(value.conversationLost, true);
});

test("a repeated same-Run overrun returns the same diagnostic without recounting or reclosing", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const value = await withCleanup(Effect.void, (rig) =>
    Effect.gen(function* () {
      const scope = yield* hangingScope(gate);
      const request = {
        subagentId: rig.id,
        agent: rig.agent,
        scope,
      };
      const closing = yield* Effect.forkChild(
        rig.cleanup.closeExecutionScope(request),
      );
      yield* TestClock.adjust(1_001);
      const first = yield* Fiber.join(closing);
      const second = yield* rig.cleanup.closeExecutionScope({
        ...request,
        alreadyOverran: true,
      });
      yield* Deferred.succeed(gate, undefined);
      return {
        first,
        second,
        counters: rig.counters.counters(),
        closes: rig.closes(),
      };
    }),
  );

  assert.equal(value.second, value.first);
  assert.equal(value.counters.cleanupEscalations, 1);
  assert.equal(value.closes, 1);
});

test("a known execution overrun starts detached Scope disposal without waiting for it", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const value = await withCleanup(Effect.void, (rig) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      yield* Scope.addFinalizer(
        scope,
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Effect.uninterruptible(Deferred.await(gate));
        }),
      );
      const closing = yield* Effect.forkChild(
        rig.cleanup.closeExecutionScope({
          subagentId: rig.id,
          agent: rig.agent,
          scope,
          alreadyOverran: true,
        }),
      );
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      const returnedWhileDisposalHung = closing.pollUnsafe() !== undefined;
      yield* Deferred.succeed(gate, undefined);
      const diagnostic = yield* Fiber.join(closing);
      return {
        diagnostic,
        returnedWhileDisposalHung,
        counters: rig.counters.counters(),
        closes: rig.closes(),
      };
    }),
  );

  assert.equal(value.returnedWhileDisposalHung, true);
  assert.equal(value.diagnostic?.category, "cleanup-escalation");
  assert.equal(value.counters.cleanupEscalations, 1);
  assert.equal(value.closes, 1);
});

test("a post-settlement BackendAgent close overrun counts once and yields nothing", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const value = await withCleanup(
    Effect.uninterruptible(Deferred.await(gate)),
    (rig) =>
      Effect.gen(function* () {
        const record = rig.records.get(rig.id);
        if (record === undefined) return yield* Effect.die("missing record");
        yield* Scope.addFinalizer(record.scope, rig.agent.close());
        const closing = yield* Effect.forkChild(
          rig.cleanup.closeBackendAgent(rig.agent, rig.id),
        );
        yield* TestClock.adjust(1_001);
        const result = yield* Fiber.join(closing);
        yield* Deferred.succeed(gate, undefined);
        return {
          result,
          counters: rig.counters.counters(),
          closes: rig.closes(),
        };
      }),
  );

  assert.equal(value.result, undefined);
  assert.equal(value.counters.cleanupEscalations, 1);
  assert.equal(value.closes, 1);
});

test("a missing record falls back to a bounded close of the supplied BackendAgent", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const value = await withCleanup(
    Effect.uninterruptible(Deferred.await(gate)),
    (rig) =>
      Effect.gen(function* () {
        rig.records.clear();
        const closing = yield* Effect.forkChild(
          rig.cleanup.closeBackendAgent(rig.agent, rig.id),
        );
        yield* TestClock.adjust(1_001);
        const result = yield* Fiber.join(closing);
        yield* Deferred.succeed(gate, undefined);
        return {
          result,
          counters: rig.counters.counters(),
          closes: rig.closes(),
        };
      }),
  );

  assert.equal(value.result, undefined);
  assert.equal(value.counters.cleanupEscalations, 1);
  assert.equal(value.closes, 1);
});

test("a mismatched record falls back to a bounded close of the supplied BackendAgent", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const value = await withCleanup(Effect.void, (rig) =>
    Effect.gen(function* () {
      let suppliedCloses = 0;
      const supplied = closingAgent(
        Effect.uninterruptible(Deferred.await(gate)),
        () => {
          suppliedCloses += 1;
        },
      );
      const closing = yield* Effect.forkChild(
        rig.cleanup.closeBackendAgent(supplied, rig.id),
      );
      yield* TestClock.adjust(1_001);
      const result = yield* Fiber.join(closing);
      yield* Deferred.succeed(gate, undefined);
      return {
        result,
        counters: rig.counters.counters(),
        recordAgentCloses: rig.closes(),
        suppliedCloses,
      };
    }),
  );

  assert.equal(value.result, undefined);
  assert.equal(value.counters.cleanupEscalations, 1);
  assert.equal(value.recordAgentCloses, 0);
  assert.equal(value.suppliedCloses, 1);
});
