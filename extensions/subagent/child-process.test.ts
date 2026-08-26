import assert from "node:assert/strict";
import {
  type ChildProcess,
  spawn as realSpawn,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { processJsonSource } from "./child-process.ts";
import type { OneShotSink } from "./one-shot.ts";
import { DEPTH_ENV_KEY } from "./run.ts";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal: string): boolean;
}

function spawnFixture(script: string) {
  return (_command: string, _args: readonly string[], options: SpawnOptions) =>
    realSpawn(process.execPath, ["-e", script], options);
}

async function runSource(
  script: string,
  overrides: Record<string, unknown> = {},
) {
  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const sink: OneShotSink<Record<string, unknown>> = {
    event: (event) => events.push(event),
    stderr: (chunk) => stderr.push(chunk),
  };
  const source = processJsonSource({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 4,
    prompt: "prompt from stdin",
    childName: "fixture",
    spawn: spawnFixture(script),
    ...overrides,
  });
  const conclusion = await source(sink, new AbortController().signal);
  return { conclusion, events, stderr: stderr.join("") };
}

test("process source carries depth, prompt, and parsed JSON events", async () => {
  const result = await runSource(
    'process.stdin.setEncoding("utf8"); let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => process.stdout.write(JSON.stringify({depth: process.env.PI_SUBAGENT_DEPTH, input}) + "\\n"));',
  );
  assert.deepEqual(result.events, [{ depth: "4", input: "prompt from stdin" }]);
  assert.deepEqual(result.conclusion, { status: "clean" });
});

test("process source emits a failure diagnostic and a silent stdout tail", async () => {
  const result = await runSource(
    'process.stdout.write("prefix-" + "x".repeat(3000) + "-tail"); process.exitCode = 7;',
  );
  assert.deepEqual(result.conclusion, {
    status: "failed",
    errorMessage: "Child fixture exited with code 7",
  });
  assert.match(result.stderr, /Last stdout:/);
  assert.match(result.stderr, /-tail/);
  assert.ok(result.stderr.length < 2100);
});

test("process source does not replace an existing stderr diagnostic", async () => {
  const result = await runSource(
    'process.stderr.write("runtime error\\n"); process.exitCode = 7;',
  );
  assert.deepEqual(result.conclusion, {
    status: "failed",
    errorMessage: "Child fixture exited with code 7",
  });
  assert.equal(result.stderr, "runtime error\n");
});

test("oversized lines resynchronize at the next JSON line", async () => {
  const result = await runSource(
    'process.stdout.write("x".repeat(33 * 1024 * 1024) + "\\n" + JSON.stringify({ok: true}) + "\\n");',
  );
  assert.deepEqual(result.events, [{ ok: true }]);
  assert.match(result.stderr, /oversized stdout line dropped/);
});

test("a process error is reported on stderr without a close diagnostic", async () => {
  const child = new EventEmitter() as unknown as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const stderr: string[] = [];
  const source = processJsonSource({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    childName: "fixture",
    spawn: () => child as unknown as ChildProcess,
  });
  const promise = source(
    { event: () => {}, stderr: (chunk) => stderr.push(chunk) },
    new AbortController().signal,
  );
  queueMicrotask(() => {
    child.emit("error", new Error("spawn/runtime error"));
    child.emit("close", 1, null);
  });
  assert.deepEqual(await promise, { status: "failed" });
  assert.deepEqual(stderr, ["spawn/runtime error\n"]);
});

test("abort stops the child and the source settles", async () => {
  const controller = new AbortController();
  let killed = 0;
  const source = processJsonSource({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    childName: "fixture",
    spawn: (_command, _args, _options) => {
      const child = new EventEmitter() as unknown as FakeChild;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        killed++;
        queueMicrotask(() => child.emit("close", null, null));
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });
  const promise = source(
    { event: () => {}, stderr: () => {} },
    controller.signal,
  );
  controller.abort();
  await promise;
  assert.equal(killed, 1);
});

// Keep the contract key referenced in this source-level test: the process
// source, not the adapter, owns depth transport.
assert.equal(DEPTH_ENV_KEY, "PI_SUBAGENT_DEPTH");
