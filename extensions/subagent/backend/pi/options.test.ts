import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_BACKEND_ID,
  type Profile,
  type SubagentContext,
  subagentId,
} from "../../domain/index.ts";
import { isChildResourceLoad } from "./child-load.ts";
import { DEPTH_ENV_KEY, readChildDepth } from "./depth.ts";
import {
  createPiSessionOptions,
  depthSpawnHook,
  filterChildExtensions,
  PI_ORCHESTRATION_TOOLS,
  packageNameForPath,
  unknownModelMessage,
} from "./options.ts";
import { validatePiProfile } from "./profile.ts";

/**
 * The fixed native policy one retained session is built with.
 *
 * These are v1's decisions, and each of them was arrived at by running
 * children for real: forwarded trust, this package filtered out of the child's
 * extensions, the delegation tools excluded, and a Bash spawn that carries the
 * depth without mutating the parent's own environment.
 *
 * The options are built against a temporary agent directory, so nothing here
 * reads the machine's own credentials or reaches a provider.
 */

function subagent(overrides: Partial<SubagentContext> = {}): SubagentContext {
  return {
    subagentId: subagentId("subagent-1"),
    cwd: process.cwd(),
    childDepth: 1,
    projectTrusted: true,
    ...overrides,
  };
}

function profile(
  fields: Record<string, unknown> = {},
  systemPrompt = "Explore.",
): Profile {
  return {
    name: "explore",
    description: "The explore specialist",
    backend: DEFAULT_BACKEND_ID,
    fields,
    systemPrompt,
  };
}

/** An agent directory with no credentials and no models in it. */
function emptyAgentDir(t: { after(fn: () => void): void }): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agentdir-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "auth.json"), "{}");
  fs.writeFileSync(path.join(root, "models.json"), "{}");
  return root;
}

test("the options carry the Session's trust posture and the excluded tools", async (t) => {
  const options = await createPiSessionOptions({
    profile: profile(),
    subagent: subagent({ projectTrusted: false }),
    agentDir: emptyAgentDir(t),
  });

  assert.deepEqual(options.excludeTools, [...PI_ORCHESTRATION_TOOLS]);
  assert.equal(options.cwd, process.cwd());
  // Trust is forwarded rather than re-derived: a child runs
  // non-interactively and can neither prompt for it nor see a session-only
  // decision.
  assert.equal(options.settingsManager?.isProjectTrusted(), false);
});

test("off leaves Pi's thinking level unset and native levels pass through", async (t) => {
  const agentDir = emptyAgentDir(t);

  const off = await createPiSessionOptions({
    profile: profile(),
    subagent: subagent(),
    thinking: "off",
    agentDir,
  });
  assert.equal("thinkingLevel" in off, false);

  for (const thinking of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    const options = await createPiSessionOptions({
      profile: profile(),
      subagent: subagent(),
      thinking,
      agentDir,
    });
    assert.equal(options.thinkingLevel, thinking, thinking);
  }
});

test("an effort outside Pi's six native levels is refused with an effort diagnostic", () => {
  const diagnostics = validatePiProfile(
    profile({ effort: "ultra" }),
    "/agents/explore.md",
  );

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.filePath, "/agents/explore.md");
  assert.match(diagnostics[0]?.reason ?? "", /unknown effort 'ultra'/);
});

test("a Profile's tools list reaches the session, and no list leaves the defaults", async (t) => {
  const agentDir = emptyAgentDir(t);

  assert.deepEqual(
    (
      await createPiSessionOptions({
        profile: profile({ tools: "read_file, bash" }),
        subagent: subagent(),
        agentDir,
      })
    ).tools,
    ["read_file", "bash"],
  );
  // No `tools` field at all leaves the session's own defaults alone.
  assert.equal(
    (
      await createPiSessionOptions({
        profile: profile(),
        subagent: subagent(),
        agentDir,
      })
    ).tools,
    undefined,
  );
});

test("a pinned model the agent directory cannot resolve fails the build", async (t) => {
  await assert.rejects(
    createPiSessionOptions({
      profile: profile(),
      subagent: subagent(),
      model: "openai-codex/gpt-9-imaginary",
      agentDir: emptyAgentDir(t),
    }),
    (error: Error) =>
      error.message === unknownModelMessage("openai-codex/gpt-9-imaginary"),
  );
});

test("the Bash spawn carries the child depth without mutating the environment", () => {
  const before = process.env[DEPTH_ENV_KEY];

  const hook = depthSpawnHook(3);

  assert.deepEqual(hook({ env: { PATH: "/usr/bin" } }), {
    env: { PATH: "/usr/bin", [DEPTH_ENV_KEY]: "3" },
  });
  // The parent is a long-lived process; a mutated environment would outlive
  // the Run that wanted it and follow every later spawn out.
  assert.equal(process.env[DEPTH_ENV_KEY], before);
});

test("the session is given a Bash tool of its own, in place of the default", async (t) => {
  const options = await createPiSessionOptions({
    profile: profile(),
    subagent: subagent({ childDepth: 2 }),
    agentDir: emptyAgentDir(t),
  });

  const custom = options.customTools as unknown as readonly {
    readonly name?: string;
  }[];
  assert.equal(custom.length, 1);
  assert.equal(custom[0]?.name, "bash");
});

test("the resource load runs inside the child-load discriminator", async (t) => {
  // Outside the load, the discriminator is false — which is what lets a
  // parent's own reload reattach this extension normally.
  assert.equal(isChildResourceLoad(), false);

  await createPiSessionOptions({
    profile: profile(),
    subagent: subagent(),
    agentDir: emptyAgentDir(t),
  });

  assert.equal(isChildResourceLoad(), false);
});

// ── Filtering this package out of a child's extensions ───────────────────────

/**
 * A package tree with an extension directory in it, like this one.
 *
 * Two directories are written rather than one, deliberately: the filter works
 * by *package identity* rather than by path, so a package that grew a second
 * extension directory must have both filtered — and a fixture with one could
 * not tell path matching from identity matching apart.
 */
function fixturePackage(
  t: { after(fn: () => void): void },
  name: string,
): { readonly root: string; readonly resolve: (relative: string) => string } {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagent-package-${name}-`)),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  for (const directory of ["extensions/subagent", "extensions/other"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, "index.ts"), "export {};\n");
  }
  return { root, resolve: (relative) => path.join(root, relative) };
}

test("every extension directory of this package is filtered from a child", (t) => {
  const own = fixturePackage(t, "pi-subagent");
  const other = fixturePackage(t, "somebody-elses-extension");

  const filtered = filterChildExtensions(
    {
      extensions: [
        { resolvedPath: own.resolve("extensions/subagent/index.ts") },
        { resolvedPath: own.resolve("extensions/other/index.ts") },
        { resolvedPath: other.resolve("extensions/subagent/index.ts") },
      ],
    } as never,
    "pi-subagent",
  );

  // By package identity, which is what covers every directory at once — and
  // what keeps covering them through a rename.
  assert.deepEqual(
    filtered.extensions.map((extension) => extension.resolvedPath),
    [other.resolve("extensions/subagent/index.ts")],
  );
});

test("a package identity is read from the nearest manifest above a file", (t) => {
  const own = fixturePackage(t, "pi-subagent");

  assert.equal(
    packageNameForPath(own.resolve("extensions/subagent/index.ts")),
    "pi-subagent",
  );
  // A path that no longer exists still resolves through its parent, because a
  // loader entry may name a file that disappeared after it was loaded.
  assert.equal(
    packageNameForPath(own.resolve("extensions/subagent/gone.ts")),
    "pi-subagent",
  );
});

test("everything the loader kept is left exactly as it was", (t) => {
  const other = fixturePackage(t, "somebody-elses-extension");
  const base = {
    extensions: [
      { resolvedPath: other.resolve("extensions/subagent/index.ts") },
    ],
    diagnostics: ["something the loader said"],
  } as never;

  const filtered = filterChildExtensions(base, "pi-subagent");

  assert.deepEqual(
    (filtered as unknown as { diagnostics: string[] }).diagnostics,
    ["something the loader said"],
  );
});

// ── The depth environment ────────────────────────────────────────────────────

test("a process with no depth variable is a parent", () => {
  assert.equal(readChildDepth({}), 0);
});

test("a garbled depth reads as a parent rather than as a nesting", () => {
  assert.equal(readChildDepth({ [DEPTH_ENV_KEY]: "not a number" }), 0);
  assert.equal(readChildDepth({ [DEPTH_ENV_KEY]: "-3" }), 0);
});

test("a depth a parent set is read back", () => {
  assert.equal(readChildDepth({ [DEPTH_ENV_KEY]: "1" }), 1);
  assert.equal(readChildDepth({ [DEPTH_ENV_KEY]: "2" }), 2);
});
