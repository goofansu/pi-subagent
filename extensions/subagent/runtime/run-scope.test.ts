import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
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
    const backend = createFakeResumableBackend({ scripts: [{ steps }] });

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
    yield* repository.publish(identity, startedAt);
    return yield* body({ handle, backend });
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
