import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { answeredEnding } from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import { emitText, emitToolCall } from "../testing/fakes/script.ts";
import { fixtureResult } from "../testing/presentation-fixtures.ts";
import {
  quiesce,
  rigRequest,
  startedRun,
  until,
  untilTerminal,
  withSession,
} from "../testing/session-rig.ts";
import { DEFAULT_RUNTIME_POLICY } from "./policy.ts";

test("unreadable inspection discovers the same one-time defect as later parent and delivery reads", async () => {
  const schedule = (inspect: boolean) =>
    withSession(
      {
        resultEncoder: (result, encode) => ({
          ...(encode(result) as Record<string, unknown>),
          unexpected: true,
        }),
      },
      (rig) =>
        Effect.gen(function* () {
          // Publish/store without auto-delivery so inspection deterministically reads first.
          const result = fixtureResult();
          yield* rig.repository.publish(
            {
              runId: result.runId,
              subagentId: result.subagentId,
              backendId: result.backendId,
              agent: result.agent,
              description: result.description,
            },
            result.startedAt,
          );
          yield* rig.store.commit(result).pipe(Effect.orDie);
          yield* rig.repository.transition(result.runId, "execution-ended");
          yield* rig.repository.transition(
            result.runId,
            "settled-answered",
            result.settledAt,
          );
          assert.equal(rig.supervisor.counters().unreadableResults, 0);
          if (inspect) {
            const first = yield* rig.supervisor.inspectRun(result.runId);
            assert.equal(first.outcome, "unavailable");
            if (first.outcome === "unavailable")
              assert.match(first.diagnostic?.message ?? "", /does not decode/);
            assert.equal(
              (yield* rig.supervisor.inspectRun(result.runId)).outcome,
              "unavailable",
            );
            assert.equal(rig.supervisor.counters().unreadableResults, 1);
            assert.equal(rig.sink.unannounceableRuns().length, 0);
            assert.equal(rig.supervisor.probe().unresolvedWaiters, 0);
          }
          const parent = yield* rig.supervisor.result(result.runId);
          assert.equal(parent.outcome, "ResultExpired");
          assert.deepEqual(yield* rig.supervisor.result(result.runId), parent);
          yield* rig.delivery.deliver(result.runId);
          assert.equal(rig.supervisor.counters().unreadableResults, 1);
          return {
            parent,
            counters: rig.supervisor.counters(),
            unannounceable: rig.sink.unannounceableRuns(),
          };
        }),
    );
  const baseline = await schedule(false);
  const observed = await schedule(true);
  assert.deepEqual(observed.value, baseline.value);
  assert.equal(baseline.noLeaks, true);
  assert.equal(observed.noLeaks, true);
});

function assertPlainFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") {
    assert.notEqual(typeof value, "function");
    return;
  }
  assert.ok(
    Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
  );
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertPlainFrozen(child);
}

test("inspection returns independent immutable plain bounded values; a reduced ending remains active through cleanup", async () => {
  const more = Effect.runSync(Deferred.make<void>());
  const cleanup = Effect.runSync(Deferred.make<void>());
  const outcome = await withSession(
    {
      gates: { more, cleanup },
      steps: [
        [
          emitText("first"),
          emitToolCall("read", "call"),
          { step: "await-gate", gate: "more" },
          emitText("last"),
          {
            step: "emit",
            observation: { kind: "ending", ending: answeredEnding() },
          },
          { step: "gate-the-finalizer", gate: "cleanup" },
          { step: "complete" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const work = startedRun(yield* rig.supervisor.start(rigRequest()));
        yield* quiesce();
        const first = yield* rig.supervisor.inspectRun(work.runId);
        assert.equal(first.outcome, "active");
        if (first.outcome !== "active") throw new Error("expected active");
        assertPlainFrozen(first);
        const saved = JSON.stringify(first);
        const again = yield* rig.supervisor.inspectRun(work.runId);
        assert.equal(again.outcome, "active");
        if (again.outcome !== "active") throw new Error("expected active");
        assert.notEqual(first.content, again.content);
        assert.notEqual(first.content.transcript, again.content.transcript);
        assert.notEqual(first.usage, again.usage);
        assert.equal(Reflect.set(first.content.transcript, "0", {}), false);
        yield* Deferred.succeed(more, undefined);
        yield* until(
          "finalizing",
          Effect.map(
            rig.repository.get(work.runId),
            (row) => row?.phase === "finalizing",
          ),
        );
        yield* quiesce();
        const finalizing = yield* rig.supervisor.inspectRun(work.runId);
        assert.equal(finalizing.outcome, "active");
        if (finalizing.outcome !== "active") throw new Error("expected active");
        assert.equal(finalizing.summary.phase, "finalizing");
        assert.equal(finalizing.content.finalOutput, "last");
        assert.equal(finalizing.content.tools[0]?.status, "unfinished");
        assert.equal("terminal" in finalizing.content, false);
        assert.equal("result" in finalizing, false);
        assert.equal(
          (yield* rig.supervisor.result(work.runId)).outcome,
          "RunNotTerminal",
        );
        yield* Deferred.succeed(cleanup, undefined);
        yield* untilTerminal(rig, work.runId);
        const terminal = yield* rig.supervisor.inspectRun(work.runId);
        const authoritative = yield* rig.store.read(work.runId);
        assert.equal(terminal.outcome, "result");
        assert.equal(authoritative.outcome, "result");
        if (
          terminal.outcome === "result" &&
          authoritative.outcome === "result"
        ) {
          assert.deepEqual(terminal.result, authoritative.result);
          assertPlainFrozen(terminal);
        }
        assert.equal(JSON.stringify(first), saved);
        assert.equal(rig.supervisor.probe().unresolvedWaiters, 0);
      }),
  );
  assert.equal(outcome.noLeaks, true);
});

for (const timing of ["before", "racing", "after", "evicted"] as const)
  test(`capture/settlement race ${timing} returns a consistent active snapshot, stored Result or expiry`, async () => {
    const finish = Effect.runSync(Deferred.make<void>());
    const read = Effect.runSync(Deferred.make<void>());
    const outcome = await withSession(
      {
        testClock: true,
        policy: {
          ...DEFAULT_RUNTIME_POLICY,
          maxResultBytes: 4096,
          resultStoreBytes: 4096,
        },
        gates: { finish },
        steps: [
          [
            emitText("streamed"),
            { step: "await-gate", gate: "finish" },
            {
              step: "complete",
              reconciliation: { finalOutput: "authoritative" },
            },
          ],
        ],
      },
      (rig) =>
        Effect.gen(function* () {
          const work = startedRun(yield* rig.supervisor.start(rigRequest()));
          yield* quiesce();
          const clock = yield* Clock.Clock;
          const gatedClock: Clock.Clock = {
            ...clock,
            currentTimeMillis: Deferred.await(read).pipe(
              Effect.andThen(clock.currentTimeMillis),
            ),
          };
          const inspecting = yield* rig.supervisor
            .inspectRun(work.runId)
            .pipe(
              Effect.provideService(Clock.Clock, gatedClock),
              Effect.forkChild,
            );
          let capture: RunInspection;
          if (timing === "before") {
            yield* Deferred.succeed(read, undefined);
            capture = yield* Fiber.join(inspecting);
            yield* Deferred.succeed(finish, undefined);
          } else if (timing === "racing") {
            yield* Effect.all(
              [
                Deferred.succeed(finish, undefined),
                Deferred.succeed(read, undefined),
              ],
              { concurrency: "unbounded" },
            );
            capture = yield* Fiber.join(inspecting);
          } else {
            yield* Deferred.succeed(finish, undefined);
            yield* untilTerminal(rig, work.runId);
            yield* quiesce();
            if (timing === "evicted") {
              // Ordinary admission evicts; capture did not pin the output.
              startedRun(yield* rig.supervisor.start(rigRequest()));
              yield* quiesce();
            }
            yield* Deferred.succeed(read, undefined);
            capture = yield* Fiber.join(inspecting);
          }
          assertPlainFrozen(capture);
          if (capture.outcome === "active") {
            assert.ok(
              ["running", "finalizing"].includes(capture.summary.phase),
            );
            assert.equal(capture.summary.settledAt, undefined);
            assert.ok(
              ["streamed", "authoritative"].includes(
                capture.content.finalOutput,
              ),
            );
          } else if (capture.outcome === "result") {
            assert.equal(capture.summary.phase, "completed");
            assert.equal(capture.result.finalOutput, "authoritative");
            assert.equal(capture.summary.settledAt, capture.result.settledAt);
          } else {
            assert.equal(timing, "evicted");
            assert.equal(capture.outcome, "ResultExpired");
          }
          if (timing === "before") assert.equal(capture.outcome, "active");
          if (timing === "after") assert.equal(capture.outcome, "result");
          if (timing === "evicted")
            assert.equal(capture.outcome, "ResultExpired");
        }),
    );
    assert.equal(outcome.noLeaks, true);
  });
