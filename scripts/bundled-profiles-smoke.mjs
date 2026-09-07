// Offline production package-loading check. No provider requests or user settings writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "bundled-profiles-smoke-"),
);
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDepth = process.env.PI_SUBAGENT_DEPTH;
const names = [
  "explore",
  "implementer",
  "researcher",
  "spec-reviewer",
  "standards-reviewer",
];
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8",
    }),
  )[0];
  for (const name of names)
    assert.ok(packed.files.some((file) => file.path === `agents/${name}.md`));
  execFileSync("tar", [
    "-xzf",
    path.join(temporary, packed.filename),
    "-C",
    temporary,
  ]);
  const installed = path.join(temporary, "package");
  // Reuse installed dependencies only, never source modules or migration resources.
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(installed, "node_modules"),
  );
  const cwd = path.join(temporary, "unrelated");
  const agentDir = path.join(temporary, "configured-user");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_DEPTH;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [installed] }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(
    (entry) =>
      entry.path === path.join(installed, "extensions/subagent/index.ts"),
  );
  assert.ok(
    extension,
    "Pi discovers the manifest's production extension from the tarball",
  );
  const warnings = [];
  const ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => false,
    hasPendingMessages: () => false,
    modelRegistry: {
      getAll: () => [
        { provider: "opencode", id: "claude-haiku-4-5" },
        { provider: "openai-codex", id: "gpt-5.6-sol" },
      ],
    },
    ui: { setWidget() {}, notify: (text) => warnings.push(text) },
  };
  const emit = async (type) => {
    for (const handler of extension.handlers.get(type) ?? [])
      await handler({ type }, ctx);
  };
  const tool = extension.tools.get("agent_start").definition;
  const guidelines = () => tool.promptGuidelines.join("\n");
  await emit("session_start");
  try {
    assert.deepEqual(warnings, []);
    for (const name of names)
      assert.ok(
        guidelines().includes(name),
        `${name} is available without user Profiles`,
      );
    fs.mkdirSync(path.join(agentDir, "agents"));
    fs.writeFileSync(path.join(agentDir, "agents/explore.md"), "---\n---\n");
    fs.writeFileSync(
      path.join(agentDir, "agents/custom.md"),
      "---\ndescription: Configured directory specialist\nbackend: claude\n---\nDo custom work.\n",
    );
    assert.ok(
      !guidelines().includes("Configured directory specialist"),
      "no live discovery",
    );
  } finally {
    await emit("session_shutdown");
  }
  await emit("session_start");
  try {
    assert.ok(guidelines().includes("Configured directory specialist"));
    assert.ok(
      warnings.some((warning) =>
        warning.includes(path.join(agentDir, "agents/explore.md")),
      ),
    );
    const result = await tool.execute(
      "invalid-start",
      { agent: "explore", description: "inspect", prompt: "inspect" },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content.map((part) => part.text ?? "").join("\n");
    assert.match(text, /invalid|cannot|unavailable/i);
    assert.ok(
      text.includes(path.join(agentDir, "agents/explore.md")),
      "delegation reports the override, not a fallback",
    );
  } finally {
    await emit("session_shutdown");
  }
  process.env.PI_SUBAGENT_DEPTH = "1";
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const child = loader
    .getExtensions()
    .extensions.find((entry) => entry.path === extension.path);
  assert.equal(
    child.tools.size,
    0,
    "production child cannot delegate recursively",
  );
  console.log(
    "PASS: packed Profiles; Pi production loading from unrelated cwd; configured user overrides and diagnostics; Session-start discovery; child guard. No provider calls.",
  );
} finally {
  process.chdir(previousCwd);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
  else process.env.PI_SUBAGENT_DEPTH = previousDepth;
  fs.rmSync(temporary, { recursive: true, force: true });
}
