import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { test } from "node:test";
import {
  createNdjsonBuffer,
  getSpawnOptions,
  runChildProcess,
} from "./child-process.ts";

function spawnFixture(script: string) {
  return (
    _command: string,
    _args: readonly string[],
    options: Parameters<typeof realSpawn>[2],
  ) => realSpawn(process.execPath, ["-e", script], options);
}

test("the neutral driver frames split and oversized lines with resync", () => {
  const buffer = createNdjsonBuffer(16);
  assert.deepEqual(buffer.push('{"a":1}\n{"b'), ['{"a":1}']);
  assert.deepEqual(buffer.push('":2}\n'), ['{"b":2}']);
  assert.deepEqual(buffer.push(`${"x".repeat(64)}\n{"ok":1}\n`), ['{"ok":1}']);
  assert.equal(buffer.overflowed(), true);
});

test("the driver carries depth and prompt over inherited child process seams", async () => {
  const lines: string[] = [];
  const result = await runChildProcess({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 4,
    prompt: "prompt from stdin",
    spawn: spawnFixture(
      'process.stdin.setEncoding("utf8"); let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => process.stdout.write(process.env.PI_SUBAGENT_DEPTH + ":" + input + "\\n"));',
    ),
    onLine: (line) => {
      lines.push(line);
      return false;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(lines, ["4:prompt from stdin"]);
});

test("the driver retains a bounded stdout tail for adapter diagnostics", async () => {
  const result = await runChildProcess({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    spawn: spawnFixture(
      `process.stdout.write("prefix-${"x".repeat(3000)}-tail"); process.exitCode = 7;`,
    ),
    onLine: () => false,
  });

  assert.equal(result.exitCode, 7);
  assert.ok(result.stdoutTail.endsWith("-tail"));
  assert.ok(result.stdoutTail.length <= 2000);
});

test("the driver guards stdin errors when a child exits before reading", async () => {
  const result = await runChildProcess({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "x".repeat(1024 * 1024),
    spawn: spawnFixture("process.exit(3);"),
    onLine: () => false,
    onStderr: () => {},
  });

  assert.equal(result.exitCode, 3);
  // The child may close before the kernel reports EPIPE; either way the
  // guarded write must resolve the run rather than throw into the parent.
});

test("a terminal answer witnessed before abort stays authoritative", async () => {
  const controller = new AbortController();
  let releaseFirstLine = () => {};
  const firstLine = new Promise<void>((resolve) => {
    releaseFirstLine = resolve;
  });
  let lines = 0;
  const resultPromise = runChildProcess({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    signal: controller.signal,
    spawn: spawnFixture(
      'process.stdout.write("answer\\n"); process.on("SIGTERM", () => { process.stdout.write("late-answer\\n"); process.exit(143); }); setTimeout(() => {}, 30000);',
    ),
    onLine: () => {
      lines += 1;
      if (lines === 1) releaseFirstLine();
      return true;
    },
  });

  await firstLine;
  controller.abort();
  const result = await resultPromise;

  assert.equal(lines, 2);
  assert.equal(result.aborted, true);
  assert.equal(result.terminalBeforeAbort, true);
});

test("the driver escalates an ignored SIGTERM and cleans up after close", async () => {
  const controller = new AbortController();
  const resultPromise = runChildProcess({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    signal: controller.signal,
    killEscalationMs: 50,
    spawn: spawnFixture(
      'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000);',
    ),
    onLine: () => false,
  });
  setTimeout(() => controller.abort(), 20);
  const result = await resultPromise;

  assert.equal(result.aborted, true);
  assert.equal(result.terminalBeforeAbort, false);
});

test("spawn options preserve the parent environment and child depth", () => {
  const options = getSpawnOptions("/project", 3);
  assert.equal(options.cwd, "/project");
  assert.equal(options.env?.PI_SUBAGENT_DEPTH, "3");
  assert.equal(options.env?.PATH, process.env.PATH);
});
