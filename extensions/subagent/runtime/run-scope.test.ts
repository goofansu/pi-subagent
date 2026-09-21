import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { type RunIdentity, runDiagnostic } from "../domain/index.ts";
import {
  createFakeResumableBackend,
  type FakeBackendHandle,
} from "../testing/fakes/backend.ts";
import { emitText, type FakeStep } from "../testing/fakes/script.ts";
import { RIG_PROFILE } from "../testing/session-rig.ts";
import {
  createRuntimeCounters,
  probeIsClear,
  type RuntimeProbe,
} from "./counters.ts";
import { DEFAULT_RUNTIME_POLICY } from "./policy.ts";
import { RunRepository } from "./repository.ts";
import { ResultStore } from "./result-store.ts";
import { makeRunHandle, type RunContext, type RunHandle } from "./run-scope.ts";

/**
 * The Run handle's stop protocol, on the near side of the fork.
 *
 * A stop that arrives once the execution fiber exists — including after it has
 * exited — can be pinned from a Session, and `races.test.ts` verifies it there
 * beside the other cancellation races. A stop that arrives *before* the fork
 * cannot: the activation gate opens inside `start`, so by the time a Session
 * test holds a Run id, settlement may already have forked. Here the test forks
 * settlement itself, which makes "before the fork" a fact of the test rather
 * than the outcome of a race it hopes to win.
 *
 * What it asserts is what the Session tests assert: one terminal Result with
 * the ending the Run earned, and nothing left live afterwards.
 */

interface HandleRig {
  readonly handle: RunHandle;
  readonly backend: FakeBackendHandle;
  readonly counters: ReturnType<typeof createRuntimeCounters>;
  readonly trace: readonly string[];
  readonly afterStop: Deferred.Deferred<void>;
}

/**
 * Build one published Run handle over the real repository and store.
 *
 * This is the supervisor's assembly with everything a stop does not touch left
 * out: no admission lease, no Subagent record, no delivery. What remains is a
 * Run that can settle, so that a stop's effect on settlement is the only thing
 * a test here can be reading.
 */
function withRunHandle<A>(
  steps: readonly FakeStep[],
  body: (rig: HandleRig) => Effect.Effect<A>,
): Promise<{ readonly value: A; readonly probe: RuntimeProbe }> {
  const counters = createRuntimeCounters();
  const program = Effect.gen(function* () {
    const repository = yield* RunRepository;
    const store = yield* ResultStore;
    const trace: string[] = [];
    const afterStop = yield* Deferred.make<void>();
    const backend = createFakeResumableBackend({
      scripts: [{ steps }],
      gates: { "after-stop": afterStop },
      trace,
    });

    const subagentId = yield* repository.allocateSubagentId();
    const runId = yield* repository.allocateRunId();
    const agent = yield* Effect.orDie(
      backend.backend.open(RIG_PROFILE, {
        subagentId,
        cwd: "/work",
        childDepth: 1,
        projectTrusted: true,
      }),
    );
    const identity: RunIdentity = {
      runId,
      subagentId,
      backendId: RIG_PROFILE.backend,
      agent: RIG_PROFILE.name,
      description: "look around",
    };
    const startedAt = yield* Effect.clockWith(
      (clock) => clock.currentTimeMillis,
    );
    const context: RunContext = {
      identity,
      input: {
        runId,
        description: identity.description,
        prompt: "have a look",
      },
      agent,
      repository,
      store,
      counters,
      bounds: DEFAULT_RUNTIME_POLICY.projection,
      observationQueueBound: DEFAULT_RUNTIME_POLICY.observationQueueBound,
      controlBounds: DEFAULT_RUNTIME_POLICY.controls,
      startedAt,
      now: Effect.clockWith((clock) => clock.currentTimeMillis),
      trace: () => {},
      closeExecutionScope: (scope) =>
        Effect.as(Scope.close(scope, Exit.void), undefined),
      cleanupBudgetMillis: DEFAULT_RUNTIME_POLICY.cleanupBudgetMillis,
      escalateRunCleanup: Effect.succeed(
        runDiagnostic("other", "cleanup outlived its budget"),
      ),
      onSettled: () => Effect.void,
    };

    const handle = yield* makeRunHandle(context);
    yield* repository.publish(identity, startedAt, context.input.prompt);
    return yield* body({ handle, backend, counters, trace, afterStop });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        RunRepository.layerOf(counters),
        ResultStore.layerOf(DEFAULT_RUNTIME_POLICY, counters),
      ),
    ),
  );

  return Effect.runPromise(
    Effect.map(program, (value) => ({ value, probe: counters.probe() })),
  );
}

test("a recorded decision survives a later interrupt and is applied once", async () => {
  const { value, probe } = await withRunHandle(
    [
      {
        step: "decide",
        reconciliation: { finalOutput: "the decided answer" },
      },
      emitText("cleanup detail after the decision"),
      { step: "hang" },
    ],
    (rig) =>
      Effect.gen(function* () {
        const settling = yield* Effect.forkChild(rig.handle.settle);
        yield* rig.handle.activate;
        while (
          !rig.trace.some((entry) => entry.startsWith("decision-recorded:"))
        ) {
          yield* Effect.yieldNow;
        }
        yield* rig.handle.stop;
        const settled = yield* Fiber.join(settling);
        return {
          status: settled.result.status,
          output: settled.result.finalOutput,
          arbitration: settled.arbitration.from,
          transcript: settled.result.transcript,
          reports: settled.reports,
          duplicateDecisions: rig.counters.counters().duplicateDecisions,
        };
      }),
  );

  assert.equal(value.status, "completed");
  assert.equal(value.output, "the decided answer");
  assert.equal(value.arbitration, "recorded-decision");
  assert.equal(value.duplicateDecisions, 0);
  assert.equal(value.transcript.length, 1, "recording did not seal intake");
  assert.equal(value.reports.length, 3);
  assert.deepEqual(value.reports[1], {
    report: "applied",
    changed: ["finalOutput"],
  });
  assert.deepEqual(value.reports[2], { report: "applied" });
  assert.equal(probeIsClear(probe), true);
});

test("a stop before a decision cancels with its first reason and applies reconciliation once", async () => {
  const { value, probe } = await withRunHandle(
    [
      {
        step: "decide-after-stop",
        gate: "after-stop",
        reconciliation: { finalOutput: "authoritative partial output" },
      },
    ],
    (rig) =>
      Effect.gen(function* () {
        const settling = yield* Effect.forkChild(rig.handle.settle);
        yield* rig.handle.activate;
        while (
          !rig.trace.some((entry) =>
            entry.startsWith("decision-awaiting-stop:"),
          )
        ) {
          yield* Effect.yieldNow;
        }
        yield* rig.handle.stop;
        yield* Deferred.succeed(rig.afterStop, undefined);
        const settled = yield* Fiber.join(settling);
        return {
          status: settled.result.status,
          reason:
            settled.arbitration.ending.ending === "cancelled"
              ? settled.arbitration.ending.reason
              : undefined,
          output: settled.result.finalOutput,
          reports: settled.reports,
          duplicateDecisions: rig.counters.counters().duplicateDecisions,
        };
      }),
  );

  assert.equal(value.status, "cancelled");
  assert.equal(value.reason, "requested");
  assert.equal(value.output, "authoritative partial output");
  assert.equal(value.duplicateDecisions, 0);
  assert.deepEqual(value.reports, [
    { report: "applied", changed: ["finalOutput"] },
    { report: "applied" },
  ]);
  assert.equal(probeIsClear(probe), true);
});

test("a defect keeps a recorded decision's reconciliation before failing", async () => {
  const { value } = await withRunHandle(
    [
      {
        step: "decide",
        reconciliation: { finalOutput: "authoritative partial output" },
      },
      { step: "defect", message: "adapter died after deciding" },
    ],
    (rig) =>
      Effect.gen(function* () {
        const settling = yield* Effect.forkChild(rig.handle.settle);
        yield* rig.handle.activate;
        const settled = yield* Fiber.join(settling);
        return {
          status: settled.result.status,
          output: settled.result.finalOutput,
          reports: settled.reports,
          duplicateDecisions: rig.counters.counters().duplicateDecisions,
        };
      }),
  );

  assert.equal(value.status, "failed");
  assert.equal(value.output, "authoritative partial output");
  assert.equal(value.duplicateDecisions, 0);
  assert.deepEqual(value.reports, [
    { report: "applied" },
    { report: "applied", changed: ["finalOutput"] },
    { report: "applied" },
  ]);
});

test("recording a decision twice keeps the first and counts one duplicate", async () => {
  const { value } = await withRunHandle(
    [
      { step: "decide", reconciliation: { finalOutput: "first" } },
      { step: "decide", reconciliation: { finalOutput: "second" } },
      { step: "hang" },
    ],
    (rig) =>
      Effect.gen(function* () {
        const settling = yield* Effect.forkChild(rig.handle.settle);
        yield* rig.handle.activate;
        while (
          rig.trace.filter((entry) => entry.startsWith("decision-recorded:"))
            .length < 2
        ) {
          yield* Effect.yieldNow;
        }
        yield* rig.handle.stop;
        const settled = yield* Fiber.join(settling);
        return {
          output: settled.result.finalOutput,
          duplicateDecisions: rig.counters.counters().duplicateDecisions,
        };
      }),
  );

  assert.deepEqual(value, { output: "first", duplicateDecisions: 1 });
});

test("a return after a decision is one duplicate and the first decision stands", async () => {
  const { value } = await withRunHandle(
    [
      { step: "decide", reconciliation: { finalOutput: "first" } },
      { step: "complete", ending: { ending: "failed", message: "later" } },
    ],
    (rig) =>
      Effect.gen(function* () {
        const settling = yield* Effect.forkChild(rig.handle.settle);
        yield* rig.handle.activate;
        const settled = yield* Fiber.join(settling);
        return {
          status: settled.result.status,
          output: settled.result.finalOutput,
          duplicateDecisions: rig.counters.counters().duplicateDecisions,
        };
      }),
  );

  assert.deepEqual(value, {
    status: "completed",
    output: "first",
    duplicateDecisions: 1,
  });
});

test("a stop before the execution fiber is forked still cancels the Run and leaves nothing running", async () => {
  const { value, probe } = await withRunHandle(
    [emitText("never said")],
    (rig) =>
      Effect.gen(function* () {
        // Nothing has been forked yet: settlement is still an unstarted Effect,
        // so this stop is strictly earlier than the execution it interrupts.
        yield* rig.handle.stop;
        const settling = yield* Effect.forkChild(rig.handle.settle);
        yield* rig.handle.activate;
        const settled = yield* Fiber.join(settling);
        return {
          status: settled.result.status,
          reason:
            settled.arbitration.ending.ending === "cancelled"
              ? settled.arbitration.ending.reason
              : undefined,
          liveExecutionFibers: rig.backend.counters().liveExecutionFibers,
          steerAfterStop: yield* rig.handle.admitControl({
            type: "steer",
            text: "too late",
          }),
        };
      }),
  );

  assert.deepEqual(value, {
    status: "cancelled",
    reason: "requested",
    // Whether the scheduler let the execution take a step before the
    // interruption reached it is not something the protocol promises, so this
    // asserts what it does: the fiber is gone, not that it never ran.
    liveExecutionFibers: 0,
    steerAfterStop: "mailbox closed",
  });
  assert.equal(probeIsClear(probe), true);
});
