import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { createBackendCatalog } from "../backend/catalog.ts";
import { claudeProbeIsClear } from "../backend/claude/index.ts";
import { DEPTH_ENV_KEY, piProbeIsClear } from "../backend/pi/index.ts";
import { backendId, type Profile, parseProfile } from "../domain/index.ts";
import { sessionRuntimeLayer } from "../runtime/composition.ts";
import { createRuntimeCounters } from "../runtime/counters.ts";
import { ProfileCatalog } from "../runtime/profile-catalog.ts";
import { createStandInClaudeQuery } from "../testing/claude/stand-in-query.ts";
import { createFakeNotificationSink } from "../testing/fake-sink.ts";
import { createProductionBackendSet } from "./production-backends.ts";

/**
 * The set the extension actually ships.
 *
 * What it has to get right is small and easy to get wrong: both backends
 * present under the names Profiles write, the two host facts answered by the
 * one backend that can answer them, and one probe block
 * per backend rather than a merged total nobody could act on.
 */

test("the production set offers both backends", () => {
  const set = createProductionBackendSet().set;

  assert.deepEqual(
    set.backends.map((backend) => backend.id),
    ["pi", "claude"],
  );
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

  assert.deepEqual(Object.keys(held.probe()), ["pi", "claude"]);
  assert.ok(piProbeIsClear(held.probe().pi as never));
  assert.ok(claudeProbeIsClear(held.probe().claude as never));
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

test("a Session built from the production set validates a Profile naming either backend", async () => {
  const standIn = createStandInClaudeQuery({ scripts: [] });
  const set = createProductionBackendSet({
    claude: { loadQuery: async () => standIn.query },
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
        };
      }).pipe(
        Effect.provide(
          sessionRuntimeLayer({
            backendSet: set,
            profiles: {
              from: "list",
              profiles: [profileNaming("pi"), profileNaming("claude")],
            },
            sink: createFakeNotificationSink(),
            counters: createRuntimeCounters(),
          }),
        ),
      ),
    ),
  );

  // Both Profiles loaded, so no backend name is unknown to the set.
  assert.deepEqual(diagnostics.loaded, []);
  assert.deepEqual(diagnostics.claudeAlias, []);
  assert.equal(diagnostics.claudeBadModel?.length, 1);
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
  // `codex` was a backend once; the set no longer holds it, so a Profile that
  // still names it reads as the same mistake in a file as any other unknown
  // name rather than reaching an adapter that is no longer there.
  assert.deepEqual(
    catalog.validateProfile(profileNaming("codex"), "/agents/codex-worker.md"),
    [
      {
        filePath: "/agents/codex-worker.md",
        reason: "unknown backend 'codex'",
      },
    ],
  );
  // Each of the set's own backends validates rather than being unknown.
  for (const backend of ["pi", "claude"]) {
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
