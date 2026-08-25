import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionPush, type SubagentDelivery } from "./delivery.ts";
import { createSubagentRuns } from "./runs.ts";
import { createSessionLifecycle } from "./session-lifecycle.ts";
import type { AgentConfig, SessionContext } from "./types.ts";

function writeAgent(agentsDir: string, name: string): void {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, `${name}.md`),
    `---\ndescription: ${name} agent\n---\n\nWork.\n`,
  );
}

function sessionContext(cwd: string, trusted: boolean) {
  return {
    cwd,
    isProjectTrusted: () => trusted,
    modelRegistry: { getAll: () => [] },
    ui: {
      notify() {},
      setWidget() {},
    },
  };
}

test("session start refills stable config and session-fact references", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "subagent-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentsDir = path.join(root, "agents");
  writeAgent(agentsDir, "first");

  let featureRegistrations = 0;
  let liveSession: SessionContext | undefined;
  let liveConfigs: Map<string, AgentConfig> | undefined;
  const pi = {
    registerCommand() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const lifecycle = createSessionLifecycle({
    pi,
    agentsDir,
    delivery: { shutdown() {} } as SubagentDelivery,
    sessionPush: createSessionPush(),
    runs: createSubagentRuns(),
    registerFeatures(session, configs) {
      featureRegistrations++;
      liveSession = session;
      liveConfigs = configs;
    },
  });

  lifecycle.sessionStart(sessionContext("/first-project", false));
  assert.deepEqual([...(liveConfigs?.keys() ?? [])], ["first"]);
  assert.deepEqual(liveSession, {
    cwd: "/first-project",
    projectTrusted: false,
  });
  const originalSession = liveSession;
  const originalConfigs = liveConfigs;

  rmSync(path.join(agentsDir, "first.md"));
  writeAgent(agentsDir, "second");
  lifecycle.sessionStart(sessionContext("/second-project", true));

  assert.equal(featureRegistrations, 1, "features register once per runtime");
  assert.strictEqual(liveSession, originalSession);
  assert.strictEqual(liveConfigs, originalConfigs);
  assert.deepEqual([...(liveConfigs?.keys() ?? [])], ["second"]);
  assert.deepEqual(liveSession, {
    cwd: "/second-project",
    projectTrusted: true,
  });
});

test("session shutdown delegates cleanup as one lifecycle operation", () => {
  let shutdowns = 0;
  const lifecycle = createSessionLifecycle({
    pi: { registerCommand() {}, sendMessage() {} } as unknown as ExtensionAPI,
    agentsDir: path.join(tmpdir(), "no-subagent-profiles-here"),
    delivery: {
      shutdown: () => shutdowns++,
    } as unknown as SubagentDelivery,
    sessionPush: createSessionPush(),
    runs: createSubagentRuns(),
    registerFeatures() {},
  });

  lifecycle.sessionShutdown();
  assert.equal(shutdowns, 1);
});
