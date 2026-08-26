import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSessionPush } from "./delivery.ts";
import { createHarnessRegistry } from "./harness.ts";
import { createPiHarness } from "./pi-harness.ts";
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
    sendUserMessage() {},
  };
  const lifecycle = createSessionLifecycle({
    pi,
    sendUserMessage: pi.sendUserMessage,
    agentsDir,
    delivery: { shutdown() {} },
    sessionPush: createSessionPush(),
    runs: createSubagentRuns(),
    harnesses: createHarnessRegistry([createPiHarness()]),
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

test("session start diagnoses a pinned Pi model when the catalogue is empty", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "subagent-empty-catalogue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentsDir = path.join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "pinned.md"),
    "---\ndescription: pinned\nmodel: acme/model\n---\n\nWork.\n",
  );
  const warnings: string[] = [];
  const lifecycle = createSessionLifecycle({
    pi: { registerCommand() {}, sendMessage() {} },
    sendUserMessage() {},
    agentsDir,
    delivery: { shutdown() {} },
    sessionPush: createSessionPush(),
    runs: createSubagentRuns(),
    harnesses: createHarnessRegistry([createPiHarness()]),
    registerFeatures() {},
  });

  lifecycle.sessionStart({
    ...sessionContext("/project", false),
    ui: {
      notify(message) {
        warnings.push(message);
      },
      setWidget() {},
    },
  });

  assert.match(warnings[0] ?? "", /acme\/model/);
  assert.match(warnings[0] ?? "", /not found in Pi's model catalogue/);
});

test("session shutdown delegates cleanup as one lifecycle operation", () => {
  let shutdowns = 0;
  const lifecycle = createSessionLifecycle({
    pi: { registerCommand() {}, sendMessage() {} },
    sendUserMessage() {},
    agentsDir: path.join(tmpdir(), "no-subagent-profiles-here"),
    delivery: {
      shutdown: () => shutdowns++,
    },
    sessionPush: createSessionPush(),
    runs: createSubagentRuns(),
    harnesses: createHarnessRegistry([createPiHarness()]),
    registerFeatures() {},
  });

  lifecycle.sessionShutdown();
  assert.equal(shutdowns, 1);
});
