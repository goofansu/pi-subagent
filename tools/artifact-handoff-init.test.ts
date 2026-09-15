import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const skill = fileURLToPath(
  new URL("../skills/artifact-handoff/", import.meta.url),
);
const tool = path.join(skill, "init.mjs");
const exec = promisify(execFile);
const fixture = (t: TestContext) => {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "handoff-init-")),
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
const invoke = (home: string, args: string[] = [], entry = tool) =>
  spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

test("allocates a complete private handoff with independent protocol copies", (t) => {
  const home = fixture(t);
  const result = invoke(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const root = result.stdout.trim();
  assert.equal(result.stdout, `${root}\n`);
  assert.equal(path.dirname(root), path.join(home, ".agent-runs"));
  assert.match(path.basename(root), /^handoff-\d{8}T\d{6}-[A-Za-z0-9]{6}$/);
  for (const directory of [
    root,
    path.join(root, "evidence"),
    path.join(root, "evidence/orchestrator"),
  ]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  for (const name of ["README.md", "WRITER.md", "synopsis.mjs"]) {
    const target = path.join(root, name);
    assert.equal(fs.lstatSync(target).isFile(), true);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    if (name !== "README.md") {
      assert.equal(
        fs.readFileSync(target, "utf8"),
        fs.readFileSync(path.join(skill, name), "utf8"),
      );
      assert.notEqual(
        fs.statSync(target).ino,
        fs.statSync(path.join(skill, name)).ino,
      );
    }
  }
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  for (const heading of [
    "Project",
    "Base revision",
    "Shared context",
    "Common constraints",
  ])
    assert.ok(readme.includes(heading));
});

test("rejects a symlinked base without changing or allocating in its target", (t) => {
  const home = fixture(t);
  const target = fixture(t);
  fs.chmodSync(target, 0o755);
  const sentinel = path.join(target, "sentinel");
  fs.writeFileSync(sentinel, "keep");
  fs.chmodSync(sentinel, 0o644);
  const base = path.join(home, ".agent-runs");
  fs.symlinkSync(target, base);

  const result = invoke(home);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /symlink/i);
  assert.equal(fs.readlinkSync(base), target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.statSync(sentinel).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(target), ["sentinel"]);
  assert.deepEqual(fs.readdirSync(home), [".agent-runs"]);
});

test("returns a physical root when HOME is a directory alias", (t) => {
  const container = fixture(t);
  const home = fixture(t);
  const alias = path.join(container, "home-alias");
  fs.symlinkSync(home, alias);
  const result = invoke(alias);
  assert.equal(result.status, 0, result.stderr);
  const root = result.stdout.trim();
  assert.equal(root, fs.realpathSync(root));
  assert.equal(path.dirname(root), path.join(home, ".agent-runs"));
  assert.ok(fs.existsSync(path.join(root, "README.md")));
});

test("tightens an existing real base from 755 to 700 without disturbing content", (t) => {
  const home = fixture(t);
  const base = path.join(home, ".agent-runs");
  fs.mkdirSync(base);
  fs.chmodSync(base, 0o755);
  fs.writeFileSync(path.join(base, "sentinel"), "keep");
  assert.equal(fs.statSync(base).mode & 0o777, 0o755);
  const result = invoke(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(base).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(base, "sentinel"), "utf8"), "keep");
  assert.equal(path.dirname(result.stdout.trim()), base);
  assert.ok(fs.existsSync(path.join(result.stdout.trim(), "README.md")));
});

test("concurrent invocations allocate distinct roots without reusing prior content", async (t) => {
  const home = fixture(t);
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      exec(process.execPath, [tool], { env: { ...process.env, HOME: home } }),
    ),
  );
  const roots = results.map(({ stdout }) => stdout.trim());
  assert.equal(new Set(roots).size, 12);
  for (const root of roots)
    assert.ok(fs.existsSync(path.join(root, "README.md")));
  fs.writeFileSync(path.join(roots[0], "sentinel"), "keep");
  const next = invoke(home);
  assert.equal(next.status, 0, next.stderr);
  assert.ok(!roots.includes(next.stdout.trim()));
  assert.equal(
    fs.readFileSync(path.join(roots[0], "sentinel"), "utf8"),
    "keep",
  );
});

test("rejects all caller arguments before allocating or touching an override", (t) => {
  const home = fixture(t);
  const override = path.join(home, "chosen");
  for (const args of [
    [override],
    ["--root", override],
    ["--path", override],
    [`--root=${override}`],
  ]) {
    const result = invoke(home, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /no arguments or path overrides/);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test("invalid HOME and an unusable base fail without returning a root", (t) => {
  const home = fixture(t);
  for (const invalid of ["", "relative", `${home}\nother`]) {
    const result = invoke(invalid);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /HOME/);
  }
  fs.writeFileSync(path.join(home, ".agent-runs"), "untouched");
  const result = invoke(home);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(
    fs.readFileSync(path.join(home, ".agent-runs"), "utf8"),
    "untouched",
  );
});

test("missing mktemp fails without a success path or fallback allocation", (t) => {
  const home = fixture(t);
  const result = spawnSync(process.execPath, [tool], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: home },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /mktemp/);
  assert.deepEqual(fs.readdirSync(path.join(home, ".agent-runs")), []);
});

test("protocol preparation failure removes the incomplete allocation and returns no root", (t) => {
  const home = fixture(t);
  const brokenTool = path.join(home, "init.mjs");
  fs.copyFileSync(tool, brokenTool);
  const result = invoke(home, [], brokenTool);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /WRITER.md/);
  assert.deepEqual(fs.readdirSync(path.join(home, ".agent-runs")), []);
});
