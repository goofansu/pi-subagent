import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveProjectConfigPolicy } from "./project-config-policy.ts";

function makeDirs(): { cwd: string; agentDir: string } {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "subagent-policy-")),
  );
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

function writeTrustStore(agentDir: string, contents: unknown): void {
  writeFileSync(
    path.join(agentDir, "trust.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf-8",
  );
}

test("pi untrusted denies project config even with a saved approval", () => {
  const { cwd, agentDir } = makeDirs();
  writeTrustStore(agentDir, { [cwd]: true });

  const policy = resolveProjectConfigPolicy({
    cwd,
    agentDir,
    piProjectTrusted: false,
  });

  assert.equal(policy.allowProjectConfig, false);
  assert.equal(policy.reason, "pi-untrusted");
  assert.equal(policy.piProjectTrusted, false);
});

test("pi trust with a trust-requiring resource allows project config", () => {
  const { cwd, agentDir } = makeDirs();
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "settings.json"), "{}", "utf-8");

  const policy = resolveProjectConfigPolicy({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.equal(policy.allowProjectConfig, true);
  assert.equal(policy.reason, "trust-required-and-approved");
});

test("pi trust with an inherited saved approval allows project config", () => {
  const { cwd, agentDir } = makeDirs();
  writeTrustStore(agentDir, { [path.dirname(cwd)]: true });

  const policy = resolveProjectConfigPolicy({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.equal(policy.allowProjectConfig, true);
  assert.equal(policy.reason, "saved-approval");
});

test("vacuous pi trust without a saved decision denies project config", () => {
  const { cwd, agentDir } = makeDirs();

  const policy = resolveProjectConfigPolicy({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.equal(policy.allowProjectConfig, false);
  assert.equal(policy.reason, "vacuous-trust");
});

test("a saved negative decision without resources denies project config", () => {
  const { cwd, agentDir } = makeDirs();
  writeTrustStore(agentDir, { [cwd]: false });

  const policy = resolveProjectConfigPolicy({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.equal(policy.allowProjectConfig, false);
  assert.equal(policy.reason, "vacuous-trust");
});

test("an unreadable trust store denies project config and warns", () => {
  const { cwd, agentDir } = makeDirs();
  writeTrustStore(agentDir, "{ not json");

  const policy = resolveProjectConfigPolicy({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.equal(policy.allowProjectConfig, false);
  assert.equal(policy.reason, "trust-store-error");
  assert.match(String(policy.warning), /project configuration/i);
  assert.ok(!String(policy.warning).includes(agentDir));
});

test("a trust-requiring resource outranks a broken trust store", () => {
  const { cwd, agentDir } = makeDirs();
  mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
  writeTrustStore(agentDir, "{ not json");

  const policy = resolveProjectConfigPolicy({
    cwd,
    agentDir,
    piProjectTrusted: true,
  });

  assert.equal(policy.allowProjectConfig, true);
  assert.equal(policy.reason, "trust-required-and-approved");
  assert.equal(policy.warning, undefined);
});

test(".pi/agents alone is not a trust-requiring resource", () => {
  const { cwd, agentDir } = makeDirs();
  mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });

  assert.equal(
    resolveProjectConfigPolicy({ cwd, agentDir, piProjectTrusted: true })
      .allowProjectConfig,
    false,
  );

  writeTrustStore(agentDir, { [cwd]: true });

  assert.equal(
    resolveProjectConfigPolicy({ cwd, agentDir, piProjectTrusted: true })
      .allowProjectConfig,
    true,
  );
});
