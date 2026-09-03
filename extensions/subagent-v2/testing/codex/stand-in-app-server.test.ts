import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CodexChildProcess,
  CodexProcessExit,
} from "../../backend/codex/index.ts";
import {
  CODEX_STAND_IN_ROOT,
  type CodexStandInOptions,
  createStandInAppServer,
} from "./stand-in-app-server.ts";

/**
 * The stand-in App Server, tested on its own.
 *
 * A test double that is wrong is worse than no double at all: every Codex test
 * in this lane believes what this thing says about what the adapter wrote, so
 * the double's own behaviour is asserted here rather than assumed. It is
 * driven through the `CodexChildProcess` interface the adapter is written
 * against — the same nine members, no adapter involved — so what these tests
 * exercise is exactly what the adapter will see.
 */

interface Driven {
  readonly child: CodexChildProcess;
  readonly lines: () => readonly string[];
  readonly frames: () => readonly Record<string, unknown>[];
  readonly stderr: () => readonly string[];
  readonly exit: () => CodexProcessExit | undefined;
  readonly standIn: ReturnType<typeof createStandInAppServer>;
}

/** Spawn the stand-in and collect everything it writes. */
function drive(options: CodexStandInOptions = {}): Driven {
  const standIn = createStandInAppServer(options);
  const child = standIn.spawn({
    command: "codex",
    args: ["app-server"],
    cwd: "/work",
    env: {},
  });
  const lines: string[] = [];
  const stderr: string[] = [];
  let exit: CodexProcessExit | undefined;
  child.onStdout((chunk) => lines.push(chunk));
  child.onStderr((chunk) => stderr.push(chunk));
  child.onExit((received) => {
    exit = received;
  });
  return {
    child,
    standIn,
    lines: () => [...lines],
    frames: () =>
      lines
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    stderr: () => [...stderr],
    exit: () => exit,
  };
}

function send(child: CodexChildProcess, value: unknown): boolean {
  return child.write(`${JSON.stringify(value)}\n`);
}

/** One frame, or a failure naming what was missing rather than a type error. */
function frameAt(
  frames: readonly Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  const frame = frames[index];
  if (frame === undefined) {
    throw new Error(`the stand-in wrote no frame at index ${index}`);
  }
  return frame;
}

/** A nested object on a frame, checked rather than asserted. */
function nested(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const held = value?.[key];
  if (typeof held !== "object" || held === null || Array.isArray(held)) {
    throw new Error(`the frame carried no '${key}' object`);
  }
  return held as Record<string, unknown>;
}

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

test("a spawn that is told to fail throws, as a missing binary does", () => {
  const standIn = createStandInAppServer({ spawnFails: true });

  assert.throws(() =>
    standIn.spawn({ command: "codex", args: [], cwd: "/work", env: {} }),
  );
  assert.equal(standIn.record().spawns, 1);
});

test("the spawn request is recorded, so the environment can be asserted", () => {
  const standIn = createStandInAppServer();

  standIn.spawn({
    command: "codex",
    args: ["app-server"],
    cwd: "/work",
    env: { PI_SUBAGENT_DEPTH: "1" },
  });

  assert.deepEqual(standIn.record().requests, [
    {
      command: "codex",
      args: ["app-server"],
      cwd: "/work",
      env: { PI_SUBAGENT_DEPTH: "1" },
    },
  ]);
});

test("initialize, thread start, and turn start are answered in order", () => {
  const driven = drive({ scripts: [{ turnId: "turn-a" }] });

  send(driven.child, INITIALIZE);
  send(driven.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/start",
    params: { cwd: "/work" },
  });
  send(driven.child, {
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: { threadId: "root" },
  });

  assert.deepEqual(
    driven.frames().map((frame) => frame.id),
    [1, 2, 3],
  );
  const frames = driven.frames();
  assert.equal(nested(frameAt(frames, 0), "result").platformOs, "darwin");
  assert.deepEqual(nested(frameAt(frames, 1), "result").thread, {
    id: CODEX_STAND_IN_ROOT,
  });
  assert.deepEqual(nested(frameAt(frames, 2), "result").turn, {
    id: "turn-a",
  });
  const record = driven.standIn.record();
  assert.deepEqual(record.methods, [
    "initialize",
    "thread/start",
    "turn/start",
  ]);
  assert.deepEqual(
    record.writes.map((write) => write.id),
    [1, 2, 3],
  );
  assert.deepEqual(record.turnIds, ["turn-a"]);
  assert.deepEqual(record.threadParameters, { cwd: "/work" });
});

test("a hung request is recorded and never answered", () => {
  const driven = drive({ hangInitialize: true });

  send(driven.child, INITIALIZE);

  assert.deepEqual(driven.frames(), []);
  assert.deepEqual(driven.standIn.record().methods, ["initialize"]);
});

test("a refused request answers with a JSON-RPC error", () => {
  const driven = drive({ refuseThreadStart: true });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "thread/start",
    params: {},
  });

  assert.equal(nested(frameAt(driven.frames(), 0), "error").code, -32000);
});

test("a Turn's scripted frames are written the moment it is named", () => {
  const driven = drive({
    scripts: [
      {
        turnId: "turn-a",
        frames: [
          {
            frame: "item-started",
            item: { kind: "command", id: "c1", command: "ls" },
          },
          { frame: "output-delta", itemId: "c1", delta: "a\n" },
          { frame: "reasoning-delta", itemId: "r1", delta: "thinking" },
          { frame: "message-delta", itemId: "m1", delta: "hello" },
          {
            frame: "item-completed",
            item: { kind: "agentMessage", id: "m1", text: "hello" },
          },
          { frame: "usage", total: { totalTokens: 10 }, window: 100 },
          { frame: "error", message: "slow down", willRetry: true },
          { frame: "completed" },
        ],
      },
    ],
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  const methods = driven
    .frames()
    .map((frame) => frame.method)
    .filter((method): method is string => typeof method === "string");
  assert.deepEqual(methods, [
    "item/started",
    "item/commandExecution/outputDelta",
    "item/reasoning/summaryTextDelta",
    "item/agentMessage/delta",
    "item/completed",
    "thread/tokenUsage/updated",
    "error",
    "turn/completed",
  ]);
  // Every Turn-related frame carries the turn id, which is what the adapter's
  // demultiplexer routes on.
  for (const frame of driven.frames()) {
    if (frame.method === undefined) continue;
    const params = nested(frame, "params");
    const turnId =
      frame.method === "turn/completed"
        ? nested(params, "turn").id
        : params.turnId;
    assert.equal(turnId, "turn-a");
  }
});

test("a script that holds waits for the test rather than for time", () => {
  const driven = drive({
    scripts: [
      {
        frames: [
          {
            frame: "item-completed",
            item: { kind: "agentMessage", id: "m1", text: "part" },
          },
          { frame: "hold" },
          { frame: "completed" },
        ],
      },
    ],
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });
  assert.equal(
    driven.frames().some((frame) => frame.method === "turn/completed"),
    false,
  );

  driven.standIn.resume();

  assert.equal(
    driven.frames().some((frame) => frame.method === "turn/completed"),
    true,
  );
});

test("an accepted steer is recorded and echoed with its client id", () => {
  const driven = drive({ scripts: [{ turnId: "turn-a" }] });
  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "turn/steer",
    params: {
      threadId: "root",
      expectedTurnId: "turn-a",
      input: [{ type: "text", text: "also this" }],
      clientUserMessageId: "cid-1",
    },
  });

  const record = driven.standIn.record();
  assert.deepEqual(record.steers, ["also this"]);
  assert.deepEqual(record.steerTurnIds, ["turn-a"]);
  const echo = driven
    .frames()
    .find((frame) => frame.method === "item/completed");
  assert.equal(nested(nested(echo, "params"), "item").clientId, "cid-1");
});

test("a refused steer answers with an error and echoes nothing", () => {
  const driven = drive({
    scripts: [{ turnId: "turn-a" }],
    steerPolicies: ["refuse"],
  });
  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "turn/steer",
    params: {
      clientUserMessageId: "cid-1",
      input: [{ type: "text", text: "no" }],
    },
  });

  const answers = driven.frames().filter((frame) => frame.id === 2);
  assert.equal(answers.length, 1);
  assert.ok(nested(frameAt(answers, 0), "error"));
  assert.equal(
    driven.frames().some((frame) => frame.method === "item/completed"),
    false,
  );
});

test("a hung steer is counted as unanswered, which is what concurrency means", () => {
  const driven = drive({
    scripts: [{ turnId: "turn-a" }],
    steerPolicies: ["hang"],
  });
  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "turn/steer",
    params: {
      clientUserMessageId: "cid-1",
      input: [{ type: "text", text: "wait" }],
    },
  });

  assert.equal(driven.standIn.record().maxConcurrentSteers, 1);
  assert.equal(
    driven.frames().some((frame) => frame.id === 2),
    false,
  );
});

test("an interrupt either completes the Turn or is ignored", () => {
  const cooperative = drive({ scripts: [{ turnId: "turn-a" }] });
  send(cooperative.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });
  send(cooperative.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "turn/interrupt",
    params: {},
  });
  const completion = cooperative
    .frames()
    .find((frame) => frame.method === "turn/completed");
  assert.equal(
    nested(nested(completion, "params"), "turn").status,
    "interrupted",
  );

  const stubborn = drive({
    scripts: [{ turnId: "turn-a" }],
    onInterrupt: "ignore",
  });
  send(stubborn.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });
  send(stubborn.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "turn/interrupt",
    params: {},
  });
  assert.equal(
    stubborn.frames().some((frame) => frame.method === "turn/completed"),
    false,
  );
});

test("a client-bound request is issued, and the answer to it is recorded", () => {
  const driven = drive({
    scripts: [
      { frames: [{ frame: "server-request", method: "elicitation/create" }] },
    ],
  });
  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  const issued = driven
    .frames()
    .find((frame) => frame.method === "elicitation/create");
  assert.ok(issued);
  assert.equal(driven.standIn.record().serverRequests, 1);
  assert.equal(driven.standIn.record().serverRequestAnswers, 0);

  send(driven.child, {
    jsonrpc: "2.0",
    id: issued.id,
    error: { code: -32601, message: "Method not supported by pi-subagent" },
  });

  assert.equal(driven.standIn.record().serverRequestAnswers, 1);
});

test("stderr and a raw line are written without going through a builder", () => {
  const driven = drive({
    scripts: [
      {
        frames: [
          { frame: "stderr", text: "warning: thread root-1 is busy\n" },
          {
            frame: "raw",
            line: '{"method":"thread/status/changed","params":{}}',
          },
        ],
      },
    ],
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  assert.deepEqual(driven.stderr(), ["warning: thread root-1 is busy\n"]);
  assert.deepEqual(
    driven.frames().map((frame) => frame.method),
    [undefined, "thread/status/changed"],
  );
});

test("an over-long line is written with no newline to end it", () => {
  const driven = drive({
    scripts: [{ frames: [{ frame: "oversized", length: 64 }] }],
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  const written = driven.lines().join("");
  assert.equal(written.includes("\n"), true, "the turn/start response ended");
  const trailing = written.slice(written.lastIndexOf("\n") + 1);
  assert.equal(trailing.length, 64);
  assert.equal(trailing.includes("\n"), false);
});

test("a spontaneous exit mid-Turn is observable with its code and signal", () => {
  const driven = drive({
    scripts: [
      {
        frames: [
          {
            frame: "item-completed",
            item: { kind: "agentMessage", id: "m1", text: "half" },
          },
          { frame: "exit", code: null, signal: "SIGKILL" },
          // Never reached: nothing follows an exit.
          { frame: "completed" },
        ],
      },
    ],
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  assert.deepEqual(driven.exit(), { code: null, signal: "SIGKILL" });
  assert.equal(driven.standIn.alive(), false);
  assert.equal(
    driven.frames().some((frame) => frame.method === "turn/completed"),
    false,
  );
});

test("a request issued after the exit is recorded but never answered", () => {
  const driven = drive();
  driven.standIn.exitNow({ code: 1, signal: null });

  const accepted = send(driven.child, INITIALIZE);

  assert.equal(accepted, false);
  assert.deepEqual(driven.frames(), []);
  assert.deepEqual(driven.standIn.record().methods, []);
});

test("ending stdin ends the process, which is the spike's happy path", () => {
  const driven = drive();

  driven.child.endStdin();

  assert.equal(driven.standIn.record().stdinEnded, true);
  assert.deepEqual(driven.exit(), { code: 0, signal: null });
});

test("a stand-in told to ignore stdin's end stays alive for the escalation", () => {
  const driven = drive({ ignoreStdinEnd: true, ignoreSigterm: true });

  driven.child.endStdin();
  assert.equal(driven.standIn.alive(), true);

  driven.child.kill("SIGTERM");
  assert.equal(driven.standIn.alive(), true);

  driven.child.kill("SIGKILL");

  assert.deepEqual(driven.standIn.record().signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(driven.exit(), { code: null, signal: "SIGKILL" });
});

test("an ordinary stand-in exits on SIGTERM", () => {
  const driven = drive({ ignoreStdinEnd: true });

  driven.child.kill("SIGTERM");

  assert.deepEqual(driven.exit(), { code: null, signal: "SIGTERM" });
});

test("a paused stdout holds its lines until it is resumed", () => {
  const driven = drive({ scripts: [{ turnId: "turn-a" }] });
  driven.child.pauseStdout();

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });
  assert.deepEqual(driven.lines(), []);

  driven.child.resumeStdout();

  assert.equal(driven.frames().length, 1);
});

test("a frame can be written for a turn nobody is listening to", () => {
  const driven = drive({
    scripts: [
      {
        turnId: "turn-a",
        frames: [
          {
            frame: "for-turn",
            turnId: "turn-somewhere-else",
            item: { kind: "agentMessage", id: "m9", text: "stale" },
          },
        ],
      },
    ],
  });

  send(driven.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {},
  });

  const stale = driven
    .frames()
    .find((frame) => frame.method === "item/completed");
  assert.equal(nested(stale, "params").turnId, "turn-somewhere-else");
});
