import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  type ChildProcessSpawn,
  type CodexAppServerNotification,
  codexAppServerSource,
} from "./codex-app-server.ts";
import type { OneShotSink } from "./one-shot.ts";
import { DEPTH_ENV_KEY } from "./run.ts";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal: string): boolean;
  finish(code: number | null): void;
}

function fakeChild(
  onRequest: (request: Record<string, unknown>, child: FakeChild) => void,
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  child.stdin.setEncoding("utf8");
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      onRequest(JSON.parse(line), child);
    }
  });
  child.kill = () => true;
  child.finish = (code) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", code, null));
  };
  return child;
}

function response(child: FakeChild, id: number, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function initializeResult() {
  return {
    userAgent: "fake",
    codexHome: "/tmp",
    platformFamily: "unix",
    platformOs: "test",
  };
}

function threadResult() {
  return { thread: { id: "thread-1" } };
}

function turnResult() {
  return { turn: { id: "turn-1" } };
}

function completed(status = "completed") {
  return {
    method: "turn/completed",
    emittedAtMs: 4,
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  };
}

function sourceWith(
  handler: (request: Record<string, unknown>, child: FakeChild) => void,
  overrides: Partial<Parameters<typeof codexAppServerSource>[0]> = {},
) {
  let child: FakeChild | undefined;
  let replacementKill: ((signal: string) => boolean) | undefined;
  const spawn: ChildProcessSpawn = (_command, _args, options) => {
    assert.equal(options.cwd, "/work");
    assert.equal(options.env?.[DEPTH_ENV_KEY], "2");
    assert.equal(options.env?.PATH, process.env.PATH);
    child = fakeChild(handler);
    if (replacementKill) child.kill = replacementKill;
    return child as unknown as ChildProcess;
  };
  const source = codexAppServerSource({
    cwd: "/work",
    childDepth: 2,
    prompt: "prompt",
    spawn,
    killEscalationMs: 5,
    ...overrides,
  });
  return {
    source,
    get child() {
      return child;
    },
    setKill(handler: (signal: string) => boolean) {
      replacementKill = handler;
      if (child) child.kill = handler;
    },
  };
}

function sinkFor(
  events: CodexAppServerNotification[],
  stderr: string[],
): OneShotSink<CodexAppServerNotification> {
  return {
    event: (event) => {
      events.push(event);
      return undefined;
    },
    stderr: (chunk) => stderr.push(chunk),
  };
}

test("App Server performs the exact handshake and forwards only validated run events", async () => {
  const requests: Record<string, unknown>[] = [];
  const forwarded: CodexAppServerNotification[] = [];
  const stderr: string[] = [];
  const rig = sourceWith(
    (request, child) => {
      requests.push(request);
      if (request.method === "initialize")
        response(child, request.id as number, {
          userAgent: "fake",
          codexHome: "/tmp",
          platformFamily: "unix",
          platformOs: "test",
        });
      if (request.method === "thread/start") {
        response(child, request.id as number, threadResult());
        child.stdout.write(
          `${JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-1" }, emittedAtMs: 1 })}\n`,
        );
      }
      if (request.method === "turn/start") {
        response(child, request.id as number, turnResult());
        child.stdout.write(
          `${JSON.stringify({ method: "unknown", params: { threadId: "thread-1" }, emittedAtMs: 2 })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ method: "item/started", params: { threadId: "other", turnId: "turn-1", startedAtMs: 2, item: { type: "agentMessage", id: "x", text: "no", phase: "final_answer" } }, emittedAtMs: 2 })}\n`,
        );
        child.stdout.write(`${"x".repeat(33 * 1024 * 1024)}\n`);
        child.stdout.write(
          `${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 3, item: { type: "commandExecution", id: "item-1", command: "echo hi", cwd: "/work", status: "inProgress" } }, emittedAtMs: 3 })}\n`,
        );
        child.stdout.write(`${JSON.stringify(completed())}\n`);
      }
    },
    { model: "gpt-test", effort: "off" },
  );

  const conclusion = await rig.source(
    sinkFor(forwarded, stderr),
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, { status: "clean" });
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );
  assert.deepEqual(requests[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "pi-subagent",
        title: "pi-subagent",
        version: "1.0.0",
      },
      capabilities: null,
    },
  });
  assert.deepEqual(requests[2], {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/start",
    params: {
      cwd: "/work",
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-test",
      config: { model_reasoning_effort: "none" },
    },
  });
  assert.deepEqual(requests[3], {
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "prompt", text_elements: [] }],
    },
  });
  assert.equal(forwarded[0]?.method, "item/started");
  assert.equal(forwarded[1]?.method, "turn/completed");
  assert.deepEqual(stderr, []);
  rig.child?.emit("close", 0, null);
});

test("responsive interruption sends turn/interrupt and accepts interrupted completion without killing", async () => {
  const requests: Record<string, unknown>[] = [];
  const signals: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rig = sourceWith((request, child) => {
    requests.push(request);
    if (request.method === "initialize")
      response(child, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(child, request.id as number, threadResult());
    if (request.method === "turn/start") {
      response(child, request.id as number, turnResult());
      release();
    }
    if (request.method === "turn/interrupt") {
      response(child, request.id as number, {});
      child.stdout.write(`${JSON.stringify(completed("interrupted"))}\n`);
    }
  });
  rig.setKill((signal) => {
    signals.push(signal);
    return true;
  });
  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await pending, { status: "clean" });
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/interrupt",
    ],
  );
  assert.deepEqual(requests[4], {
    jsonrpc: "2.0",
    id: 4,
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" },
  });
  assert.deepEqual(signals, []);
});

test("an ignored interrupt escalates from SIGTERM to SIGKILL", async () => {
  const signals: string[] = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const rig = sourceWith((request, child) => {
    if (request.method === "initialize")
      response(child, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(child, request.id as number, threadResult());
    if (request.method === "turn/start") {
      response(child, request.id as number, turnResult());
      ready();
    }
  });
  rig.setKill((signal) => {
    signals.push(signal);
    return true;
  });
  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await pending, { status: "clean" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("exit before semantic completion preserves exit diagnostics and survives bad stdout", async () => {
  const stderr: string[] = [];
  const rig = sourceWith((request, child) => {
    if (request.method === "initialize")
      response(child, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(child, request.id as number, threadResult());
    if (request.method === "turn/start") {
      response(child, request.id as number, turnResult());
      child.stdout.write("not json\n");
      child.stdout.write(
        `${JSON.stringify({ method: "item/started", params: {} })}\n`,
      );
      child.finish(7);
    }
  });
  const conclusion = await rig.source(
    sinkFor([], stderr),
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, {
    status: "failed",
    errorMessage: "Child codex exited with code 7",
  });
  assert.match(stderr.join(""), /Last stdout:/);
  assert.match(stderr.join(""), /not json/);
  assert.doesNotMatch(stderr.join(""), /thread-1|turn-1/);
});

test("a silent clean exit reports that no stdout was captured", async () => {
  const stderr: string[] = [];
  let child!: FakeChild;
  const source = codexAppServerSource({
    cwd: "/work",
    childDepth: 2,
    prompt: "prompt",
    spawn: () => {
      child = fakeChild(() => {});
      queueMicrotask(() => child.finish(0));
      return child as unknown as ChildProcess;
    },
  });
  assert.deepEqual(
    await source(sinkFor([], stderr), new AbortController().signal),
    { status: "clean" },
  );
  assert.deepEqual(stderr, ["No stdout was captured.\n"]);
});

test("server requests receive an error response and do not stop the run", async () => {
  const replies: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const rig = sourceWith((request, child) => {
    if (request.id === 99 && "error" in request) replies.push(request);
    if (request.method === "initialize")
      response(child, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(child, request.id as number, threadResult());
    if (request.method === "turn/start") {
      response(child, request.id as number, turnResult());
      child.stdout.write(
        `${JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} })}\n`,
      );
      child.stdout.write(`${JSON.stringify(completed())}\n`);
    }
  });
  const conclusion = await rig.source(
    sinkFor([], stderr),
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, { status: "clean" });
  assert.deepEqual(replies, [
    {
      jsonrpc: "2.0",
      id: 99,
      error: {
        code: -32601,
        message: "Method not supported by pi-subagent",
      },
    },
  ]);
  assert.match(stderr.join(""), /unsupported method/);
});
