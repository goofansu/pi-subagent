import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber, Queue } from "effect";
import type { ExecutionIO, RunControl } from "../../backend/contract.ts";
import { runPiExecution } from "../../backend/pi/execution.ts";
import { createPiProbeCounters } from "../../backend/pi/index.ts";
import { type RunObservation, runId } from "../../domain/index.ts";
import { until } from "./pi-rig.ts";
import { createGate, createStandInPiSession } from "./stand-in-session.ts";

const ABANDONED_GUIDANCE_DIAGNOSTIC = {
  kind: "diagnostic",
  diagnostic: {
    category: "control",
    message:
      "the Pi session finished without taking guidance that was still being delivered: [redacted]",
  },
} as const;

test("normal failure survives interruption during delivery reporting and still clears native input", async () => {
  const standIn = createStandInPiSession({
    scripts: [
      [
        { step: "await-gate", gate: "finish" },
        { step: "assistant", text: "partial", stopReason: "length" },
        { step: "terminal" },
      ],
    ],
  });
  const reporting = createGate();
  const probe = createPiProbeCounters();
  const observations: RunObservation[] = [];
  let reportingStarted = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controls = yield* Queue.unbounded<RunControl>();
        const execution = yield* Effect.forkChild(
          runPiExecution(
            {
              session: standIn.session,
              isClosed: () => false,
              closeRequested: Effect.never,
              probe,
            },
            {
              runId: runId("run-finish"),
              description: "finish",
              prompt: "go",
            },
            {
              controls: { take: Queue.take(controls) },
              emit: (observation) =>
                Effect.gen(function* () {
                  observations.push(observation);
                  if (
                    observation.kind === "diagnostic" &&
                    observation.diagnostic.category === "control"
                  ) {
                    reportingStarted = true;
                    yield* Effect.promise(() => reporting.promise);
                  }
                }),
            },
          ),
        );
        yield* until(
          "prompt",
          Effect.sync(() => standIn.record().prompts === 1),
        );
        yield* Queue.offer(controls, { type: "steer", text: "undelivered" });
        yield* until(
          "native delivery",
          Effect.sync(() => standIn.record().concurrentSteers === 1),
        );
        standIn.gate("finish").release();
        yield* until(
          "normal-finish delivery reporting",
          Effect.sync(() => reportingStarted),
        );
        assert.equal(standIn.session.isIdle, true);
        yield* Effect.promise(() =>
          standIn.session.steer("queued after native finish"),
        );
        assert.equal(standIn.session.pendingMessageCount, 1);
        yield* Fiber.interrupt(execution);
        reporting.release();
        yield* Queue.shutdown(controls);
      }),
    ),
  );
  assert.deepEqual(
    observations.filter((o) => o.kind === "ending"),
    [
      {
        kind: "ending",
        ending: {
          ending: "failed",
          message: "Pi did not complete its message: [redacted]",
        },
      },
    ],
  );
  assert.deepEqual(
    observations.flatMap((o) =>
      o.kind === "diagnostic" ? [o.diagnostic] : [],
    ),
    [
      {
        category: "control",
        message: "Pi steering was not delivered: [redacted]",
      },
      {
        category: "backend-failure",
        message: "Pi did not complete its message: [redacted]",
      },
    ],
  );
  assert.deepEqual(probe.read(), {
    openSessions: 0,
    liveSubscriptions: 0,
    pendingCleanups: 0,
  });
  assert.equal(standIn.session.pendingMessageCount, 0);
  standIn.session.dispose();
});

test("queued SDK guidance is cleared and diagnosed once on completion", async () => {
  const standIn = createStandInPiSession({
    scripts: [
      [{ step: "assistant", text: "the answer" }, { step: "terminal" }],
      [{ step: "assistant", text: "the next answer" }, { step: "terminal" }],
    ],
  });
  const drainGate = createGate();
  const probe = createPiProbeCounters();
  const observations: RunObservation[] = [];
  let drainBlocked = false;
  const io: ExecutionIO = {
    emit: (observation) => {
      if (!drainBlocked && observation.kind !== "diagnostic") {
        drainBlocked = true;
        return Effect.promise(() => drainGate.promise);
      }
      observations.push(observation);
      return Effect.void;
    },
    controls: { take: Effect.succeed(undefined) },
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* Effect.forkChild(
          runPiExecution(
            {
              session: standIn.session,
              isClosed: () => false,
              closeRequested: Effect.never,
              probe,
            },
            {
              runId: runId("run-1"),
              description: "queued guidance",
              prompt: "go",
            },
            io,
          ),
        );
        while (!drainBlocked || !standIn.session.isIdle) {
          yield* Effect.yieldNow;
        }
        yield* Effect.promise(() =>
          standIn.session.steer("guidance left in Pi's queue"),
        );
        drainGate.release();
        yield* Fiber.join(execution);
      }),
    ),
  );

  // Native work had already settled, so execution-scope closure skipped the
  // stop finalizer. The queue clear below is completion bookkeeping, not stop.
  assert.equal(standIn.record().aborts, 0);
  assert.equal(probe.read().pendingCleanups, 0);
  assert.equal(standIn.record().queueClears, 1);
  assert.deepEqual(
    observations.filter(
      (observation) =>
        observation.kind === "diagnostic" &&
        observation.diagnostic.category === "control",
    ),
    [ABANDONED_GUIDANCE_DIAGNOSTIC],
  );

  const nextRunUserTexts: string[] = [];
  standIn.session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "user") return;
    const content = event.message.content;
    if (typeof content === "string") nextRunUserTexts.push(content);
    else {
      nextRunUserTexts.push(
        content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      );
    }
  });
  await standIn.session.prompt("next");
  assert.deepEqual(nextRunUserTexts, ["next"]);
});
