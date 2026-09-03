import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { createBackendCatalog } from "../backend/catalog.ts";
import { claudeProbeIsClear } from "../backend/claude/index.ts";
import { codexProbeIsClear } from "../backend/codex/index.ts";
import { DEPTH_ENV_KEY, piProbeIsClear } from "../backend/pi/index.ts";
import { backendId, type Profile, parseProfile } from "../domain/index.ts";
import { sessionRuntimeLayer } from "../runtime/composition.ts";
import { createRuntimeCounters } from "../runtime/counters.ts";
import { ProfileCatalog } from "../runtime/profile-catalog.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import {
  createStandInClaudeQuery,
  STAND_IN_MODEL,
} from "../testing/claude/stand-in-query.ts";
import { createStandInAppServer } from "../testing/codex/stand-in-app-server.ts";
import { createFakeNotificationSink } from "../testing/fake-sink.ts";
import {
  createProductionBackendSet,
  PRODUCTION_BACKEND_SET_NAME,
} from "./production-backends.ts";

/**
 * The set the extension actually ships.
 *
 * What it has to get right is small and easy to get wrong: all three backends
 * present under the names Profiles write, no Profiles of its own, the two host
 * facts answered by the one backend that can answer them, and one probe block
 * per backend rather than a merged total nobody could act on.
 */

test("the production set offers all three backends and no Profiles of its own", () => {
  const set = createProductionBackendSet().set;

  assert.equal(set.name, PRODUCTION_BACKEND_SET_NAME);
  assert.deepEqual(
    set.backends.map((backend) => backend.id),
    ["pi", "claude", "codex"],
  );
  // A Profile is the user's own specialist. Inventing one here would put a
  // specialist nobody wrote into every Session's `/agents` list.
  assert.deepEqual(set.profiles, []);
});

test("the host facts come from Pi, which is the only backend that has them", (t) => {
  const before = process.env[DEPTH_ENV_KEY];
  t.after(() => {
    if (before === undefined) delete process.env[DEPTH_ENV_KEY];
    else process.env[DEPTH_ENV_KEY] = before;
  });

  delete process.env[DEPTH_ENV_KEY];
  const set = createProductionBackendSet().set;
  assert.equal(set.isChildLoad(), false);
  assert.equal(set.childDepth(), 0);

  // The depth key is shared between the adapters, which is what makes a
  // Bash-launched grandchild read the same variable whichever backend spawned
  // its parent.
  process.env[DEPTH_ENV_KEY] = "1";
  assert.equal(createProductionBackendSet().set.childDepth(), 1);
});

test("the set reports one probe block per backend, each named for its backend", () => {
  const held = createProductionBackendSet();

  assert.deepEqual(Object.keys(held.probe()), ["pi", "claude", "codex"]);
  assert.ok(piProbeIsClear(held.probe().pi as never));
  assert.ok(claudeProbeIsClear(held.probe().claude as never));
  assert.ok(codexProbeIsClear(held.probe().codex as never));
});

/** A Profile naming a backend, parsed the way a Session would read one. */
function profileNaming(backend: string, extra = ""): Profile {
  const parsed = parseProfile(
    [
      "---",
      `description: A ${backend} worker`,
      `backend: ${backend}`,
      ...(extra === "" ? [] : [extra]),
      "---",
      "Do the work.",
      "",
    ].join("\n"),
    `/agents/${backend}-worker.md`,
  );
  if (parsed.outcome !== "profile") {
    throw new Error(`the fixture Profile did not parse: ${parsed.outcome}`);
  }
  return parsed.profile;
}

test("a Session built from the production set validates a Profile naming any of the three", async () => {
  const standIn = createStandInClaudeQuery({ scripts: [] });
  const appServer = createStandInAppServer();
  const set = createProductionBackendSet({
    claude: { loadQuery: async () => standIn.query },
    codex: { spawn: appServer.spawn },
  }).set;

  const diagnostics = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const catalog = yield* ProfileCatalog;
        return {
          loaded: catalog.diagnostics(),
          claudeAlias: set.backends
            .find((backend) => backend.id === backendId("claude"))
            ?.validateProfile(
              profileNaming("claude", "model: sonnet"),
              "/agents/claude-worker.md",
            ),
          claudeBadModel: set.backends
            .find((backend) => backend.id === backendId("claude"))
            ?.validateProfile(
              profileNaming("claude", "model: gpt-5"),
              "/agents/claude-worker.md",
            ),
          // Codex validates a model name itself, so any string passes here
          // and a field it has never heard of is a diagnostic.
          codexModel: set.backends
            .find((backend) => backend.id === backendId("codex"))
            ?.validateProfile(
              profileNaming("codex", "model: gpt-5.6-sol"),
              "/agents/codex-worker.md",
            ),
          codexUnknownField: set.backends
            .find((backend) => backend.id === backendId("codex"))
            ?.validateProfile(
              profileNaming("codex", "tools: read"),
              "/agents/codex-worker.md",
            ),
        };
      }).pipe(
        Effect.provide(
          sessionRuntimeLayer({
            backendSet: set,
            profiles: {
              from: "list",
              profiles: [
                profileNaming("pi"),
                profileNaming("claude"),
                profileNaming("codex"),
              ],
            },
            sink: createFakeNotificationSink(),
            counters: createRuntimeCounters(),
          }),
        ),
      ),
    ),
  );

  // All three Profiles loaded, so no backend name is unknown to the set.
  assert.deepEqual(diagnostics.loaded, []);
  assert.deepEqual(diagnostics.claudeAlias, []);
  assert.equal(diagnostics.claudeBadModel?.length, 1);
  assert.deepEqual(diagnostics.codexModel, []);
  assert.equal(diagnostics.codexUnknownField?.length, 1);
});

test("a Profile naming a backend the set does not hold is a diagnostic, not a crash", () => {
  const set = createProductionBackendSet().set;
  const catalog = createBackendCatalog(set.backends);

  // A name nothing in the set answers to is a mistake in a file, and the
  // answer is to say which file and which name.
  assert.deepEqual(
    catalog.validateProfile(
      profileNaming("gemini"),
      "/agents/gemini-worker.md",
    ),
    [
      {
        filePath: "/agents/gemini-worker.md",
        reason: "unknown backend 'gemini'",
      },
    ],
  );
  // Each of the set's own backends validates rather than being unknown.
  for (const backend of ["pi", "claude", "codex"]) {
    assert.deepEqual(
      catalog.validateProfile(
        profileNaming(backend),
        `/agents/${backend}-worker.md`,
      ),
      [],
      `a Profile naming ${backend} was not recognized`,
    );
  }
});

test("a Profile naming claude runs end to end through the production set", async () => {
  const standIn = createStandInClaudeQuery({
    scripts: [
      [
        { step: "init" },
        { step: "assistant", messageId: "msg_1", text: "the answer" },
        {
          step: "result",
          text: "the answer",
          numTurns: 1,
          models: { [STAND_IN_MODEL]: { input: 40, output: 10 } },
        },
      ],
    ],
  });
  const held = createProductionBackendSet({
    claude: { loadQuery: async () => standIn.query },
  });

  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* SubagentSupervisor;
        const started = yield* supervisor.start({
          agent: "claude-worker",
          description: "review it",
          prompt: "have a look",
          cwd: "/work",
          childDepth: 1,
          projectTrusted: true,
        });
        if (started.outcome !== "started") {
          return { outcome: started.outcome, output: "" };
        }
        const waited = yield* supervisor.wait([started.runId]);
        const read = yield* supervisor.result(started.runId);
        return {
          outcome: waited[0]?.outcome ?? "none",
          output: read.outcome === "result" ? read.result.finalOutput : "",
          status: read.outcome === "result" ? read.result.status : read.outcome,
        };
      }).pipe(
        Effect.provide(
          sessionRuntimeLayer({
            backendSet: held.set,
            profiles: { from: "list", profiles: [profileNaming("claude")] },
            sink: createFakeNotificationSink(),
            counters: createRuntimeCounters(),
          }),
        ),
      ),
    ),
  );

  assert.equal(outcome.outcome, "terminal");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.output, "the answer");
  // Both adapters are holding nothing once the Session Scope has closed.
  assert.ok(piProbeIsClear(held.probe().pi as never));
  assert.ok(claudeProbeIsClear(held.probe().claude as never));
});

test("a Profile naming codex runs end to end through the production set", async () => {
  const appServer = createStandInAppServer({
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
          {
            frame: "usage",
            total: { totalTokens: 50, inputTokens: 40, outputTokens: 10 },
            last: { totalTokens: 50 },
          },
          { frame: "completed" },
        ],
      },
    ],
  });
  const held = createProductionBackendSet({
    codex: { spawn: appServer.spawn },
  });

  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* SubagentSupervisor;
        const started = yield* supervisor.start({
          agent: "codex-worker",
          description: "build it",
          prompt: "do the thing",
          cwd: "/work",
          childDepth: 1,
          projectTrusted: true,
        });
        if (started.outcome !== "started") {
          return { outcome: started.outcome, output: "", status: "none" };
        }
        const waited = yield* supervisor.wait([started.runId]);
        const read = yield* supervisor.result(started.runId);
        return {
          outcome: waited[0]?.outcome ?? "none",
          output: read.outcome === "result" ? read.result.finalOutput : "",
          status: read.outcome === "result" ? read.result.status : read.outcome,
        };
      }).pipe(
        Effect.provide(
          sessionRuntimeLayer({
            backendSet: held.set,
            profiles: { from: "list", profiles: [profileNaming("codex")] },
            sink: createFakeNotificationSink(),
            counters: createRuntimeCounters(),
          }),
        ),
      ),
    ),
  );

  assert.equal(outcome.outcome, "terminal");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.output, "the answer");
  // The App Server was started, spoken to, and shut down with its stdin.
  assert.equal(appServer.record().spawns, 1);
  assert.equal(appServer.record().stdinEnded, true);
  assert.equal(appServer.alive(), false);
  // Every adapter is holding nothing once the Session Scope has closed.
  assert.ok(piProbeIsClear(held.probe().pi as never));
  assert.ok(claudeProbeIsClear(held.probe().claude as never));
  assert.ok(codexProbeIsClear(held.probe().codex as never));
});
