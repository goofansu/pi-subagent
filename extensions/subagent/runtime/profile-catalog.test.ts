import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import type { Profile } from "../domain/index.ts";
import { createFakeNotificationSink } from "../testing/fake-sink.ts";
import {
  createFakeOneShotBackend,
  createFakeResumableBackend,
} from "../testing/fakes/backend.ts";
import { scripts } from "../testing/fakes/script.ts";
import { BackendCatalog } from "./backend-catalog.ts";
import { sessionRuntimeLayer } from "./composition.ts";
import { ProfileCatalog } from "./profile-catalog.ts";
import { SubagentSupervisor } from "./supervisor.ts";

function directories(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "user");
  const user = path.join(agentDir, "agents");
  const bundled = path.join(root, "bundled");
  fs.mkdirSync(user, { recursive: true });
  fs.mkdirSync(bundled);
  return { agentDir, user, bundled };
}

const document = (
  backend: string,
  description: string,
  fields = "",
  body = "Do the work.",
) =>
  `---\ndescription: ${description}\nbackend: ${backend}\n${fields}---\n${body}\n`;

test("bundled and user files share validation and whole-Profile precedence", async (t) => {
  const { agentDir, user, bundled } = directories(t);
  const backend = createFakeResumableBackend({
    scripts: scripts([]),
    diagnose: (profile, filePath) =>
      profile.fields.bad ? [{ filePath, reason: "unsupported bad field" }] : [],
  });
  const replacementBackend = createFakeOneShotBackend({ scripts: scripts([]) });
  const id = backend.backend.id;
  fs.writeFileSync(path.join(bundled, "default.md"), document(id, "Default"));
  fs.writeFileSync(
    path.join(bundled, "replace.md"),
    document(id, "Old", "tools: read\neffort: high\n", "Old instructions."),
  );
  fs.writeFileSync(
    path.join(user, "replace.md"),
    document(
      replacementBackend.backend.id,
      "Replacement",
      "",
      "New instructions.",
    ),
  );
  fs.writeFileSync(path.join(user, "custom.md"), document(id, "Custom"));
  fs.writeFileSync(
    path.join(bundled, "invalid.md"),
    document(id, "Invalid", "bad: true\n"),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const catalog = yield* ProfileCatalog;
      assert.deepEqual(
        catalog
          .list()
          .map((p) => p.name)
          .sort(),
        ["custom", "default", "replace"],
      );
      assert.deepEqual(
        {
          ...catalog.get("replace"),
          fields: { ...catalog.get("replace")?.fields },
        },
        {
          name: "replace",
          backend: replacementBackend.backend.id,
          description: "Replacement",
          fields: {},
          systemPrompt: "New instructions.",
        },
      );
      for (const profile of catalog.list())
        assert.equal(catalog.get(profile.name), profile);
      assert.equal(catalog.get("invalid"), undefined);
      assert.deepEqual(catalog.diagnostics(), [
        {
          filePath: path.join(bundled, "invalid.md"),
          reason: "unsupported bad field",
        },
      ]);
      assert.deepEqual(
        catalog.diagnosticsFor("invalid"),
        catalog.diagnostics(),
      );
      fs.writeFileSync(path.join(user, "replace.md"), "broken");
      assert.equal(
        catalog.get("replace")?.description,
        "Replacement",
        "discovery is fixed for this Session",
      );
    }).pipe(
      Effect.provide(
        ProfileCatalog.layerOf(agentDir, [], undefined, bundled).pipe(
          Layer.provide(
            BackendCatalog.layerOf([
              backend.backend,
              replacementBackend.backend,
            ]),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
});

test("invalid user files suppress bundled defaults with actionable diagnostics", async (t) => {
  const { agentDir, user, bundled } = directories(t);
  const backend = createFakeResumableBackend({
    scripts: scripts([]),
    diagnose: (profile, filePath) =>
      profile.fields.bad ? [{ filePath, reason: "unsupported bad field" }] : [],
  });
  const cases = {
    malformed: "---\n---\n",
    rejected: document(backend.backend.id, "Invalid", "bad: true\n"),
    unknown: document("missing-backend", "Invalid"),
  };
  for (const [name, contents] of Object.entries(cases)) {
    fs.writeFileSync(
      path.join(bundled, `${name}.md`),
      document(backend.backend.id, "Default"),
    );
    fs.writeFileSync(path.join(user, `${name}.md`), contents);
  }
  fs.writeFileSync(
    path.join(bundled, "unreadable.md"),
    document(backend.backend.id, "Default"),
  );
  fs.symlinkSync(path.join(user, "absent"), path.join(user, "unreadable.md"));
  fs.writeFileSync(path.join(bundled, "malformed-bundle.md"), "---\n---\n");
  await Effect.runPromise(
    Effect.gen(function* () {
      const catalog = yield* ProfileCatalog;
      assert.deepEqual(catalog.list(), []);
      for (const name of [...Object.keys(cases), "unreadable"]) {
        assert.equal(catalog.get(name), undefined);
        assert.ok(catalog.diagnosticsFor(name).length > 0);
        assert.ok(
          catalog
            .diagnosticsFor(name)
            .every(
              (d) =>
                d.filePath === path.join(user, `${name}.md`) &&
                d.reason.length > 0,
            ),
        );
      }
      assert.match(
        catalog.diagnosticsFor("unreadable")[0].reason,
        /cannot be read.*ENOENT/,
      );
      assert.match(
        catalog.diagnosticsFor("unknown")[0].reason,
        /unknown backend/,
      );
      assert.equal(
        catalog.diagnosticsFor("malformed-bundle")[0].filePath,
        path.join(bundled, "malformed-bundle.md"),
      );
    }).pipe(
      Effect.provide(
        ProfileCatalog.layerOf(agentDir, [], undefined, bundled).pipe(
          Layer.provide(BackendCatalog.layerOf([backend.backend])),
        ),
      ),
      Effect.scoped,
    ),
  );
});

test("an invalid user replacement disables a built-in name at lookup and admission", async (t) => {
  const { agentDir, user } = directories(t);
  const filePath = path.join(user, "explore.md");
  fs.writeFileSync(filePath, "---\nbackend: pi\n---\n");
  const backend = createFakeResumableBackend({ scripts: scripts([]) });
  const profile: Profile = {
    name: "explore",
    description: "Bundled explorer",
    backend: backend.backend.id,
    fields: {},
    systemPrompt: "Explore.",
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const catalog = yield* ProfileCatalog;
      assert.equal(catalog.get("explore"), undefined);
      assert.deepEqual(catalog.list(), []);
      assert.ok(catalog.diagnosticsFor("explore").length > 0);
      assert.ok(
        catalog.diagnosticsFor("explore").every((d) => d.filePath === filePath),
      );
      const supervisor = yield* SubagentSupervisor;
      const started = yield* supervisor.start({
        agent: "explore",
        description: "inspect",
        prompt: "inspect",
        cwd: user,
        childDepth: 1,
        projectTrusted: true,
      });
      assert.equal(started.outcome, "invalid profile");
    }).pipe(
      Effect.provide(
        sessionRuntimeLayer({
          backendSet: {
            backends: [backend.backend],
            profiles: [profile],
            isChildLoad: () => false,
            childDepth: () => 0,
          },
          profiles: { from: "directory", agentDir },
          sink: createFakeNotificationSink(),
        }),
      ),
      Effect.scoped,
    ),
  );
});
