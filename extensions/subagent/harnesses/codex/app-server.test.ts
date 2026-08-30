import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessSpawn } from "../../child-process.ts";
import type { OneShotSink } from "../../one-shot.ts";
import { DEPTH_ENV_KEY, type RunControl } from "../../run.ts";
import {
  type CodexAppServerEvent,
  type CodexAppServerOptions,
  CodexAppServerRequestError,
  CodexAppServerTransportError,
  runCodexAppServer,
} from "./app-server.ts";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal: string): boolean;
  finish(code: number | null): void;
  ignoreStdinEnd: boolean;
}

function fakeChild(
  onRequest: (request: Record<string, unknown>, child: FakeChild) => void,
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.ignoreStdinEnd = false;
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
  child.stdin.on("finish", () => {
    if (!child.ignoreStdinEnd) child.finish(0);
  });
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
  overrides: Partial<CodexAppServerOptions> = {},
  controls: AsyncIterable<RunControl> = (async function* () {})(),
) {
  let child: FakeChild | undefined;
  let replacementKill: ((signal: string) => boolean) | undefined;
  let ignoreStdinEnd = false;
  const spawn: ChildProcessSpawn = (_command, _args, options) => {
    assert.equal(options.cwd, "/work");
    assert.equal(options.env?.[DEPTH_ENV_KEY], "2");
    assert.equal(options.env?.PATH, process.env.PATH);
    child = fakeChild(handler);
    child.ignoreStdinEnd = ignoreStdinEnd;
    if (replacementKill) child.kill = replacementKill;
    return child as unknown as ChildProcess;
  };
  const source = (
    sink: OneShotSink<CodexAppServerEvent>,
    signal: AbortSignal,
  ) =>
    runCodexAppServer({
      cwd: "/work",
      childDepth: 2,
      prompt: "prompt",
      spawn,
      killEscalationMs: 5,
      ...overrides,
      translate: (event) => {
        const terminal = sink.event(event) === true;
        return {
          terminal: terminal || event.method === "turn/completed",
        };
      },
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: sink.stderr,
      },
      signal,
      controls,
      missingAnswerMessage: "missing answer",
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
    ignoreStdinEnd() {
      ignoreStdinEnd = true;
      if (child) child.ignoreStdinEnd = true;
    },
  };
}

test("a Control admitted before provider identity is known is retained for native turn steering", async (t) => {
  const requests: Record<string, unknown>[] = [];
  let initializeRequest: Record<string, unknown> | undefined;
  let controlTaken!: () => void;
  const taken = new Promise<void>((resolve) => {
    controlTaken = resolve;
  });
  let steerSent!: () => void;
  const steered = new Promise<void>((resolve) => {
    steerSent = resolve;
  });
  const controls = (async function* (): AsyncIterable<RunControl> {
    controlTaken();
    yield { type: "steer", text: "Use the indexed implementation." };
  })();
  const rig = sourceWith(
    (request, child) => {
      requests.push(request);
      if (request.method === "initialize") initializeRequest = request;
      if (request.method === "thread/start")
        response(child, request.id as number, threadResult());
      if (request.method === "turn/start")
        response(child, request.id as number, turnResult());
      if (request.method === "turn/steer") {
        response(child, request.id as number, {});
        steerSent();
        child.stdout.write(`${JSON.stringify(completed())}\n`);
      }
    },
    {},
    controls,
  );

  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  t.after(async () => {
    controller.abort();
    rig.child?.finish(0);
    await pending;
  });
  assert.equal(
    await Promise.race([
      taken.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]),
    true,
  );
  assert.equal(
    requests.some((request) => request.method === "turn/steer"),
    false,
  );
  assert.ok(initializeRequest && rig.child);
  response(rig.child, initializeRequest.id as number, initializeResult());
  await steered;

  const steer = requests.find((request) => request.method === "turn/steer");
  const steerParams = steer?.params as Record<string, unknown> | undefined;
  assert.equal(typeof steerParams?.clientUserMessageId, "string");
  assert.deepEqual(steer, {
    jsonrpc: "2.0",
    id: 4,
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        {
          type: "text",
          text: "Use the indexed implementation.",
          text_elements: [],
        },
      ],
      clientUserMessageId: steerParams?.clientUserMessageId,
    },
  });
  assert.deepEqual(await pending, { ending: "answered" });
});

test("multiple Controls are delivered serially in FIFO admission order", async () => {
  const steerRequests: Record<string, unknown>[] = [];
  let firstSent!: () => void;
  const first = new Promise<void>((resolve) => {
    firstSent = resolve;
  });
  let secondSent!: () => void;
  const second = new Promise<void>((resolve) => {
    secondSent = resolve;
  });
  const controls = (async function* (): AsyncIterable<RunControl> {
    yield { type: "steer", text: "first guidance" };
    yield { type: "steer", text: "second guidance" };
  })();
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize")
        response(child, request.id as number, initializeResult());
      if (request.method === "thread/start")
        response(child, request.id as number, threadResult());
      if (request.method === "turn/start")
        response(child, request.id as number, turnResult());
      if (request.method !== "turn/steer") return;
      steerRequests.push(request);
      if (steerRequests.length === 1) firstSent();
      if (steerRequests.length === 2) {
        response(child, request.id as number, {});
        secondSent();
        child.stdout.write(`${JSON.stringify(completed())}\n`);
      }
    },
    {},
    controls,
  );

  const pending = rig.source(sinkFor([], []), new AbortController().signal);
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(steerRequests.length, 1);
  const firstRequest = steerRequests[0];
  assert.ok(firstRequest);
  const firstParams = firstRequest.params as Record<string, unknown>;
  assert.equal(
    (firstParams.input as Array<Record<string, unknown>>)[0]?.text,
    "first guidance",
  );
  response(rig.child as FakeChild, firstRequest.id as number, {});
  await second;
  const secondRequest = steerRequests[1];
  assert.ok(secondRequest);
  const secondParams = secondRequest.params as Record<string, unknown>;
  assert.equal(
    (secondParams.input as Array<Record<string, unknown>>)[0]?.text,
    "second guidance",
  );
  assert.notEqual(
    firstParams.clientUserMessageId,
    secondParams.clientUserMessageId,
  );
  assert.deepEqual(await pending, { ending: "answered" });
});

test("a resumed active-Turn steering refusal is a bounded redacted diagnostic, not the Run ending", async () => {
  const stderr: string[] = [];
  const controls = (async function* (): AsyncIterable<RunControl> {
    yield { type: "steer", text: "review this" };
  })();
  const providerIdentity = {
    threadId: "secret-thread",
    turnId: "secret-turn",
    expectedTurnId: "secret-expected-turn",
    itemId: "secret-item",
    sessionId: "secret-session",
    clientId: "secret-client",
    clientUserMessageId: "secret-correlation",
    id: 99,
  };
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize")
        response(child, request.id as number, initializeResult());
      if (request.method === "thread/resume")
        response(child, request.id as number, threadResult());
      if (request.method === "turn/start")
        response(child, request.id as number, turnResult());
      if (request.method === "turn/steer") {
        child.stdout.write(
          `${JSON.stringify({
            id: request.id,
            error: {
              code: -32001,
              message: `cannot steer a review turn ${JSON.stringify(providerIdentity)}${"x".repeat(5000)}`,
              data: {
                codexErrorInfo: {
                  activeTurnNotSteerable: { turnKind: "review" },
                },
              },
            },
          })}\n`,
        );
        child.stdout.write(`${JSON.stringify(completed())}\n`);
      }
    },
    { continuationThreadId: "thread-1" },
    controls,
  );

  assert.deepEqual(
    await rig.source(sinkFor([], stderr), new AbortController().signal),
    { ending: "answered" },
  );
  assert.equal(stderr.length, 1);
  assert.match(
    stderr[0] ?? "",
    /^Steering rejected: cannot steer a review turn/,
  );
  assert.ok((stderr[0]?.length ?? 0) <= 1050);
  assert.doesNotMatch(
    stderr[0] ?? "",
    /secret-thread|secret-turn|secret-expected-turn|secret-item|secret-session|secret-client|secret-correlation/,
  );
});

const DETERMINISTIC_RACE_REPETITIONS = 32;

test("repeated resumed completion-before-Control settlement closes the pump and answers once", async () => {
  for (
    let iteration = 0;
    iteration < DETERMINISTIC_RACE_REPETITIONS;
    iteration++
  ) {
    const steerRequests: Record<string, unknown>[] = [];
    const rejections: Error[] = [];
    let pumpClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      pumpClosed = resolve;
    });
    const controls = (async function* (): AsyncIterable<RunControl> {
      try {
        yield { type: "steer", text: `first-${iteration}` };
        yield { type: "steer", text: `discarded-${iteration}` };
      } finally {
        pumpClosed();
      }
    })();
    const rig = sourceWith(
      (request, child) => {
        if (request.method === "initialize")
          response(child, request.id as number, initializeResult());
        if (request.method === "thread/resume")
          response(child, request.id as number, threadResult());
        if (request.method === "turn/start")
          response(child, request.id as number, turnResult());
        if (request.method === "turn/steer") {
          steerRequests.push(request);
          child.stdout.write(`${JSON.stringify(completed())}\n`);
        }
      },
      {
        continuationThreadId: "thread-1",
        onRequestRejection: (error) => rejections.push(error),
      },
      controls,
    );

    const pending = rig.source(sinkFor([], []), new AbortController().signal);
    assert.deepEqual(await pending, { ending: "answered" });
    await closed;
    assert.equal(steerRequests.length, 1);
    assert.equal(rejections.length, 1);
    assert.ok(rejections[0] instanceof CodexAppServerTransportError);
    assert.equal(rejections[0].reason, "semantic-settled");

    rig.child?.stdout.write(
      `${JSON.stringify({
        id: steerRequests[0]?.id,
        error: { code: 17, message: "late steering rejection" },
      })}\n`,
    );
    rig.child?.emit("close", 7, null);
    assert.deepEqual(await pending, { ending: "answered" });
    assert.equal(rejections.length, 1);
  }
});

test("repeated resumed cancellation-before-Control-response stays cancelled once", async () => {
  for (
    let iteration = 0;
    iteration < DETERMINISTIC_RACE_REPETITIONS;
    iteration++
  ) {
    const controller = new AbortController();
    let steerRequest: Record<string, unknown> | undefined;
    const rig = sourceWith(
      (request, child) => {
        if (request.method === "initialize")
          response(child, request.id as number, initializeResult());
        if (request.method === "thread/resume")
          response(child, request.id as number, threadResult());
        if (request.method === "turn/start")
          response(child, request.id as number, turnResult());
        if (request.method === "turn/steer") {
          steerRequest = request;
          controller.abort();
        }
        if (request.method === "turn/interrupt")
          child.stdout.write(`${JSON.stringify(completed("interrupted"))}\n`);
      },
      { continuationThreadId: "thread-1" },
      (async function* (): AsyncIterable<RunControl> {
        yield { type: "steer", text: `racing guidance ${iteration}` };
      })(),
    );

    const pending = rig.source(sinkFor([], []), controller.signal);
    assert.deepEqual(await pending, { ending: "cancelled" });
    assert.ok(steerRequest);
    rig.child?.stdout.write(
      `${JSON.stringify({ id: steerRequest.id, result: {} })}\n`,
    );
    rig.child?.stdout.write(
      `${JSON.stringify({
        id: steerRequest.id,
        error: { code: -32000, message: "late refusal" },
      })}\n`,
    );
    assert.deepEqual(await pending, { ending: "cancelled" });
  }
});

function sinkFor(
  events: CodexAppServerEvent[],
  stderr: string[],
): OneShotSink<CodexAppServerEvent> {
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
  const forwarded: CodexAppServerEvent[] = [];
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
          `${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 3, item: { type: "commandExecution", id: "item-1", command: "echo hi", cwd: "/work", status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null } }, emittedAtMs: 3 })}\n`,
        );
        child.stdout.write(`${JSON.stringify(completed())}\n`);
      }
    },
    { model: "gpt-test", effort: "none" },
  );

  const conclusion = await rig.source(
    sinkFor(forwarded, stderr),
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, { ending: "answered" });
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
      ephemeral: false,
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

test("App Server accepts schema-minimum notifications and normalizes optional fields", async () => {
  // Mirrors the generated protocol schema (codex-cli 0.150.1): the envelope
  // is method + params only (no emittedAtMs), and optional fields may be
  // absent. Rejecting these shapes would silently drop live notifications,
  // including the authoritative turn/completed settlement.
  const forwarded: CodexAppServerEvent[] = [];
  const stderr: string[] = [];
  const rig = sourceWith((request, child) => {
    if (request.method === "initialize")
      response(child, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(child, request.id as number, threadResult());
    if (request.method === "turn/start") {
      response(child, request.id as number, turnResult());
      const send = (value: unknown) =>
        child.stdout.write(`${JSON.stringify(value)}\n`);
      send({
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "building...\n",
        },
      });
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 10,
              inputTokens: 7,
              cachedInputTokens: 2,
              outputTokens: 2,
              reasoningOutputTokens: 1,
            },
            last: {
              totalTokens: 10,
              inputTokens: 7,
              cachedInputTokens: 2,
              outputTokens: 2,
              reasoningOutputTokens: 1,
            },
          },
        },
      });
      send({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: { message: "retryable" },
          willRetry: true,
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            itemsView: "notLoaded",
            items: [
              { type: "subAgentActivity", id: "future-item" },
              {
                type: "commandExecution",
                id: "item-1",
                command: "make build",
                cwd: "/work",
                status: "completed",
                commandActions: [],
              },
              { type: "reasoning", id: "item-2" },
            ],
          },
        },
      });
    }
  });

  const conclusion = await rig.source(
    sinkFor(forwarded, stderr),
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, { ending: "answered" });
  assert.deepEqual(forwarded, [
    {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "building...\n",
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 10,
            inputTokens: 7,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          last: {
            totalTokens: 10,
            inputTokens: 7,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          modelContextWindow: null,
        },
      },
    },
    {
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        error: {
          message: "retryable",
          codexErrorInfo: null,
          additionalDetails: null,
        },
        willRetry: true,
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [
            {
              type: "commandExecution",
              id: "item-1",
              command: "make build",
              cwd: "/work",
              status: "completed",
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
              commandActions: [],
            },
            { type: "reasoning", id: "item-2", summary: [], content: [] },
          ],
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    },
  ]);
  assert.deepEqual(stderr, []);
  rig.child?.emit("close", 0, null);
});

test("server request rejections preserve their JSON-RPC error", async () => {
  const rejections: Error[] = [];
  const data = {
    expectedTurnId: "turn-1",
    actualTurnId: "turn-2",
  };
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize")
        child.stdout.write(
          `${JSON.stringify({
            id: request.id,
            error: {
              code: -32042,
              message: "thread precondition failed",
              data,
            },
          })}\n`,
        );
      if (request.method === "initialize") {
        child.stdout.write(
          `${JSON.stringify({
            id: request.id,
            error: {
              code: -32043,
              message: "duplicate response must be ignored",
            },
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            id: 999,
            error: {
              code: -32044,
              message: "unknown response must be ignored",
            },
          })}\n`,
        );
      }
    },
    { onRequestRejection: (error) => rejections.push(error) },
  );

  assert.deepEqual(
    await rig.source(sinkFor([], []), new AbortController().signal),
    {
      ending: "failed",
      errorMessage: "thread precondition failed",
    },
  );
  const rejection = rejections[0];
  assert.ok(rejection instanceof CodexAppServerRequestError);
  assert.equal(rejection.kind, "server-request");
  assert.equal(rejection.code, -32042);
  assert.equal(rejection.message, "thread precondition failed");
  assert.deepEqual(rejection.data, data);
  assert.deepEqual(rejection.jsonRpcError, {
    code: -32042,
    message: "thread precondition failed",
    data,
  });
  assert.equal(rejections.length, 1);
});

test("invalid startup responses retain targeted operator diagnostics", async () => {
  const cases = [
    {
      stage: "initialize",
      message: "Codex App Server returned an invalid initialize response",
    },
    {
      stage: "thread/start",
      message: "Codex App Server returned an invalid thread/start response",
    },
    {
      stage: "turn/start",
      message: "Codex App Server returned an invalid turn/start response",
    },
  ] as const;

  for (const { stage, message } of cases) {
    const rig = sourceWith((request, child) => {
      if (request.method === "initialize")
        response(
          child,
          request.id as number,
          stage === "initialize" ? {} : initializeResult(),
        );
      if (request.method === "thread/start")
        response(
          child,
          request.id as number,
          stage === "thread/start" ? {} : threadResult(),
        );
      if (request.method === "turn/start")
        response(child, request.id as number, {});
    });

    assert.deepEqual(
      await rig.source(sinkFor([], []), new AbortController().signal),
      { ending: "failed", errorMessage: message },
    );
    rig.child?.emit("close", 0, null);
  }
});

test("spawn failures return a bounded redacted diagnostic", async () => {
  const secret = "thread-provider-secret";
  const conclusion = await runCodexAppServer({
    cwd: "/work",
    childDepth: 1,
    prompt: "prompt",
    spawn: () => {
      throw new Error(
        `spawn failed {"threadId":"${secret}"} ${"detail ".repeat(400)}`,
      );
    },
    translate: () => undefined,
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    missingAnswerMessage: "missing answer",
  });

  assert.equal(conclusion.ending, "failed");
  assert.ok(conclusion.errorMessage);
  assert.ok(conclusion.errorMessage.length <= 1024);
  assert.doesNotMatch(conclusion.errorMessage, new RegExp(secret));
  assert.match(conclusion.errorMessage, /"threadId":"\[redacted\]"/);
});

test("semantic settlement rejects pending requests as transport lifecycle cleanup", async () => {
  const rejections: Error[] = [];
  let turnStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    turnStarted = resolve;
  });
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize")
        response(child, request.id as number, initializeResult());
      if (request.method === "thread/start")
        response(child, request.id as number, threadResult());
      if (request.method === "turn/start") {
        response(child, request.id as number, turnResult());
        turnStarted();
      }
      if (request.method === "turn/interrupt")
        child.stdout.write(`${JSON.stringify(completed("interrupted"))}\n`);
    },
    { onRequestRejection: (error) => rejections.push(error) },
  );
  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.equal(rejections.length, 1);
  const rejection = rejections[0];
  assert.ok(rejection instanceof CodexAppServerTransportError);
  assert.equal(rejection.kind, "transport-lifecycle");
  assert.equal(rejection.reason, "semantic-settled");
  assert.equal(rejection.message, "Codex App Server transport settled");
});

test("pre-identity cancellation rejects each pending request once on child cleanup", async () => {
  const rejections: Error[] = [];
  const rig = sourceWith(() => {}, {
    onRequestRejection: (error) => rejections.push(error),
  });
  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.equal(rejections.length, 1);
  const rejection = rejections[0];
  assert.ok(rejection instanceof CodexAppServerTransportError);
  assert.equal(rejection.reason, "child-exited");
  assert.equal(
    rejection.message,
    "Codex App Server exited before its response",
  );

  rig.child?.stdout.write(
    `${JSON.stringify({
      id: 1,
      error: { code: -32045, message: "late response must be ignored" },
    })}\n`,
  );
  rig.child?.emit("close", 0, null);
  assert.equal(rejections.length, 1);
});

test("process failure classifies pending requests as transport settlement", async () => {
  const rejections: Error[] = [];
  const stderr: string[] = [];
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize")
        queueMicrotask(() => child.emit("error", new Error("transport broke")));
    },
    { onRequestRejection: (error) => rejections.push(error) },
  );

  assert.deepEqual(
    await rig.source(sinkFor([], stderr), new AbortController().signal),
    { ending: "failed" },
  );
  assert.deepEqual(stderr, ["transport broke\n"]);
  assert.equal(rejections.length, 1);
  const rejection = rejections[0];
  assert.ok(rejection instanceof CodexAppServerTransportError);
  assert.equal(rejection.reason, "transport-settled");
});

test("child exit rejects each pending request once as transport lifecycle cleanup", async () => {
  const rejections: Error[] = [];
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize") child.finish(7);
    },
    { onRequestRejection: (error) => rejections.push(error) },
  );

  assert.deepEqual(
    await rig.source(sinkFor([], []), new AbortController().signal),
    {
      ending: "failed",
      errorMessage: "Child codex exited with code 7",
    },
  );
  assert.equal(rejections.length, 1);
  const rejection = rejections[0];
  assert.ok(rejection instanceof CodexAppServerTransportError);
  assert.equal(rejection.reason, "child-exited");
  assert.equal(
    rejection.message,
    "Codex App Server exited before its response",
  );
  rig.child?.emit("close", 7, null);
  assert.equal(rejections.length, 1);
});

test("missing stdio fails only after child cleanup is complete", async () => {
  const signals: string[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin?: undefined;
    stdout: PassThrough;
    stderr: PassThrough;
    kill(signal: string): boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const pending = runCodexAppServer({
    cwd: "/work",
    childDepth: 2,
    prompt: "prompt",
    killEscalationMs: 5,
    spawn: () => child as unknown as ChildProcess,
    translate: () => undefined,
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    missingAnswerMessage: "missing answer",
  });

  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("close"), 1);

  child.emit("close", 0, null);
  assert.deepEqual(await pending, {
    ending: "failed",
    errorMessage: "Failed to open Codex App Server stdio pipes",
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("close"), 0);
});

test("abort before the turn id is known kills directly", async () => {
  const requests: Record<string, unknown>[] = [];
  const signals: string[] = [];
  const rig = sourceWith((request) => requests.push(request));
  rig.ignoreStdinEnd();
  rig.setKill((signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => rig.child?.finish(137));
    return true;
  });
  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    requests.some((request) => request.method === "turn/interrupt"),
    false,
  );
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
  assert.deepEqual(await pending, { ending: "cancelled" });
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
  assert.equal(rig.child?.stdin.writableEnded, true);
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
  rig.ignoreStdinEnd();
  rig.setKill((signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => rig.child?.finish(137));
    return true;
  });
  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(rig.child?.stdin.writableEnded, true);
});

test("semantic settlement completes unresponsive child escalation and removes listeners", async () => {
  const signals: string[] = [];
  const rig = sourceWith((request, child) => {
    if (request.method === "initialize")
      response(child, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(child, request.id as number, threadResult());
    if (request.method === "turn/start") {
      response(child, request.id as number, turnResult());
      child.stdout.write(`${JSON.stringify(completed())}\n`);
    }
  });
  rig.ignoreStdinEnd();
  rig.setKill((signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => rig.child?.finish(137));
    return true;
  });

  assert.deepEqual(
    await rig.source(sinkFor([], []), new AbortController().signal),
    { ending: "answered" },
  );
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(rig.child?.listenerCount("error"), 0);
  assert.equal(rig.child?.listenerCount("close"), 0);
  assert.equal(rig.child?.stdout.listenerCount("data"), 0);
  assert.equal(rig.child?.stderr.listenerCount("data"), 0);
  assert.equal(rig.child?.stdin.listenerCount("error"), 0);
});

test("repeated resumed cancellation racing process close finalizes once without retained work", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (
      let iteration = 0;
      iteration < DETERMINISTIC_RACE_REPETITIONS;
      iteration++
    ) {
      const signals: string[] = [];
      const rejections: Error[] = [];
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const rig = sourceWith(
        (request, child) => {
          if (request.method === "initialize")
            response(child, request.id as number, initializeResult());
          if (request.method === "thread/resume")
            response(child, request.id as number, threadResult());
          if (request.method === "turn/start") {
            response(child, request.id as number, turnResult());
            ready();
          }
        },
        {
          continuationThreadId: "thread-1",
          onRequestRejection: (error) => rejections.push(error),
        },
      );
      rig.setKill((signal) => {
        signals.push(signal);
        return true;
      });
      const controller = new AbortController();
      const pending = rig.source(sinkFor([], []), controller.signal);
      await started;
      controller.abort();
      rig.child?.emit("error", new Error("process raced cancellation"));
      rig.child?.finish(7);

      assert.deepEqual(await pending, { ending: "cancelled" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(signals, []);
      assert.equal(rejections.length, 1);
      assert.ok(rejections[0] instanceof CodexAppServerTransportError);
      assert.equal(
        (rejections[0] as CodexAppServerTransportError).reason,
        "transport-settled",
      );
      assert.equal(rig.child?.listenerCount("error"), 0);
      assert.equal(rig.child?.listenerCount("close"), 0);
      assert.equal(rig.child?.stdout.listenerCount("data"), 0);
      assert.equal(rig.child?.stderr.listenerCount("data"), 0);
      assert.equal(rig.child?.stdin.listenerCount("error"), 0);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
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
        `${JSON.stringify({
          method: "item/started",
          params: {
            threadId: "secret-thread",
            turnId: "secret-turn",
            expectedTurnId: "secret-expected-turn",
            itemId: "secret-item",
            sessionId: "secret-session",
            requestId: "secret-request",
            clientId: "secret-client",
            clientUserMessageId: "secret-correlation",
            id: 99,
          },
        })}\n`,
      );
      child.finish(7);
    }
  });
  const conclusion = await rig.source(
    sinkFor([], stderr),
    new AbortController().signal,
  );
  assert.deepEqual(conclusion, {
    ending: "failed",
    errorMessage: "Child codex exited with code 7",
  });
  assert.match(stderr.join(""), /Last stdout:/);
  assert.match(stderr.join(""), /not json/);
  assert.doesNotMatch(
    stderr.join(""),
    /thread-1|turn-1|secret-thread|secret-turn|secret-expected-turn|secret-item|secret-session|secret-request|secret-client|secret-correlation/,
  );
});

test("a trailing provider message and close are ordered before cancellation from reporting", async () => {
  const controller = new AbortController();
  const stderr: string[] = [];
  const rig = sourceWith((request, child) => {
    if (request.method === "initialize")
      response(child, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(child, request.id as number, threadResult());
    if (request.method === "turn/start") {
      response(child, request.id as number, turnResult());
      child.stdout.write(
        JSON.stringify({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              total: {
                totalTokens: 1,
                inputTokens: 1,
                cachedInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: 1,
                inputTokens: 1,
                cachedInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
              },
            },
          },
        }),
      );
      child.finish(7);
    }
  });

  assert.deepEqual(
    await rig.source(
      {
        event: () => {
          controller.abort();
          return undefined;
        },
        stderr: (chunk) => stderr.push(chunk),
      },
      controller.signal,
    ),
    { ending: "failed", errorMessage: "Child codex exited with code 7" },
  );
});

test("a silent clean exit reports that no stdout was captured", async () => {
  const stderr: string[] = [];
  let child!: FakeChild;
  const pending = runCodexAppServer({
    cwd: "/work",
    childDepth: 2,
    prompt: "prompt",
    spawn: () => {
      child = fakeChild(() => {});
      queueMicrotask(() => child.finish(0));
      return child as unknown as ChildProcess;
    },
    translate: () => undefined,
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: (chunk) => stderr.push(chunk),
    },
    missingAnswerMessage: "missing answer",
  });
  assert.deepEqual(await pending, {
    ending: "failed",
    errorMessage: "missing answer",
  });
  assert.deepEqual(stderr, ["No stdout was captured."]);
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
  assert.deepEqual(conclusion, { ending: "answered" });
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
