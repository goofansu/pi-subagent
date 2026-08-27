import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getAgentsDir,
  loadAgentConfigs,
  loadAgentConfigsWithDiagnostics,
  parseAgentConfig,
} from "./agents.ts";
import { createHarnessRegistry, type Harness } from "./harnesses/contract.ts";
import { createPiHarness } from "./harnesses/pi/harness.ts";
import { EFFORTS } from "./types.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

test("parseAgentConfig reads name, frontmatter, and system prompt", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\nmodel: custom\ntools: read,grep,find,ls,bash\nappendSystemPrompt: true\n---\n\nYou review code.\n",
  );

  assert.deepEqual(parseAgentConfig(filePath), {
    name: "reviewer",
    description: "Reviews code",
    harness: "pi",
    fields: {
      model: "custom",
      tools: "read,grep,find,ls,bash",
      appendSystemPrompt: true,
    },
    systemPrompt: "You review code.",
  });
});

test("parseAgentConfig leaves an unset appendSystemPrompt absent", async () => {
  // The default belongs to resolveAppendSystemPrompt, so the parsed profile
  // records what the file says and nothing more.
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\n---\n\nYou review code.\n",
  );

  const config = parseAgentConfig(filePath);
  assert.equal(config.fields?.appendSystemPrompt, undefined);
  assert.equal(Object.hasOwn(config.fields ?? {}, "appendSystemPrompt"), false);
});

test("parseAgentConfig preserves explicit appendSystemPrompt false", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "reviewer.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Reviews code\nappendSystemPrompt: false\n---\n\nYou review code.\n",
  );

  assert.equal(parseAgentConfig(filePath).fields?.appendSystemPrompt, false);
});

test("loadAgentConfigs returns markdown agents keyed by name", async () => {
  const dir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(dir, "one.md"),
    "---\ndescription: First\n---\n\nOne prompt\n",
  );
  await fs.promises.writeFile(path.join(dir, "ignored.txt"), "not an agent");
  await fs.promises.writeFile(
    path.join(dir, "two.md"),
    "---\ndescription: Second\n---\n\nTwo prompt\n",
  );

  const configs = loadAgentConfigs(dir);

  assert.equal(configs.size, 2);
  assert.equal(configs.get("one")?.description, "First");
  assert.equal(configs.get("one")?.systemPrompt, "One prompt");
  assert.equal(configs.get("two")?.description, "Second");
  assert.equal(configs.get("two")?.systemPrompt, "Two prompt");
});

test("parseAgentConfig rejects agents without required description", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "missing-description.md");
  await fs.promises.writeFile(filePath, "Prompt only\n");

  assert.throws(
    () => parseAgentConfig(filePath),
    /missing required description/,
  );
});

test("parseAgentConfig rejects agents without required prompt body", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "missing-prompt.md");
  await fs.promises.writeFile(
    filePath,
    "---\ndescription: Missing prompt\n---\n\n   \n",
  );

  assert.throws(() => parseAgentConfig(filePath), /missing required prompt/);
});

test("loadAgentConfigs skips invalid agent files", async () => {
  const dir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(dir, "valid.md"),
    "---\ndescription: Valid\n---\n\nValid prompt\n",
  );
  await fs.promises.writeFile(path.join(dir, "invalid.md"), "Invalid prompt\n");

  const configs = loadAgentConfigs(dir);

  assert.equal(configs.size, 1);
  assert.equal(configs.has("valid"), true);
  assert.equal(configs.has("invalid"), false);
});

test("loadAgentConfigsWithDiagnostics reports invalid agent files", async () => {
  const dir = await makeTempDir();
  await fs.promises.writeFile(
    path.join(dir, "valid.md"),
    "---\ndescription: Valid\n---\n\nValid prompt\n",
  );
  await fs.promises.writeFile(path.join(dir, "no-description.md"), "Prompt\n");
  await fs.promises.writeFile(
    path.join(dir, "no-prompt.md"),
    "---\ndescription: No prompt\n---\n\n",
  );

  const result = loadAgentConfigsWithDiagnostics(dir);

  assert.equal(result.configs.size, 1);
  assert.deepEqual(
    result.invalidFiles.map((invalid) => ({
      file: path.basename(invalid.filePath),
      reason: invalid.reason,
    })),
    [
      {
        file: "no-description.md",
        reason: "missing required description frontmatter",
      },
      { file: "no-prompt.md", reason: "missing required prompt body" },
    ],
  );
});

test("the pi harness rejects a pinned model when its catalogue is empty", () => {
  const registry = createHarnessRegistry([createPiHarness()]);
  const diagnostics = registry.validate(
    {
      name: "pinned",
      description: "Pinned",
      harness: "pi",
      fields: { model: "acme/model" },
      systemPrompt: "Work.",
    },
    "/agents/pinned.md",
    { models: [] },
  );

  assert.match(
    diagnostics[0]?.reason ?? "",
    /not found in Pi's model catalogue/,
  );
});

test("the pi harness diagnoses models against its catalogue", () => {
  const registry = createHarnessRegistry([createPiHarness()]);
  const known = {
    name: "known",
    description: "Known",
    harness: "pi",
    fields: { model: "OpenAI/GPT-5" },
    systemPrompt: "Work.",
  };
  const missing = {
    ...known,
    name: "missing",
    fields: { model: "OpenAI/missing" },
  };
  const catalogue = [{ provider: "OpenAI", id: "GPT-5" }];
  assert.deepEqual(
    registry.validate(known, "/agents/known.md", { models: catalogue }),
    [],
  );
  const prepared = createPiHarness().prepare({
    config: known,
    description: "task",
    prompt: "work",
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  assert.equal(
    prepared.model,
    "OpenAI/GPT-5",
    "the model passed at execute time uses the exact spelling validation accepted",
  );
  const missingDiagnostics = registry.validate(missing, "/agents/missing.md", {
    models: catalogue,
  });
  assert.match(
    missingDiagnostics[0]?.reason ?? "",
    /not found in Pi's model catalogue/,
  );
  assert.match(
    missingDiagnostics[0]?.reason ?? "",
    /catalogue models include: OpenAI\/GPT-5/,
  );
  assert.match(
    registry.validate(
      { ...known, fields: { model: "openAI/GPT-5" } },
      "/agents/wrong-case.md",
      { models: catalogue },
    )[0]?.reason ?? "",
    /not found in Pi's model catalogue/,
  );
});

test("the pi catalogue diagnostic stays bounded", () => {
  const catalogue = Array.from({ length: 100 }, (_, index) => ({
    provider: "anthropic",
    id: `claude-sonnet-4-${index}-20250514`,
  }));
  const reason = createHarnessRegistry([createPiHarness()]).validate(
    {
      name: "missing",
      description: "Missing",
      harness: "pi",
      fields: { model: "provider/unknown" },
      systemPrompt: "Work.",
    },
    "/agents/missing.md",
    { models: catalogue },
  )[0]?.reason;

  assert.ok(reason);
  assert.ok(reason.length < 700);
  assert.match(reason, /100 catalogue models total\)\)$/);
});

test("loadAgentConfigs returns an empty map when directory is missing", () => {
  const configs = loadAgentConfigs(
    path.join(os.tmpdir(), "missing-pi-subagent-agents"),
  );

  assert.equal(configs.size, 0);
});

test("formatAgentGuidelines renders available agents as tool-specific guidelines", () => {
  const configs = new Map([
    [
      "explore",
      {
        name: "explore",
        description: "Fast codebase exploration.",
        systemPrompt: "Explore.",
      },
    ],
    [
      "custom",
      {
        name: "custom",
        description: "Runs a custom check.",
        systemPrompt: "Custom.",
      },
    ],
  ]);

  assert.deepEqual(formatAgentGuidelines(configs), [
    "agent_start explore: Fast codebase exploration.",
    "agent_start custom: Runs a custom check.",
  ]);
});

test("formatAgentGuidelines handles no configured agents", () => {
  assert.deepEqual(formatAgentGuidelines(new Map()), [
    "agent_start has no configured agents.",
  ]);
});

test("formatInvalidAgentFilesWarning renders uniform agent-name diagnostics", () => {
  assert.equal(
    formatInvalidAgentFilesWarning([
      {
        filePath: path.join("agents", "missing-description.md"),
        reason: "missing required description frontmatter",
      },
      {
        filePath: path.join("agents", "missing-prompt.md"),
        reason: "missing required prompt body",
      },
      {
        filePath: path.join("agents", "review.strict.md"),
        reason: "model 'missing' was not found",
      },
    ]),
    [
      "Invalid subagents were skipped:",
      "- missing-description: missing required description frontmatter",
      "- missing-prompt: missing required prompt body",
      "- review.strict: model 'missing' was not found",
    ].join("\n"),
  );
});

test("getAgentsDir reads agents from user scope only", () => {
  // No project directory is involved at all: a repository cannot contribute a
  // system prompt, a model, a tool list, or a description that reaches the
  // calling model's tool guidelines.
  assert.equal(getAgentsDir("/tmp/user-agent"), "/tmp/user-agent/agents");
});

async function writeAgentWithFrontmatter(
  dir: string,
  frontmatter: string,
): Promise<string> {
  const filePath = path.join(dir, "worker.md");
  await fs.promises.writeFile(
    filePath,
    `---\ndescription: Does work\n${frontmatter}\n---\n\nWork.\n`,
  );
  return filePath;
}

test("profile loading asks the fake harness to reject its own unknown fields", async () => {
  const dir = await makeTempDir();
  await writeAgentWithFrontmatter(dir, "harness: fake\nfakeOnly: true");
  const fake: Harness = {
    name: "fake",
    validate(profile) {
      return Object.keys(profile.fields ?? {})
        .filter((field) => field !== "fakeOnly")
        .map((field) => ({ reason: `fake does not recognize '${field}'` }));
    },
    prepare() {
      throw new Error("not needed for profile validation");
    },
  };
  // The fake owns the field policy; profile loading merely routes the parsed
  // opaque fields through the selected public harness contract.
  const result = loadAgentConfigsWithDiagnostics(
    dir,
    createHarnessRegistry([fake]),
  );
  assert.equal(result.configs.size, 1);
  assert.equal(result.invalidFiles.length, 0);

  const badPath = await writeAgentWithFrontmatter(
    dir,
    "harness: fake\nunsupported: true",
  );
  // Use a second filename because the helper intentionally writes worker.md.
  const renamed = path.join(dir, "bad.md");
  await fs.promises.rename(badPath, renamed);
  const bad = loadAgentConfigsWithDiagnostics(
    dir,
    createHarnessRegistry([
      {
        ...fake,
        validate(profile) {
          return Object.keys(profile.fields ?? {}).map((field) => ({
            reason: `fake does not recognize '${field}'`,
          }));
        },
      },
    ]),
  );
  assert.match(
    bad.invalidFiles.find((item) => item.filePath === renamed)?.reason ?? "",
    /unsupported/,
  );
});

test("unknown harnesses and fields become profile diagnostics", async () => {
  const dir = await makeTempDir();
  const unknownPath = await writeAgentWithFrontmatter(dir, "harness: codex");
  const unknown = parseAgentConfig(unknownPath);
  assert.match(
    createHarnessRegistry([createPiHarness()]).validate(unknown, unknownPath)[0]
      ?.reason ?? "",
    /unknown harness 'codex'/,
  );
  const fieldPath = await writeAgentWithFrontmatter(dir, "unsupported: true");
  const field = parseAgentConfig(fieldPath);
  assert.match(
    createHarnessRegistry([createPiHarness()]).validate(field, fieldPath)[0]
      ?.reason ?? "",
    /does not recognize field 'unsupported'/,
  );
});

test("the named harness diagnoses profile field types", async () => {
  const dir = await makeTempDir();
  for (const [frontmatter, expected] of [
    ["model: {a: 1}", /model must be a string/],
    ["tools: 12", /tools must be a string/],
    ["model: []", /model must be a string/],
    [
      "appendSystemPrompt: yes please",
      /appendSystemPrompt must be true or false/,
    ],
  ] as const) {
    const filePath = await writeAgentWithFrontmatter(dir, frontmatter);
    const config = parseAgentConfig(filePath);
    const diagnostics = createHarnessRegistry([createPiHarness()]).validate(
      config,
      filePath,
    );
    assert.match(diagnostics[0]?.reason ?? "", expected, frontmatter);
  }
});

test("parseAgentConfig names description when it is not a string", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "worker.md");
  await fs.promises.writeFile(filePath, "---\ndescription: []\n---\n\nWork.\n");

  assert.throws(
    () => parseAgentConfig(filePath),
    /description must be a string, not a list/,
  );
});

test("parseAgentConfig treats an empty optional string field as absent", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "model:");

  const config = parseAgentConfig(filePath);
  assert.equal(config.fields?.model, null);
});

test("parseAgentConfig accepts a comma-separated tools list", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "tools: read, grep");

  assert.equal(parseAgentConfig(filePath).fields?.tools, "read, grep");
});

test("parseAgentConfig reads effort as its own field", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(
    dir,
    "model: openai-codex/gpt-5.6-sol\neffort: high",
  );

  const config = parseAgentConfig(filePath);
  assert.equal(config.fields?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(config.fields?.effort, "high");
});

test("parseAgentConfig accepts every effort in the scale", async () => {
  const dir = await makeTempDir();
  for (const effort of EFFORTS) {
    const filePath = await writeAgentWithFrontmatter(dir, `effort: ${effort}`);
    assert.equal(parseAgentConfig(filePath).fields?.effort, effort);
  }
});

test("parseAgentConfig rejects an unknown effort", async () => {
  const dir = await makeTempDir();
  const filePath = await writeAgentWithFrontmatter(dir, "effort: turbo");

  const config = parseAgentConfig(filePath);
  const diagnostics = createHarnessRegistry([createPiHarness()]).validate(
    config,
    filePath,
  );
  assert.match(diagnostics[0]?.reason ?? "", /unknown effort 'turbo'/);
});

test("parseAgentConfig passes a model through exactly as written", async () => {
  const dir = await makeTempDir();
  // No provider stripping, no suffix splitting. Whatever pi accepts is between
  // the author and pi.
  for (const model of [
    "claude-opus-4-5",
    "openai-codex/gpt-5.5",
    "openrouter/google/gemma-4-31b-it:free",
    "bedrock/us.anthropic.claude-opus-4-5-v1:0",
    "arn:aws:bedrock:us-east-1:1234:application-inference-profile/mine",
    "sonnet:high",
  ]) {
    const filePath = await writeAgentWithFrontmatter(dir, `model: ${model}`);
    assert.equal(parseAgentConfig(filePath).fields?.model, model, model);
  }
});
