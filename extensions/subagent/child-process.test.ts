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

function fakeChild(onKill: () => void = () => {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  child.kill = () => {
    onKill();
    if (!closed) {
      closed = true;
      queueMicrotask(() => child.emit("close", null, null));
    }
    return true;
  };
  return child;
}

function sourceForFakeChild(child: FakeChild) {
  return processJsonSource({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    childName: "fixture",
    spawn: () => child as unknown as ChildProcess,
  });
}

async function runSource(
  script: string,
  overrides: Record<string, unknown> = {},
  acknowledge: (event: Record<string, unknown>) => boolean | undefined = () =>
    undefined,
) {
  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const sink: OneShotSink<Record<string, unknown>> = {
    event: (event) => {
      events.push(event);
      return acknowledge(event);
    },
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

test("process source frames a JSON record split across stdout chunks", async () => {
  const child = fakeChild();
  const events: Record<string, unknown>[] = [];
  const promise = sourceForFakeChild(child)(
    {
      event: (event) => {
        events.push(event);
        return undefined;
      },
      stderr: () => {},
    },
    new AbortController().signal,
  );
  child.stdout.write('{"split":');
  child.stdout.write("true}\n");
  child.emit("close", 0, null);

  assert.deepEqual(await promise, { status: "clean" });
  assert.deepEqual(events, [{ split: true }]);
});

test("process source flushes a trailing JSON record without a newline", async () => {
  const child = fakeChild();
  const events: Record<string, unknown>[] = [];
  const promise = sourceForFakeChild(child)(
    {
      event: (event) => {
        events.push(event);
        return undefined;
      },
      stderr: () => {},
    },
    new AbortController().signal,
  );
  child.stdout.write('{"trailing":true}');
  child.emit("close", 0, null);

  assert.deepEqual(await promise, { status: "clean" });
  assert.deepEqual(events, [{ trailing: true }]);
});

test("process source rejects a streaming sink throw and cleans up the child", async () => {
  let killed = 0;
  const child = fakeChild(() => {
    killed++;
  });
  const controller = new AbortController();
  const promise = sourceForFakeChild(child)(
    {
      event: () => {
        throw new Error("translator failed while streaming");
      },
      stderr: () => {},
    },
    controller.signal,
  );
  child.stdout.write('{"event":true}\n');

  await assert.rejects(promise, /translator failed while streaming/);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(killed, 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("process source rejects a final-flush sink throw without an uncaught close error", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const promise = sourceForFakeChild(child)(
    {
      event: () => {
        throw new Error("translator failed while flushing");
      },
      stderr: () => {},
    },
    controller.signal,
  );
  child.stdout.write('{"event":true}');
  child.emit("close", 0, null);

  await assert.rejects(promise, /translator failed while flushing/);
  controller.abort();
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
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

test("process source uses only terminal acknowledgement to suppress a tail", async () => {
  const clean = await runSource(
    'process.stdout.write(JSON.stringify({ kind: "partial" }) + "\\n");',
    {},
    () => false,
  );
  assert.match(clean.stderr, /Last stdout:/);

  const nonterminal = await runSource(
    'process.stdout.write(JSON.stringify({ kind: "partial" }) + "\\n"); process.exitCode = 7;',
    {},
    () => false,
  );
  assert.match(nonterminal.stderr, /Last stdout:/);

  const terminal = await runSource(
    'process.stdout.write(JSON.stringify({ kind: "answer" }) + "\\n"); process.exitCode = 7;',
    {},
    () => true,
  );
  assert.doesNotMatch(terminal.stderr, /Last stdout:/);
});

test("issue-03 policy: clean no-terminal exit with stderr suppresses stdout post-mortem", async () => {
  const result = await runSource(
    'process.stdout.write(JSON.stringify({ kind: "partial" }) + "\\n"); process.stderr.write("runtime warning\\n");',
    {},
    () => false,
  );
  // Explicit policy enforcement: an existing stderr diagnostic means the
  // clean, answerless child is not otherwise silent, so stdout stays hidden.
  assert.deepEqual(result.conclusion, { status: "clean" });
  assert.equal(result.stderr, "runtime warning\n");
  assert.doesNotMatch(result.stderr, /Last stdout:/);
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

test("process source drops a complete oversized line from one stdout chunk", async () => {
  const child = fakeChild();
  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const promise = sourceForFakeChild(child)(
    {
      event: (event) => {
        events.push(event);
        return undefined;
      },
      stderr: (chunk) => stderr.push(chunk),
    },
    new AbortController().signal,
  );
  child.stdout.write(
    `${"x".repeat(33 * 1024 * 1024)}\n${JSON.stringify({ ok: true })}\n`,
  );
  child.emit("close", 0, null);

  assert.deepEqual(await promise, { status: "clean" });
  assert.deepEqual(events, [{ ok: true }]);
  assert.match(stderr.join(""), /oversized stdout line dropped/);
});

test("process source resynchronizes after an oversized line split across chunks", async () => {
  const child = fakeChild();
  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const promise = sourceForFakeChild(child)(
    {
      event: (event) => {
        events.push(event);
        return undefined;
      },
      stderr: (chunk) => stderr.push(chunk),
    },
    new AbortController().signal,
  );
  child.stdout.write("x".repeat(32 * 1024 * 1024 + 1));
  child.stdout.write(`discarded\n${JSON.stringify({ ok: true })}\n`);
  child.emit("close", 0, null);

  assert.deepEqual(await promise, { status: "clean" });
  assert.deepEqual(events, [{ ok: true }]);
  assert.match(stderr.join(""), /oversized stdout line dropped/);
});

test("process source reports an oversized line when the child exits mid-drop", async () => {
  const child = fakeChild();
  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const promise = sourceForFakeChild(child)(
    {
      event: (event) => {
        events.push(event);
        return undefined;
      },
      stderr: (chunk) => stderr.push(chunk),
    },
    new AbortController().signal,
  );
  child.stdout.write("x".repeat(32 * 1024 * 1024 + 1));
  // Keep the dropped line oversized after the first reset, but never provide
  // its terminating newline before the child exits.
  child.stdout.write("x".repeat(32 * 1024 * 1024 + 1));
  child.emit("close", 0, null);

  assert.deepEqual(await promise, { status: "clean" });
  assert.deepEqual(events, []);
  assert.match(stderr.join(""), /oversized stdout line dropped/);
});

test("process source reports errors on stderr and cleans up the child", async () => {
  const child = new EventEmitter() as unknown as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = 0;
  child.kill = () => {
    killed++;
    return true;
  };
  const stderr: string[] = [];
  const source = processJsonSource({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    childName: "fixture",
    killEscalationMs: 60_000,
    spawn: () => child as unknown as ChildProcess,
  });
  const promise = source(
    { event: () => undefined, stderr: (chunk) => stderr.push(chunk) },
    new AbortController().signal,
  );
  queueMicrotask(() => {
    child.emit("error", new Error("spawn/runtime error"));
    child.emit("close", 1, null);
  });
  assert.deepEqual(await promise, { status: "failed" });
  assert.deepEqual(stderr, ["spawn/runtime error\n"]);
  assert.equal(killed, 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("abort stops the child without emitting a stdout tail", async () => {
  const controller = new AbortController();
  let killed = 0;
  let child: FakeChild | undefined;
  const stderr: string[] = [];
  const source = processJsonSource({
    command: "fixture",
    args: [],
    cwd: "/tmp",
    childDepth: 1,
    prompt: "",
    childName: "fixture",
    spawn: (_command, _args, _options) => {
      child = new EventEmitter() as unknown as FakeChild;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        killed++;
        queueMicrotask(() => child?.emit("close", null, null));
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });
  const promise = source(
    { event: () => undefined, stderr: (chunk) => stderr.push(chunk) },
    controller.signal,
  );
  assert.ok(child);
  child.stdout.write("tail before cancellation");
  controller.abort();
  await promise;
  assert.equal(killed, 1);
  assert.equal(stderr.join(""), "");
});

test("the process source owns the child depth environment key", () => {
  assert.equal(DEPTH_ENV_KEY, "PI_SUBAGENT_DEPTH");
});
