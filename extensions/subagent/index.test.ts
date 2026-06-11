import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { createSubagentExtension } from "./index.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-index-test-"),
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

test("createSubagentExtension loads project agents from configCwd", async () => {
  const workspaceCwd = await makeTempDir();
  const configCwd = await makeTempDir();
  const agentDir = await makeTempDir();
  const projectAgentsDir = path.join(configCwd, ".pi", "agents");
  await fs.promises.mkdir(projectAgentsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(projectAgentsDir, "host-only.md"),
    "---\ndescription: Host configured agent\n---\n\nSay hello from the host app.\n",
  );

  let registeredTool: { name: string; promptGuidelines?: string[] } | undefined;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: { name: string; promptGuidelines?: string[] }) {
      registeredTool = tool;
    },
    getThinkingLevel() {
      return "medium";
    },
  };

  createSubagentExtension({ cwd: workspaceCwd, agentDir, configCwd })(pi);

  assert.equal(registeredTool?.name, "subagent");
  assert.ok(
    registeredTool?.promptGuidelines?.some((line) =>
      line.includes("host-only"),
    ),
    "expected host-only agent from configCwd to be listed in tool guidelines",
  );
});

test("createSubagentExtension defaults configCwd to cwd", async () => {
  const workspaceCwd = await makeTempDir();
  const agentDir = await makeTempDir();
  const projectAgentsDir = path.join(workspaceCwd, ".pi", "agents");
  await fs.promises.mkdir(projectAgentsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(projectAgentsDir, "workspace-agent.md"),
    "---\ndescription: Workspace configured agent\n---\n\nSay hello from the workspace.\n",
  );

  let registeredTool: { name: string; promptGuidelines?: string[] } | undefined;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: { name: string; promptGuidelines?: string[] }) {
      registeredTool = tool;
    },
    getThinkingLevel() {
      return "medium";
    },
  };

  createSubagentExtension({ cwd: workspaceCwd, agentDir })(pi);

  assert.equal(registeredTool?.name, "subagent");
  assert.ok(
    registeredTool?.promptGuidelines?.some((line) =>
      line.includes("workspace-agent"),
    ),
    "expected project agent from cwd to be listed when configCwd is omitted",
  );
});
