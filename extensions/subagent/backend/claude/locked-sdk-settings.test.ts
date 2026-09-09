import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  resolveSettings,
  type SDKSystemMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  backendId,
  type Profile,
  type SubagentContext,
  subagentId,
} from "../../domain/index.ts";
import { createClaudeOptions } from "./options.ts";

const USER_MARKER = "PI_SUBAGENT_LOCKED_SDK_USER";
const PROJECT_MARKER = "PI_SUBAGENT_LOCKED_SDK_PROJECT";
const LOCAL_MARKER = "PI_SUBAGENT_LOCKED_SDK_LOCAL";
const PROJECT_MCP_MARKER = "pi-subagent-locked-sdk-project-mcp";

/** Read only the local initialization frame; no provider answer is needed. */
async function initializeQuery(
  options: ReturnType<typeof createClaudeOptions>,
  testSignal: AbortSignal,
): Promise<SDKSystemMessage> {
  const abort = options.abortController;
  if (abort === undefined)
    throw new Error("Claude options have no abort controller");
  const abortOnTestTimeout = () => abort.abort();
  testSignal.addEventListener("abort", abortOnTestTimeout, { once: true });
  const running = sdkQuery({ prompt: "Do not answer.", options });

  try {
    for await (const message of running) {
      if (message.type === "system" && message.subtype === "init") {
        return message;
      }
    }
    throw new Error("the locked Claude SDK ended before its init frame");
  } finally {
    testSignal.removeEventListener("abort", abortOnTestTimeout);
    abort.abort();
    running.close();
  }
}

/** The adapter options for one Trust posture in the disposable project. */
function options(
  project: string,
  config: string,
  projectTrusted: boolean,
): ReturnType<typeof createClaudeOptions> {
  const profile: Profile = {
    name: "locked-sdk-settings",
    description: "Exercises local SDK configuration discovery",
    backend: backendId("claude"),
    fields: {},
    systemPrompt: "Do not answer.",
  };
  const subagent: SubagentContext = {
    subagentId: subagentId(
      projectTrusted ? "sa-locked-trusted" : "sa-locked-untrusted",
    ),
    cwd: project,
    childDepth: 1,
    projectTrusted,
  };

  return createClaudeOptions({
    profile,
    subagent,
    abort: new AbortController(),
    env: {
      HOME: path.dirname(config),
      CLAUDE_CONFIG_DIR: config,
      // The init frame is emitted before a provider response. A deliberately
      // unusable key prevents this contract test from consuming credentials.
      ANTHROPIC_API_KEY: "locked-sdk-test-do-not-use",
      PATH: process.env.PATH,
    },
  });
}

test("the locked Claude SDK discovers only the filesystem sources selected by Trust", {
  timeout: 30_000,
}, async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-claude-settings-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const config = path.join(home, ".claude");
  const project = path.join(root, "project");
  const projectConfig = path.join(project, ".claude");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(projectConfig, { recursive: true });

  fs.writeFileSync(
    path.join(config, "settings.json"),
    JSON.stringify({ env: { [USER_MARKER]: "user" } }),
  );
  fs.writeFileSync(
    path.join(projectConfig, "settings.json"),
    JSON.stringify({ env: { [PROJECT_MARKER]: "project" } }),
  );
  fs.writeFileSync(
    path.join(projectConfig, "settings.local.json"),
    JSON.stringify({ env: { [LOCAL_MARKER]: "local" } }),
  );
  fs.writeFileSync(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        [PROJECT_MCP_MARKER]: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      },
    }),
  );

  // resolveSettings has no env option, unlike query(), so point this one
  // in-process inspection at the disposable user directory and restore it.
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  });

  const trustedOptions = options(project, config, true);
  const untrustedOptions = options(project, config, false);
  const trustedSettings = await resolveSettings({
    cwd: project,
    settingSources: trustedOptions.settingSources,
  });
  const untrustedSettings = await resolveSettings({
    cwd: project,
    settingSources: untrustedOptions.settingSources,
  });

  assert.deepEqual(
    trustedSettings.sources
      .map((source) => source.source)
      .filter((source) => source !== "managed" && source !== "flag"),
    ["user", "project", "local"],
  );
  assert.deepEqual(trustedSettings.effective.env, {
    [USER_MARKER]: "user",
    [PROJECT_MARKER]: "project",
    [LOCAL_MARKER]: "local",
  });
  assert.deepEqual(
    untrustedSettings.sources
      .map((source) => source.source)
      .filter((source) => source !== "managed" && source !== "flag"),
    ["user"],
  );
  assert.deepEqual(untrustedSettings.effective.env, {
    [USER_MARKER]: "user",
  });

  const trustedInit = await initializeQuery(trustedOptions, t.signal);
  const untrustedInit = await initializeQuery(untrustedOptions, t.signal);
  assert.ok(
    trustedInit.mcp_servers.some(
      (server) => server.name === PROJECT_MCP_MARKER,
    ),
  );
  assert.equal(
    untrustedInit.mcp_servers.some(
      (server) => server.name === PROJECT_MCP_MARKER,
    ),
    false,
  );
});
