import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Scope } from "effect";
import {
  answeredEnding,
  backendId,
  DEFAULT_BACKEND_ID,
  type Profile,
  runId,
  type SubagentContext,
  subagentId,
} from "../domain/index.ts";
import type { Equals, Expect } from "../testing/type-level.ts";
import {
  BACKEND_AGENT_MEMBERS,
  BACKEND_CAPABILITY_MEMBERS,
  BACKEND_MEMBERS,
  type Backend,
  type BackendAgent,
  type BackendCapabilities,
  CONTROL_FEED_MEMBERS,
  type ControlFeed,
  EXECUTION_IO_MEMBERS,
  type ExecutionIO,
  RESUME_ADMISSIONS,
  type ResumeAdmission,
  RUN_INPUT_MEMBERS,
  type RunInput,
  TERMINAL_BUNDLE_MEMBERS,
  type TerminalBundle,
} from "./contract.ts";
import { createBackendRegistry } from "./registry.ts";

/**
 * The contract's shape, pinned.
 *
 * A backend contract is the seam every adapter from M4 onward implements, so
 * widening it is expensive in a way that is invisible at the moment it
 * happens: one more member is one more thing three adapters must do. These
 * assertions make widening a failing test.
 *
 * Four kinds of vocabulary are named as forbidden below because they are the
 * four that would actually try to get in: **attempt** vocabulary (adapter
 * internals about native retries), **continuation tokens** (provider paging
 * and resumption handles), a **cancellation signal object** (which would
 * replace Effect interruption with something an adapter has to poll), and
 * **provider control types** (a backend's own steering request shape). None of
 * them appears in any signature here, and none may be added.
 */

const FORBIDDEN_CONTRACT_VOCABULARY = [
  "attempt",
  "continuation",
  "continuationToken",
  "cursor",
  "abortController",
  "abortSignal",
  "signal",
  "providerControl",
  "wireControl",
  "threadId",
  "turnId",
] as const;

/* -------------------------------------------------------------- */
/* Type-level shape                                                */
/* -------------------------------------------------------------- */

type ContractShapeIsExact = [
  Expect<Equals<keyof Backend, (typeof BACKEND_MEMBERS)[number]>>,
  Expect<Equals<keyof BackendAgent, (typeof BACKEND_AGENT_MEMBERS)[number]>>,
  Expect<
    Equals<
      keyof BackendCapabilities,
      (typeof BACKEND_CAPABILITY_MEMBERS)[number]
    >
  >,
  Expect<Equals<keyof RunInput, (typeof RUN_INPUT_MEMBERS)[number]>>,
  Expect<Equals<keyof ExecutionIO, (typeof EXECUTION_IO_MEMBERS)[number]>>,
  Expect<Equals<keyof ControlFeed, (typeof CONTROL_FEED_MEMBERS)[number]>>,
  Expect<
    Equals<keyof TerminalBundle, (typeof TERMINAL_BUNDLE_MEMBERS)[number]>
  >,
  Expect<Equals<ResumeAdmission, (typeof RESUME_ADMISSIONS)[number]>>,
];

/** `open` and `execute` both require a Scope, and neither can fail. */
type LifetimesAreInTheTypes = [
  Expect<Equals<Effect.Services<ReturnType<Backend["open"]>>, Scope.Scope>>,
  Expect<Equals<Effect.Error<ReturnType<Backend["open"]>>, never>>,
  Expect<
    Equals<Effect.Services<ReturnType<BackendAgent["execute"]>>, Scope.Scope>
  >,
  Expect<Equals<Effect.Error<ReturnType<BackendAgent["execute"]>>, never>>,
  // `close` needs no scope: it releases, it does not acquire.
  Expect<Equals<Effect.Services<ReturnType<BackendAgent["close"]>>, never>>,
];

test("the three interfaces and the terminal bundle have exactly these members", () => {
  const proofs: ContractShapeIsExact = [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ];

  assert.equal(proofs.length, 8);
  assert.deepEqual([...BACKEND_MEMBERS], ["id", "validateProfile", "open"]);
  assert.deepEqual(
    [...BACKEND_AGENT_MEMBERS],
    ["capabilities", "admitResume", "execute", "close"],
  );
  assert.deepEqual(
    [...BACKEND_CAPABILITY_MEMBERS],
    ["resume", "steer", "terminalTranscriptSnapshot"],
  );
  assert.deepEqual([...TERMINAL_BUNDLE_MEMBERS], ["ending", "reconciliation"]);
  assert.deepEqual([...EXECUTION_IO_MEMBERS], ["emit", "controls"]);
  assert.deepEqual([...CONTROL_FEED_MEMBERS], ["take"]);
  assert.deepEqual([...RUN_INPUT_MEMBERS], ["runId", "description", "prompt"]);
});

test("scope requirements and the absent failure channel are in the types", () => {
  const proofs: LifetimesAreInTheTypes = [true, true, true, true, true];

  assert.equal(proofs.length, 5);
});

test("resume admission has exactly three outcomes and no fourth", () => {
  assert.deepEqual(
    [...RESUME_ADMISSIONS],
    ["admitted", "unsupported", "conversation lost"],
  );

  const admissions: ResumeAdmission[] = [...RESUME_ADMISSIONS];
  // @ts-expect-error there is no fourth outcome, and this is the proof
  admissions.push("retry later");
  assert.equal(admissions.length, 4);
});

test("no contract member names attempt, continuation, or signal vocabulary", () => {
  const members = [
    ...BACKEND_MEMBERS,
    ...BACKEND_AGENT_MEMBERS,
    ...BACKEND_CAPABILITY_MEMBERS,
    ...RUN_INPUT_MEMBERS,
    ...EXECUTION_IO_MEMBERS,
    ...CONTROL_FEED_MEMBERS,
    ...TERMINAL_BUNDLE_MEMBERS,
  ];

  for (const member of members) {
    for (const forbidden of FORBIDDEN_CONTRACT_VOCABULARY) {
      assert.notEqual(
        member.toLowerCase(),
        forbidden.toLowerCase(),
        `'${member}' is forbidden contract vocabulary`,
      );
    }
  }
});

/* -------------------------------------------------------------- */
/* A stand-in implementation                                       */
/* -------------------------------------------------------------- */

const profile: Profile = {
  name: "stand-in",
  description: "A stand-in specialist",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Do the thing.",
};

const context: SubagentContext = {
  subagentId: subagentId("subagent-1"),
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

/**
 * The smallest thing that satisfies the contract, plus a log of what its
 * lifetimes did. Its only job is to prove the scope rules hold for a real
 * implementation rather than only in the types.
 */
function standInBackend(log: string[]): Backend {
  return {
    id: backendId("stand-in"),
    validateProfile: () => [],
    open: () =>
      Effect.acquireRelease(
        Effect.sync((): BackendAgent => {
          log.push("opened");
          return {
            capabilities: {
              resume: true,
              steer: false,
              terminalTranscriptSnapshot: false,
            },
            admitResume: () => "admitted",
            execute: (input) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  log.push(`execution-started:${input.runId}`);
                  return input.runId;
                }),
                () => Effect.sync(() => void log.push("execution-released")),
              ).pipe(Effect.as<TerminalBundle>({ ending: answeredEnding() })),
            close: () => Effect.sync(() => void log.push("closed")),
          };
        }),
        (agent) => agent.close(),
      ),
  };
}

const io: ExecutionIO = {
  emit: () => Effect.void,
  controls: { take: Effect.succeed(undefined) },
};

test("releasing the scope that opened a BackendAgent closes it", async () => {
  const log: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const backend = standInBackend(log);
      yield* backend.open(profile, context).pipe(Scope.provide(scope));
      log.push("subagent-alive");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  assert.deepEqual(log, ["opened", "subagent-alive", "closed"]);
});

test("an execution's scope closes independently of the Subagent's", async () => {
  const log: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const subagentScope = yield* Scope.make();
      const agent = yield* standInBackend(log)
        .open(profile, context)
        .pipe(Scope.provide(subagentScope));

      const executionScope = yield* Scope.make();
      const bundle = yield* agent
        .execute({ runId: runId("run-1"), description: "d", prompt: "p" }, io)
        .pipe(Scope.provide(executionScope));
      assert.deepEqual(bundle, { ending: { ending: "answered" } });
      yield* Scope.close(executionScope, Exit.void);
      log.push("between-runs");
      yield* Scope.close(subagentScope, Exit.void);
    }),
  );

  assert.deepEqual(log, [
    "opened",
    "execution-started:run-1",
    "execution-released",
    "between-runs",
    "closed",
  ]);
});

test("opening a BackendAgent creates no Run and emits no observation", async () => {
  const log: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* standInBackend(log)
        .open(profile, context)
        .pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  // `open` is handed no observation sink at all, so "emits no observation" is
  // a property of the contract's shape rather than of this implementation.
  // What is left to check is that it started no execution.
  assert.deepEqual(log, ["opened", "closed"]);
  assert.deepEqual(
    log.filter((entry) => entry.startsWith("execution-")),
    [],
  );
});

test("admitting a resume is a plain synchronous call, not an Effect", async () => {
  const admission = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const agent = yield* standInBackend([])
        .open(profile, context)
        .pipe(Scope.provide(scope));
      // No `yield*`: the decision is available without running anything.
      const decided = agent.admitResume();
      yield* Scope.close(scope, Exit.void);
      return decided;
    }),
  );

  assert.equal(admission, "admitted");
});

/* -------------------------------------------------------------- */
/* Registry                                                       */
/* -------------------------------------------------------------- */

test("the registry validates a Profile through the backend it names", () => {
  const backend: Backend = {
    ...standInBackend([]),
    id: backendId("pi"),
    validateProfile: (subject, filePath) => [
      { filePath, reason: `pi saw ${subject.name}` },
    ],
  };
  const registry = createBackendRegistry([backend]);

  assert.deepEqual(registry.ids, ["pi"]);
  assert.equal(registry.get(backendId("pi")), backend);
  assert.equal(registry.get(backendId("codex")), undefined);
  assert.deepEqual(registry.validateProfile(profile, "/agents/x.md"), [
    { filePath: "/agents/x.md", reason: "pi saw stand-in" },
  ]);
});

test("a Profile naming an unknown backend is one diagnostic, not an exception", () => {
  const registry = createBackendRegistry([]);

  assert.deepEqual(registry.validateProfile(profile, "/agents/x.md"), [
    { filePath: "/agents/x.md", reason: "unknown backend 'pi'" },
  ]);
});
