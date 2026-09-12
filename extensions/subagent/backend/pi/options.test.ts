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
  PI_ORCHESTRATION_TOOLS,
  unknownModelMessage,
} from "./options.ts";
import { validatePiProfile } from "./profile.ts";

/**
 * The fixed native policy one retained session is built with.
 *
 * This keeps v1's forwarded trust, delegation-tool exclusion, and Bash depth
 * propagation. Disabling extensions is the newer policy that makes the Profile
 * authoritative.
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

test("extensions are neither initialized nor bound in a Pi child", async (t) => {
  const agentDir = emptyAgentDir(t);
  const extensionsDir = path.join(agentDir, "extensions");
  const initializedMarker = path.join(agentDir, "extension-initialized.txt");
  fs.mkdirSync(extensionsDir);
  fs.writeFileSync(
    path.join(extensionsDir, "fixture-extension.ts"),
    `import fs from "node:fs";
export default function fixtureExtension() {
  fs.writeFileSync(${JSON.stringify(initializedMarker)}, "initialized");
}
`,
  );

  const options = await createPiSessionOptions({
    profile: profile(),
    subagent: subagent(),
    agentDir,
  });

  assert.equal(fs.existsSync(initializedMarker), false);
  assert.deepEqual(options.resourceLoader?.getExtensions().extensions, []);
});

test("a built-in Radius model remains available with extensions disabled", async (t) => {
  const agentDir = emptyAgentDir(t);
  const radiusModel = {
    id: "fixture-model",
    name: "Fixture Radius Model",
    api: "pi-messages",
    provider: "radius",
    baseUrl: "https://radius.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
  fs.writeFileSync(
    path.join(agentDir, "models-store.json"),
    JSON.stringify({
      radius: { models: [radiusModel], checkedAt: 0 },
    }),
  );

  const options = await createPiSessionOptions({
    profile: profile(),
    subagent: subagent(),
    model: "radius/fixture-model",
    agentDir,
  });

  assert.equal(options.model?.provider, "radius");
  assert.equal(options.model?.id, "fixture-model");
  assert.deepEqual(
    options.modelRuntime?.getModel("radius", "fixture-model"),
    options.model,
  );
  assert.deepEqual(options.resourceLoader?.getExtensions().extensions, []);
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
  const observed: boolean[] = [];
  const context = subagent();
  Object.defineProperty(context, "projectTrusted", {
    get() {
      observed.push(isChildResourceLoad());
      return true;
    },
  });

  // Settings construction reads trust outside the scope; resource loading
  // resolves it again inside. Afterwards the parent's load context is clear.
  await createPiSessionOptions({
    profile: profile(),
    subagent: context,
    agentDir: emptyAgentDir(t),
  });

  assert.deepEqual(observed, [false, true]);
  assert.equal(isChildResourceLoad(), false);
});

// ── The depth environment ────────────────────────────────────────────────────

test("a process with no depth variable is a parent", () => {
  assert.equal(readChildDepth({}), 0);
});

test("a depth is a whole string of decimal digits or zero", () => {
  const cases = [
    ["", 0],
    ["0", 0],
    ["3", 3],
    ["03", 3],
    ["3abc", 0],
    ["-1", 0],
    ["1.5", 0],
    ["abc", 0],
    [" 3", 0],
  ] as const;

  for (const [value, expected] of cases) {
    assert.equal(readChildDepth({ [DEPTH_ENV_KEY]: value }), expected, value);
  }
});
