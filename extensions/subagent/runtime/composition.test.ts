import assert from "node:assert/strict";
import { test } from "node:test";
import { type Context, Effect } from "effect";
import { DEFAULT_BACKEND_ID, type Profile } from "../domain/index.ts";
import { createFakeNotificationSink } from "../testing/fake-sink.ts";
import { createFakeResumableBackend } from "../testing/fakes/backend.ts";
import { scripts } from "../testing/fakes/script.ts";
import { BackendCatalog } from "./backend-catalog.ts";
import { sessionRuntimeLayer } from "./composition.ts";
import { CompletionDelivery } from "./delivery.ts";
import { ProfileCatalog } from "./profile-catalog.ts";
import { RunRepository } from "./repository.ts";
import { ResultStore } from "./result-store.ts";
import { SubagentSupervisor } from "./supervisor.ts";

/**
 * What the Session runtime is made of.
 *
 * ADR-0023's rule — no Layer per Subagent, BackendAgent, or Run — is enforced
 * two ways, and both are here. The boundary test stops a module that owns one
 * of those from importing `Layer` at all; this counts what the composition
 * actually provides, so a Layer added for something shorter-lived than the
 * Session shows up as a service nobody named.
 */

const profile: Profile = {
  name: "explore",
  description: "The explore specialist",
  backend: DEFAULT_BACKEND_ID,
  fields: {},
  systemPrompt: "Explore.",
};

/** The six session-long services the roadmap names, and no seventh. */
const SESSION_SERVICES = [
  BackendCatalog,
  ProfileCatalog,
  RunRepository,
  ResultStore,
  CompletionDelivery,
  SubagentSupervisor,
] as const;

function layerFor(): ReturnType<typeof sessionRuntimeLayer> {
  const backend = createFakeResumableBackend({ scripts: scripts([]) });
  return sessionRuntimeLayer({
    backends: [backend.backend],
    sink: createFakeNotificationSink(),
    profiles: {
      from: "list",
      profiles: [{ ...profile, backend: backend.backend.id }],
    },
  });
}

test("the Session runtime provides exactly the services it names and no more", async () => {
  const provided = await Effect.runPromise(
    Effect.gen(function* () {
      const context: Context.Context<never> = yield* Effect.context<never>();
      // The keys the runtime actually provided, which is the only way to see
      // a Layer nobody named.
      return [...context.mapUnsafe.keys()];
    }).pipe(Effect.provide(layerFor()), Effect.scoped),
  );

  const named = SESSION_SERVICES.map((service) => service.key);
  // Every named service is provided.
  for (const key of named) {
    assert.ok(provided.includes(key), `${key} is not provided`);
  }
  // And nothing of this project's is provided that was not named — a Layer for
  // a Subagent, a BackendAgent, or a Run would show up right here.
  const ours = provided.filter((key) => key.startsWith("pi-subagent/"));
  assert.deepEqual(ours.sort(), [...named].sort());
});

test("every service key says which module it lives in", async () => {
  for (const service of SESSION_SERVICES) {
    assert.match(service.key, /^pi-subagent\/runtime\/[A-Z][A-Za-z]+$/);
  }
});

test("the Profile catalog validates through the backend catalog it is given", async () => {
  const rejecting = createFakeResumableBackend({
    scripts: scripts([]),
    diagnose: (subject, filePath) => [
      { filePath, reason: `the backend refused '${subject.name}'` },
    ],
  });

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const profiles = yield* ProfileCatalog;
      return {
        usable: profiles.list().length,
        diagnostics: profiles.diagnostics().map((entry) => entry.reason),
        forName: profiles.diagnosticsFor("explore").length,
      };
    }).pipe(
      Effect.provide(
        sessionRuntimeLayer({
          backends: [rejecting.backend],
          sink: createFakeNotificationSink(),
          profiles: {
            from: "list",
            profiles: [{ ...profile, backend: rejecting.backend.id }],
            // A list-built catalog is given its diagnostics rather than
            // deriving them, because the rig knows what it wanted to prove.
            diagnostics: [
              {
                filePath: "/agents/explore.md",
                reason: "the backend refused 'explore'",
              },
            ],
          },
        }),
      ),
      Effect.scoped,
    ),
  );

  assert.equal(outcome.usable, 1);
  assert.deepEqual(outcome.diagnostics, ["the backend refused 'explore'"]);
  assert.equal(outcome.forName, 1);
});

test("a Profile naming a backend this Session does not have is a diagnostic, not a throw", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const supervisor = yield* SubagentSupervisor;
      const backends = yield* BackendCatalog;
      return {
        ids: backends.ids,
        started: yield* supervisor.start({
          agent: "explore",
          description: "d",
          prompt: "p",
          cwd: "/work",
          childDepth: 1,
          projectTrusted: true,
        }),
      };
    }).pipe(
      Effect.provide(
        sessionRuntimeLayer({
          backends: [],
          sink: createFakeNotificationSink(),
          profiles: { from: "list", profiles: [profile] },
        }),
      ),
      Effect.scoped,
    ),
  );

  assert.deepEqual(outcome.ids, []);
  assert.equal(outcome.started.outcome, "invalid profile");
});
