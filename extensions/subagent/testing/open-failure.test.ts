import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import type { BackendOpenFailure } from "../backend/contract.ts";
import {
  DEFAULT_BACKEND_ID,
  type Profile,
  runId,
  type SubagentContext,
  subagentId,
} from "../domain/index.ts";
import {
  createFakeOneShotBackend,
  createFakeResumableBackend,
  type FakeBackendHandle,
} from "./fakes/backend.ts";
import { scripts } from "./fakes/script.ts";

/**
 * The three things a fake backend has to be able to do wrong at open and at
 * cleanup, per ADR-0030.
 *
 * These are fake-level tests: they exercise the script controls themselves,
 * not the supervisor's reaction to them. A control that does not do what its
 * name says would make every scenario built on it pass for the wrong reason,
 * so each one is proven here once, directly, before anything depends on it.
 */

const profile: Profile = {
  name: "explorer",
  description: "Explores",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Explore.",
};

const context: SubagentContext = {
  subagentId: subagentId("subagent-1"),
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

const fakes: readonly [
  string,
  (
    options: Parameters<typeof createFakeResumableBackend>[0],
  ) => FakeBackendHandle,
][] = [
  ["resumable", createFakeResumableBackend],
  ["one-shot", createFakeOneShotBackend],
];

test("either fake can refuse to open, reporting only a redacted diagnostic", async () => {
  for (const [name, create] of fakes) {
    const trace: string[] = [];
    const handle = create({
      scripts: scripts([]),
      open: { open: "fails", reason: "the provider refused the connection" },
      trace,
    });

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const attempt = yield* Effect.exit(
          handle.backend.open(profile, context).pipe(Scope.provide(scope)),
        );
        yield* Scope.close(scope, Exit.void);
        return attempt;
      }),
    );

    assert.equal(Exit.isFailure(exit), true, name);
    const failure: BackendOpenFailure | undefined = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    assert.deepEqual(
      failure,
      { diagnostic: { category: "backend-failure", message: "[redacted]" } },
      name,
    );
    // The fake's own reason is the provider text, and it stayed behind: the
    // trace is adapter-local evidence, and the failure carries the category.
    assert.deepEqual(
      trace,
      ["agent-open-failed:the provider refused the connection"],
      name,
    );
    // Nothing was acquired, so there is nothing to release.
    assert.equal(handle.counters().opens, 0, name);
    assert.equal(handle.counters().closes, 0, name);
    assert.equal(handle.identityAcquired(), false, name);
  }
});

test("either fake can hang while opening, until it is interrupted", async () => {
  for (const [name, create] of fakes) {
    const trace: string[] = [];
    const handle = create({
      scripts: scripts([]),
      open: { open: "hangs" },
      trace,
    });

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const fiber = yield* Effect.forkChild(
          handle.backend.open(profile, context).pipe(Scope.provide(scope)),
        );
        // One scheduling point, so the forked open actually reaches its hang
        // rather than being interrupted before it starts. Nothing waits on a
        // clock: the open is interrupted the moment the caller decides it has
        // waited long enough, which is what a bounded open budget does with a
        // test clock driving it.
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        const [outcome] = yield* Fiber.awaitAll([fiber]);
        yield* Scope.close(scope, Exit.void);
        return outcome;
      }),
    );

    assert.equal(
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
      true,
      name,
    );
    assert.deepEqual(trace, ["agent-open-hanging"], name);
    assert.equal(handle.counters().opens, 0, name);
  }
});

test("a hanging open finishes if the gate it waits on completes", async () => {
  const trace: string[] = [];
  const opened = await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const handle = createFakeResumableBackend({
        scripts: scripts([]),
        open: { open: "hangs", gate: "release-open" },
        gates: { "release-open": release },
        trace,
      });
      const scope = yield* Scope.make();
      const fiber = yield* Effect.forkChild(
        handle.backend.open(profile, context).pipe(Scope.provide(scope)),
      );
      yield* Deferred.succeed(release, undefined);
      const agent = yield* Fiber.join(fiber);
      const capabilities = agent.capabilities;
      yield* Scope.close(scope, Exit.void);
      return capabilities;
    }),
  );

  assert.equal(opened.resume, true);
  assert.deepEqual(trace, [
    "agent-open-hanging",
    "agent-opened",
    "agent-closed",
  ]);
});

test("either fake can hang in the execution scope's finalizer", async () => {
  for (const [name, create] of fakes) {
    const trace: string[] = [];
    const handle = create({
      scripts: scripts([{ step: "hang-in-finalizer" }]),
      trace,
    });

    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        const subagentScope = yield* Scope.make();
        const agent = yield* handle.backend
          .open(profile, context)
          .pipe(Scope.provide(subagentScope));

        const executionScope = yield* Scope.make();
        yield* agent
          .execute(
            { runId: runId("run-1"), description: "d", prompt: "p" },
            {
              emit: () => Effect.void,
              controls: { take: Effect.succeed(undefined) },
            },
          )
          .pipe(Scope.provide(executionScope));

        // Closing the execution scope never finishes. The caller races it and
        // gives up, which is exactly what the cleanup budget will do.
        const closing = yield* Effect.forkChild(
          Scope.close(executionScope, Exit.void),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(closing);
        const [outcome] = yield* Fiber.awaitAll([closing]);
        yield* Scope.close(subagentScope, Exit.void);
        return outcome;
      }),
    );

    assert.equal(
      Exit.isFailure(closed) && Cause.hasInterruptsOnly(closed.cause),
      true,
      name,
    );
    assert.ok(trace.includes("finalizer-armed:run-1"), `${name}: ${trace}`);
    assert.ok(trace.includes("finalizer-hanging:run-1"), `${name}: ${trace}`);
    // The BackendAgent itself still closes: the hang is inside the Run's
    // nested execution scope, not in the Subagent's.
    assert.equal(handle.counters().closes, 1, name);
  }
});
