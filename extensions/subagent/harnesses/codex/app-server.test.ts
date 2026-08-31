import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type TestContext, test } from "node:test";
import {
  CONTROL_MAX_PENDING,
  type ControlSource,
  type ControlSourceOwner,
  createControlSource,
} from "../../control-source.ts";
import {
  DEPTH_ENV_KEY,
  type Fact,
  type RunControl,
  type RunReporter,
} from "../../run.ts";
import {
  type ChildProcessSpawn,
  type CodexAppServerEvent,
  CodexAppServerRequestError,
  type CodexAppServerSessionOptions,
  CodexAppServerTransportError,
  type CodexAppServerTurnOptions,
  createCodexAppServerSession,
} from "./app-server.ts";

interface EventSink<E> {
  event(event: E): boolean | undefined;
  stderr(chunk: string): void;
}

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
  return completedTurn("turn-1", status);
}

function completedTurn(turnId: string, status = "completed") {
  return {
    method: "turn/completed",
    emittedAtMs: 4,
    params: {
      threadId: "thread-1",
      turn: {
        id: turnId,
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

function useManualTimers(t: TestContext) {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  let scheduled = 0;
  let cleared = 0;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    _delay?: number,
    ...args: unknown[]
  ) => {
    scheduled++;
    const timer = {
      unref: () => timer,
    } as unknown as ReturnType<typeof setTimeout>;
    pending.set(timer, () => callback(...args));
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer) => {
    if (pending.delete(timer as ReturnType<typeof setTimeout>)) cleared++;
  }) as typeof clearTimeout;
  t.after(() => {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  });
  return {
    get scheduled() {
      return scheduled;
    },
    get cleared() {
      return cleared;
    },
    get pending() {
      return pending.size;
    },
    fireNext() {
      const next = pending.entries().next().value;
      assert.ok(next, "expected a pending timer");
      const [timer, callback] = next;
      pending.delete(timer);
      callback();
    },
  };
}

function controlsFrom(...controls: RunControl[]): ControlSource {
  const source = createControlSource();
  for (const control of controls)
    assert.equal(source.offer(control), "accepted");
  return source.controls;
}

function silentReporter(): RunReporter {
  return {
    message: () => {},
    transcript: () => {},
    activity: () => {},
    stderr: () => {},
  };
}

function assertProcessListenersReleased(child: FakeChild): void {
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
}

async function runCodexAppServer(
  options: CodexAppServerSessionOptions & CodexAppServerTurnOptions,
) {
  const {
    prompt,
    translate,
    report,
    signal,
    controls,
    missingAnswerMessage,
    ...sessionOptions
  } = options;
  const session = createCodexAppServerSession(sessionOptions);
  try {
    return await session.runNextTurn({
      prompt,
      translate,
      report,
      ...(signal ? { signal } : {}),
      ...(controls ? { controls } : {}),
      missingAnswerMessage,
    });
  } finally {
    await session.close();
  }
}

function sourceWith(
  handler: (request: Record<string, unknown>, child: FakeChild) => void,
  overrides: Partial<CodexAppServerSessionOptions> = {},
  controls: ControlSource = controlsFrom(),
) {
  let child: FakeChild | undefined;
  const messages: Fact[] = [];
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
  const source = (sink: EventSink<CodexAppServerEvent>, signal: AbortSignal) =>
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
        message: (fact) => messages.push(fact),
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
    messages,
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
  let steerSent!: () => void;
  const steered = new Promise<void>((resolve) => {
    steerSent = resolve;
  });
  const controls = controlsFrom({
    type: "steer",
    text: "Use the indexed implementation.",
  });
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

test("cancellation discards an earlier pre-identity Control and releases its source", async () => {
  const requests: Record<string, unknown>[] = [];
  const controlOwner = createControlSource();
  assert.equal(
    controlOwner.offer({ type: "steer", text: "early guidance" }),
    "accepted",
  );
  const rig = sourceWith(
    (request) => requests.push(request),
    {},
    controlOwner.controls,
  );
  const controller = new AbortController();

  const pending = rig.source(sinkFor([], []), controller.signal);
  controller.abort();

  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.equal(
    requests.some((request) => request.method === "turn/steer"),
    false,
  );
  assert.equal(
    controlOwner.offer({ type: "steer", text: "after cancellation" }),
    "closed",
  );
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
  const controls = controlsFrom(
    { type: "steer", text: "first guidance" },
    { type: "steer", text: "second guidance" },
  );
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

test("Controls waiting behind native steering retain bounded source admission", async () => {
  const controlOwner = createControlSource();
  const steerRequests: Record<string, unknown>[] = [];
  let secondSteerSent!: () => void;
  const secondSteer = new Promise<void>((resolve) => {
    secondSteerSent = resolve;
  });
  let activeTurnReady!: () => void;
  const activeTurn = new Promise<void>((resolve) => {
    activeTurnReady = resolve;
  });
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize")
        response(child, request.id as number, initializeResult());
      if (request.method === "thread/start")
        response(child, request.id as number, threadResult());
      if (request.method === "turn/start") {
        response(child, request.id as number, turnResult());
        activeTurnReady();
      }
      if (request.method === "turn/steer") {
        steerRequests.push(request);
        if (steerRequests.length === 2) secondSteerSent();
      }
      if (request.method === "turn/interrupt")
        child.stdout.write(`${JSON.stringify(completed("interrupted"))}\n`);
    },
    {},
    controlOwner.controls,
  );
  const controller = new AbortController();
  const pending = rig.source(sinkFor([], []), controller.signal);
  await activeTurn;

  assert.equal(
    controlOwner.offer({ type: "steer", text: "in flight" }),
    "accepted",
  );
  assert.equal(steerRequests.length, 1);
  for (let index = 0; index < CONTROL_MAX_PENDING; index++) {
    assert.equal(
      controlOwner.offer({ type: "steer", text: `waiting-${index}` }),
      "accepted",
    );
  }
  assert.equal(
    controlOwner.offer({ type: "steer", text: "over budget" }),
    "queue full",
  );

  const firstRequest = steerRequests[0];
  assert.ok(firstRequest && rig.child);
  response(rig.child, firstRequest.id as number, {});
  await secondSteer;
  assert.equal(steerRequests.length, 2);
  assert.equal(
    controlOwner.offer({ type: "steer", text: "released capacity" }),
    "accepted",
  );

  controller.abort();
  assert.deepEqual(await pending, { ending: "cancelled" });
});

test("an active-Turn steering refusal is a bounded redacted diagnostic, not the Run ending", async () => {
  const stderr: string[] = [];
  const controls = controlsFrom({ type: "steer", text: "review this" });
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
      if (request.method === "thread/start")
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
    {},
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

test("repeated completion-before-Control settlement closes reducer steering and answers once", async () => {
  for (
    let iteration = 0;
    iteration < DETERMINISTIC_RACE_REPETITIONS;
    iteration++
  ) {
    const steerRequests: Record<string, unknown>[] = [];
    const rejections: Error[] = [];
    const controlOwner: ControlSourceOwner = createControlSource();
    assert.equal(
      controlOwner.offer({ type: "steer", text: `first-${iteration}` }),
      "accepted",
    );
    assert.equal(
      controlOwner.offer({ type: "steer", text: `discarded-${iteration}` }),
      "accepted",
    );
    const rig = sourceWith(
      (request, child) => {
        if (request.method === "initialize")
          response(child, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(child, request.id as number, threadResult());
        if (request.method === "turn/start")
          response(child, request.id as number, turnResult());
        if (request.method === "turn/steer") {
          steerRequests.push(request);
          child.stdout.write(`${JSON.stringify(completed())}\n`);
        }
      },
      {
        onRequestRejection: (error) => rejections.push(error),
      },
      controlOwner.controls,
    );

    const pending = rig.source(sinkFor([], []), new AbortController().signal);
    assert.deepEqual(await pending, { ending: "answered" });
    assert.equal(
      controlOwner.offer({ type: "steer", text: "after settlement" }),
      "closed",
    );
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

test("repeated cancellation-before-Control-response stays cancelled once", async () => {
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
        if (request.method === "thread/start")
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
      {},
      controlsFrom({
        type: "steer",
        text: `racing guidance ${iteration}`,
      }),
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

test("provider-accepted steering remains correlated after cancellation until settlement", async () => {
  const controller = new AbortController();
  let steerRequest: Record<string, unknown> | undefined;
  let interruptRequest: Record<string, unknown> | undefined;
  const rig = sourceWith(
    (request, child) => {
      if (request.method === "initialize")
        response(child, request.id as number, initializeResult());
      if (request.method === "thread/start")
        response(child, request.id as number, threadResult());
      if (request.method === "turn/start")
        response(child, request.id as number, turnResult());
      if (request.method === "turn/steer") steerRequest = request;
      if (request.method === "turn/interrupt") interruptRequest = request;
    },
    {},
    controlsFrom({ type: "steer", text: "confirmed guidance" }),
  );

  const pending = rig.source(sinkFor([], []), controller.signal);
  assert.ok(steerRequest && rig.child);
  response(rig.child, steerRequest.id as number, {});
  controller.abort();
  assert.ok(interruptRequest);

  const clientId = (steerRequest.params as Record<string, unknown>)
    .clientUserMessageId;
  assert.equal(typeof clientId, "string");
  const item = {
    type: "userMessage",
    id: "provider-confirmed-steering",
    clientId,
    content: [
      {
        type: "text",
        text: "provider-confirmed guidance",
        text_elements: [],
      },
    ],
  };
  for (const method of ["item/started", "item/completed"]) {
    rig.child.stdout.write(
      `${JSON.stringify({
        method,
        emittedAtMs: 3,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          startedAtMs: 3,
          completedAtMs: 3,
          item,
        },
      })}\n`,
    );
  }
  rig.child.stdout.write(`${JSON.stringify(completed("interrupted"))}\n`);

  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.deepEqual(rig.messages, [
    {
      role: "user",
      parts: [{ type: "text", text: "provider-confirmed guidance" }],
    },
  ]);
});

async function proveControlAdmissionOrder(
  order: "control-first" | "cancellation-first",
): Promise<void> {
  for (
    let iteration = 0;
    iteration < DETERMINISTIC_RACE_REPETITIONS;
    iteration++
  ) {
    const methods: string[] = [];
    const controlOwner = createControlSource();
    let releaseTurn!: () => void;
    const activeTurnReady = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const rig = sourceWith(
      (request, child) => {
        if (request.method === "initialize")
          response(child, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(child, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(child, request.id as number, turnResult());
          releaseTurn();
        }
        if (
          request.method === "turn/steer" ||
          request.method === "turn/interrupt"
        )
          methods.push(request.method);
        if (request.method === "turn/interrupt")
          child.stdout.write(`${JSON.stringify(completed("interrupted"))}\n`);
      },
      {},
      controlOwner.controls,
    );
    const controller = new AbortController();
    const pending = rig.source(sinkFor([], []), controller.signal);
    await activeTurnReady;
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });

    if (order === "control-first") {
      assert.equal(
        controlOwner.offer({
          type: "steer",
          text: `guidance-${iteration}`,
        }),
        "accepted",
      );
      controller.abort();
    } else {
      controller.abort();
      assert.equal(
        controlOwner.offer({
          type: "steer",
          text: `too-late-${iteration}`,
        }),
        "closed",
      );
    }

    assert.deepEqual(await pending, { ending: "cancelled" });
    assert.deepEqual(
      methods,
      order === "control-first"
        ? ["turn/steer", "turn/interrupt"]
        : ["turn/interrupt"],
    );
  }
}

test("accepted Control before abort writes turn/steer before turn/interrupt", async () => {
  await proveControlAdmissionOrder("control-first");
});

test("abort-first writes turn/interrupt and no later turn/steer", async () => {
  await proveControlAdmissionOrder("cancellation-first");
});

function sinkFor(
  events: CodexAppServerEvent[],
  stderr: string[],
): EventSink<CodexAppServerEvent> {
  return {
    event: (event) => {
      events.push(event);
      return undefined;
    },
    stderr: (chunk) => stderr.push(chunk),
  };
}

test("closing an active App Server session cancels its Turn and releases the process", async (t) => {
  const timers = useManualTimers(t);
  const requests: Record<string, unknown>[] = [];
  const signals: string[] = [];
  const lifecycle: string[] = [];
  let child: FakeChild | undefined;
  let turnStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    turnStarted = resolve;
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          turnStarted();
        }
        if (request.method === "turn/interrupt") {
          lifecycle.push("interrupt");
          currentChild.stdout.write(
            `${JSON.stringify(completed("interrupted"))}\n`,
          );
        }
      });
      child.stdin.on("finish", () => lifecycle.push("stdin-end"));
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      return child as unknown as ChildProcess;
    },
    killEscalationMs: 5,
  });

  const ending = session.runNextTurn({
    prompt: "prompt",
    translate: (event) => ({
      terminal: event.method === "turn/completed",
    }),
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    missingAnswerMessage: "missing answer",
  });

  await ready;
  assert.ok(child);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.listenerCount("close"), 1);

  await session.close();
  assert.deepEqual(await ending, { ending: "cancelled" });
  assert.equal(
    requests.filter((request) => request.method === "turn/interrupt").length,
    1,
  );
  assert.deepEqual(signals, []);
  assert.deepEqual(lifecycle, ["interrupt", "stdin-end"]);
  assert.equal(timers.scheduled, 2);
  assert.equal(timers.cleared, 2);
  assert.equal(timers.pending, 0);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.listenerCount("close"), 0);
});

test("a clean Turn settles before its App Server session is closed", async () => {
  const requests: Record<string, unknown>[] = [];
  let child: FakeChild | undefined;
  let spawnCount = 0;
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      spawnCount++;
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          currentChild.stdout.write(`${JSON.stringify(completed())}\n`);
        }
      });
      return child as unknown as ChildProcess;
    },
    killEscalationMs: 5,
  });

  assert.deepEqual(
    await session.runNextTurn({
      prompt: "prompt",
      translate: (event) => ({
        terminal: event.method === "turn/completed",
      }),
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      missingAnswerMessage: "missing answer",
    }),
    { ending: "answered" },
  );

  assert.equal(spawnCount, 1);
  assert.equal(
    requests.filter((request) => request.method === "initialize").length,
    1,
  );
  assert.ok(child);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.listenerCount("close"), 1);

  await session.close();
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.listenerCount("close"), 0);
});

test("one ephemeral App Server session runs two isolated sequential Turns on one retained process", async (t) => {
  const requests: Record<string, unknown>[] = [];
  const reports: string[][] = [[], []];
  const timers = useManualTimers(t);
  let child: FakeChild | undefined;
  let spawnCount = 0;
  let closeCount = 0;
  let stdinFinishCount = 0;
  const signals: string[] = [];
  let secondTurnReady!: () => void;
  const secondTurnStarted = new Promise<void>((resolve) => {
    secondTurnReady = resolve;
  });

  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      spawnCount++;
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          const turnNumber = requests.filter(
            (candidate) => candidate.method === "turn/start",
          ).length;
          const turnId = `turn-${turnNumber}`;
          response(currentChild, request.id as number, {
            turn: { id: turnId },
          });
          if (turnNumber === 1)
            currentChild.stdout.write(
              `${JSON.stringify(completedTurn(turnId))}\n`,
            );
          else secondTurnReady();
        }
      });
      child.on("close", () => closeCount++);
      child.stdin.on("finish", () => stdinFinishCount++);
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      return child as unknown as ChildProcess;
    },
    killEscalationMs: 5,
  });
  const turnOptions = (index: number, prompt: string) => ({
    prompt,
    translate: (event: CodexAppServerEvent) => ({
      terminal: event.method === "turn/completed",
      facts:
        event.method === "turn/completed"
          ? [
              {
                role: "assistant" as const,
                parts: [{ type: "text" as const, text: event.params.turn.id }],
              },
            ]
          : [],
    }),
    report: {
      message: (fact: Fact) => {
        const text = fact.parts.find((part) => part.type === "text");
        if (text?.type === "text") reports[index]?.push(text.text);
      },
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    missingAnswerMessage: "missing answer",
  });

  const firstEnding = await session.runNextTurn(
    turnOptions(0, "first prompt only"),
  );
  assert.deepEqual(firstEnding, { ending: "answered" });
  const firstObservations = [...reports[0]];
  assert.deepEqual(firstObservations, ["turn-1"]);
  assert.equal(spawnCount, 1);
  assert.ok(child);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.stdout.listenerCount("data"), 1);
  assert.equal(child.listenerCount("close"), 2);

  let secondSettled = false;
  const second = session.runNextTurn(turnOptions(1, "second prompt only"));
  void second.then(() => {
    secondSettled = true;
  });
  await secondTurnStarted;

  const overlapping = await session.runNextTurn(
    turnOptions(1, "must not be sent"),
  );
  assert.deepEqual(overlapping, {
    ending: "failed",
    errorMessage: "Codex App Server session already has an active Turn",
  });
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    2,
  );

  child.stdout.write(`${JSON.stringify(completedTurn("turn-1"))}\n`);
  await Promise.resolve();
  assert.equal(secondSettled, false);
  assert.deepEqual(reports, [["turn-1"], []]);

  child.stdout.write(`${JSON.stringify(completedTurn("turn-2"))}\n`);
  const secondEnding = await second;
  assert.deepEqual(secondEnding, { ending: "answered" });
  assert.notStrictEqual(secondEnding, firstEnding);
  assert.deepEqual(firstEnding, { ending: "answered" });
  assert.deepEqual(reports, [["turn-1"], ["turn-2"]]);
  assert.deepEqual(firstObservations, ["turn-1"]);

  assert.equal(spawnCount, 1);
  assert.deepEqual(requests, [
    {
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
    },
    { method: "initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/work",
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "first prompt only", text_elements: [] }],
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [
          { type: "text", text: "second prompt only", text_elements: [] },
        ],
      },
    },
  ]);
  assert.deepEqual(
    requests
      .filter((request) => typeof request.id === "number")
      .map((request) => request.id),
    [1, 2, 3, 4],
  );
  assert.equal(
    requests.some((request) => request.method === "thread/resume"),
    false,
  );
  assert.equal(child.stdin.writableEnded, false);

  const firstClose = session.close();
  const secondClose = session.close();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  assert.equal(stdinFinishCount, 1);
  assert.equal(closeCount, 1);
  assert.deepEqual(signals, []);
  assert.equal(timers.scheduled, 1);
  assert.equal(timers.cleared, 1);
  assert.equal(timers.pending, 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("matching interrupted completion keeps the retained session resumable with fresh Turn state", async (t) => {
  const timers = useManualTimers(t);
  const requests: Record<string, unknown>[] = [];
  const reports: Fact[][] = [[], []];
  const signals: string[] = [];
  const firstControls = createControlSource();
  const controller = new AbortController();
  let child: FakeChild | undefined;
  let spawnCount = 0;
  let firstTurnReady!: () => void;
  const firstTurnStarted = new Promise<void>((resolve) => {
    firstTurnReady = resolve;
  });
  let turnStarts = 0;
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      spawnCount++;
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          turnStarts++;
          const turnId = `turn-${turnStarts}`;
          response(currentChild, request.id as number, {
            turn: { id: turnId },
          });
          if (turnStarts === 1) {
            currentChild.stdout.write(
              `${JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId,
                  completedAtMs: 1,
                  item: {
                    type: "agentMessage",
                    id: "partial-first",
                    text: "partial before cancellation",
                    phase: "commentary",
                  },
                },
              })}\n`,
            );
            firstTurnReady();
          } else {
            const steer = requests.find(
              (candidate) => candidate.method === "turn/steer",
            );
            const correlation = (
              steer?.params as Record<string, unknown> | undefined
            )?.clientUserMessageId;
            currentChild.stdout.write(
              `${JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId,
                  completedAtMs: 2,
                  item: {
                    type: "userMessage",
                    id: "stale-control",
                    clientId: correlation,
                    content: [{ type: "text", text: "stale guidance" }],
                  },
                },
              })}\n`,
            );
            currentChild.stdout.write(
              `${JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId,
                  completedAtMs: 3,
                  item: {
                    type: "agentMessage",
                    id: "later-answer",
                    text: "independent later answer",
                    phase: "final_answer",
                  },
                },
              })}\n`,
            );
            currentChild.stdout.write(
              `${JSON.stringify(completedTurn(turnId))}\n`,
            );
          }
        }
        if (request.method === "turn/interrupt") {
          response(currentChild, request.id as number, {});
          currentChild.stdout.write(
            `${JSON.stringify(completedTurn("turn-1", "interrupted"))}\n`,
          );
        }
      });
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });
  const options = (
    index: number,
    prompt: string,
    signal?: AbortSignal,
    controls: ControlSource = controlsFrom(),
  ) => ({
    prompt,
    translate: (event: CodexAppServerEvent) => ({
      terminal: event.method === "turn/completed",
      facts:
        event.method === "item/completed" &&
        event.params.item.type === "agentMessage"
          ? [
              {
                role: "assistant" as const,
                parts: [
                  { type: "text" as const, text: event.params.item.text },
                ],
              },
            ]
          : [],
    }),
    report: {
      message: (fact: Fact) => reports[index]?.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    ...(signal ? { signal } : {}),
    controls,
    missingAnswerMessage: "missing answer",
  });

  const first = session.runNextTurn(
    options(0, "first prompt", controller.signal, firstControls.controls),
  );
  await firstTurnStarted;
  assert.equal(
    firstControls.offer({ type: "steer", text: "sent before cancellation" }),
    "accepted",
  );
  assert.equal(
    firstControls.offer({ type: "steer", text: "discard when cancelled" }),
    "accepted",
  );
  controller.abort();

  const firstEnding = await first;
  assert.deepEqual(firstEnding, { ending: "cancelled" });
  assert.equal(spawnCount, 1);
  assert.ok(child);
  assert.equal(child.stdin.writableEnded, false);
  assert.deepEqual(signals, []);
  assert.equal(timers.pending, 0);
  assert.deepEqual(
    requests
      .filter(
        (request) =>
          request.method === "turn/steer" ||
          request.method === "turn/interrupt",
      )
      .map((request) => request.method),
    ["turn/steer", "turn/interrupt"],
  );
  assert.equal(
    firstControls.offer({ type: "steer", text: "too late" }),
    "closed",
  );
  assert.deepEqual(reports[0], [
    {
      role: "assistant",
      parts: [{ type: "text", text: "partial before cancellation" }],
    },
  ]);

  const secondEnding = await session.runNextTurn(
    options(1, "later prompt only"),
  );
  assert.deepEqual(secondEnding, { ending: "answered" });
  assert.notStrictEqual(secondEnding, firstEnding);
  assert.deepEqual(reports[0], [
    {
      role: "assistant",
      parts: [{ type: "text", text: "partial before cancellation" }],
    },
  ]);
  assert.deepEqual(reports[1], [
    {
      role: "assistant",
      parts: [{ type: "text", text: "independent later answer" }],
    },
  ]);
  assert.equal(spawnCount, 1);
  assert.deepEqual(
    requests
      .filter((request) => request.method === "turn/start")
      .map((request) => request.params),
    [
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "first prompt", text_elements: [] }],
      },
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "later prompt only", text_elements: [] }],
      },
    ],
  );

  await session.close();
  assert.deepEqual(signals, []);
  assert.equal(timers.scheduled, 2);
  assert.equal(timers.cleared, 2);
  assert.equal(timers.pending, 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("failure during cancellation makes terminal teardown supersede interruption before another Turn", async (t) => {
  const timers = useManualTimers(t);
  const requests: Record<string, unknown>[] = [];
  const signals: string[] = [];
  const controller = new AbortController();
  let child: FakeChild | undefined;
  let firstTurnReady!: () => void;
  const firstTurnStarted = new Promise<void>((resolve) => {
    firstTurnReady = resolve;
  });
  let turnStarts = 0;
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          turnStarts++;
          const turnId = `turn-${turnStarts}`;
          response(currentChild, request.id as number, {
            turn: { id: turnId },
          });
          if (turnStarts === 1) firstTurnReady();
          else
            currentChild.stdout.write(
              `${JSON.stringify(completedTurn(turnId))}\n`,
            );
        }
        if (request.method === "turn/interrupt")
          response(currentChild, request.id as number, {});
      });
      child.ignoreStdinEnd = true;
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => child?.finish(137));
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });

  const first = session.runNextTurn({
    prompt: "fail while cancellation is in flight",
    translate: (event) => {
      if (event.method === "item/completed")
        throw new Error("translation failed during cancellation");
      return undefined;
    },
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    signal: controller.signal,
    missingAnswerMessage: "missing answer",
  });

  await firstTurnStarted;
  controller.abort();
  assert.equal(timers.scheduled, 1);
  assert.equal(timers.pending, 1);
  assert.ok(child);
  child.stdout.write(
    `${JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1,
        item: {
          type: "agentMessage",
          id: "failure-trigger",
          text: "must not survive translation",
          phase: "commentary",
        },
      },
    })}\n`,
  );
  await assert.rejects(first, /translation failed during cancellation/);

  assert.deepEqual(
    await session.runNextTurn({
      prompt: "must not start after terminal teardown begins",
      translate: (event) => ({
        terminal: event.method === "turn/completed",
      }),
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      missingAnswerMessage: "missing answer",
    }),
    {
      ending: "failed",
      errorMessage: "Codex App Server session is closed",
    },
  );
  assert.equal(turnStarts, 1);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(timers.scheduled, 2);
  assert.equal(timers.cleared, 1);
  assert.equal(timers.pending, 1);

  const close = session.close();
  timers.fireNext();
  await close;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(timers.pending, 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("cancellation before initialization, thread, or Turn identity tears the session down boundedly", async (t) => {
  const timers = useManualTimers(t);
  for (const phase of ["initialize", "thread/start", "turn/start"] as const) {
    const requests: Record<string, unknown>[] = [];
    const rejections: Error[] = [];
    const signals: string[] = [];
    const controls = createControlSource();
    const controller = new AbortController();
    let child: FakeChild | undefined;
    let spawnCount = 0;
    let reachedPhase!: () => void;
    const ready = new Promise<void>((resolve) => {
      reachedPhase = resolve;
    });
    assert.equal(
      controls.offer({ type: "steer", text: `queued before ${phase}` }),
      "accepted",
    );
    const session = createCodexAppServerSession({
      cwd: "/work",
      childDepth: 2,
      onRequestRejection: (error) => rejections.push(error),
      spawn: () => {
        spawnCount++;
        child = fakeChild((request, currentChild) => {
          requests.push(request);
          if (request.method === phase) reachedPhase();
          if (request.method === "initialize" && phase !== "initialize")
            response(currentChild, request.id as number, initializeResult());
          if (request.method === "thread/start" && phase === "turn/start")
            response(currentChild, request.id as number, threadResult());
        });
        child.ignoreStdinEnd = true;
        child.kill = (signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") queueMicrotask(() => child?.finish(137));
          return true;
        };
        return child as unknown as ChildProcess;
      },
    });
    const pending = session.runNextTurn({
      prompt: `cancel during ${phase}`,
      translate: () => undefined,
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      signal: controller.signal,
      controls: controls.controls,
      missingAnswerMessage: "missing answer",
    });

    await ready;
    controller.abort();
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(timers.pending, 1);
    timers.fireNext();
    assert.deepEqual(await pending, { ending: "cancelled" });
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(timers.pending, 0);
    assert.equal(spawnCount, 1);
    assert.equal(
      requests.some((request) => request.method === "turn/interrupt"),
      false,
    );
    assert.equal(rejections.length, 1);
    assert.ok(rejections[0] instanceof CodexAppServerTransportError);
    assert.equal(
      (rejections[0] as CodexAppServerTransportError).reason,
      "child-exited",
    );
    assert.equal(
      controls.offer({ type: "steer", text: "must be closed" }),
      "closed",
    );

    const transcriptAfterCancellation = [...requests];
    assert.deepEqual(
      await session.runNextTurn({
        prompt: "must not restart",
        translate: () => undefined,
        report: {
          message: () => {},
          transcript: () => {},
          activity: () => {},
          stderr: () => {},
        },
        missingAnswerMessage: "missing answer",
      }),
      {
        ending: "failed",
        errorMessage: "Codex App Server session is closed",
      },
    );
    assert.deepEqual(requests, transcriptAfterCancellation);
    assert.equal(spawnCount, 1);

    const firstClose = session.close();
    const secondClose = session.close();
    assert.strictEqual(firstClose, secondClose);
    await firstClose;
    assert.ok(child);
    assert.equal(child.listenerCount("error"), 0);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stdin.listenerCount("error"), 0);
  }
  assert.equal(timers.scheduled, 3);
  assert.equal(timers.pending, 0);
});

test("idle session close escalates an ignored stdin shutdown through SIGTERM and SIGKILL", async (t) => {
  const timers = useManualTimers(t);
  const signals: string[] = [];
  let child: FakeChild | undefined;
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      child = fakeChild((request, currentChild) => {
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          currentChild.stdout.write(`${JSON.stringify(completed())}\n`);
        }
      });
      child.ignoreStdinEnd = true;
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => child?.finish(137));
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });

  assert.deepEqual(
    await session.runNextTurn({
      prompt: "finish before idle close",
      translate: (event) => ({
        terminal: event.method === "turn/completed",
      }),
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      missingAnswerMessage: "missing answer",
    }),
    { ending: "answered" },
  );
  assert.ok(child);
  assert.equal(child.stdin.writableEnded, false);

  const firstClose = session.close();
  const secondClose = session.close();
  assert.strictEqual(firstClose, secondClose);
  await Promise.resolve();
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(signals, []);
  assert.equal(timers.pending, 1);
  timers.fireNext();
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(timers.pending, 1);
  timers.fireNext();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await firstClose;

  assert.equal(timers.scheduled, 2);
  assert.equal(timers.pending, 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("active session close escalates an ignored semantic interrupt through SIGTERM and SIGKILL", async (t) => {
  const timers = useManualTimers(t);
  const requests: Record<string, unknown>[] = [];
  const rejections: Error[] = [];
  const signals: string[] = [];
  let child: FakeChild | undefined;
  let turnReady!: () => void;
  const started = new Promise<void>((resolve) => {
    turnReady = resolve;
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    onRequestRejection: (error) => rejections.push(error),
    spawn: () => {
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          turnReady();
        }
      });
      child.ignoreStdinEnd = true;
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => child?.finish(137));
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });
  const ending = session.runNextTurn({
    prompt: "active close",
    translate: () => undefined,
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: () => {},
    },
    missingAnswerMessage: "missing answer",
  });
  await started;

  const firstClose = session.close();
  const secondClose = session.close();
  assert.strictEqual(firstClose, secondClose);
  assert.deepEqual(signals, []);
  assert.equal(
    requests.filter((request) => request.method === "turn/interrupt").length,
    1,
  );
  assert.deepEqual(
    await session.runNextTurn({
      prompt: "admission is closed",
      translate: () => undefined,
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      missingAnswerMessage: "missing answer",
    }),
    {
      ending: "failed",
      errorMessage: "Codex App Server session is closed",
    },
  );
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    1,
  );
  assert.equal(timers.pending, 1);
  timers.fireNext();
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(timers.pending, 1);
  timers.fireNext();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  await firstClose;
  assert.deepEqual(await ending, { ending: "cancelled" });
  assert.equal(timers.scheduled, 2);
  assert.equal(timers.pending, 0);
  assert.equal(rejections.length, 1);
  assert.ok(rejections[0] instanceof CodexAppServerTransportError);
  assert.equal(
    (rejections[0] as CodexAppServerTransportError).reason,
    "child-exited",
  );
  assert.ok(child);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("retained session close is idempotent across cancellation, completion, process error, and process close races", async (t) => {
  const timers = useManualTimers(t);
  for (const race of [
    "cancellation",
    "completion",
    "process-error",
    "process-close",
  ] as const) {
    const controller = new AbortController();
    const requests: Record<string, unknown>[] = [];
    const signals: string[] = [];
    let child: FakeChild | undefined;
    let turnReady!: () => void;
    const started = new Promise<void>((resolve) => {
      turnReady = resolve;
    });
    const session = createCodexAppServerSession({
      cwd: "/work",
      childDepth: 2,
      spawn: () => {
        child = fakeChild((request, currentChild) => {
          requests.push(request);
          if (request.method === "initialize")
            response(currentChild, request.id as number, initializeResult());
          if (request.method === "thread/start")
            response(currentChild, request.id as number, threadResult());
          if (request.method === "turn/start") {
            response(currentChild, request.id as number, turnResult());
            turnReady();
          }
          if (request.method === "turn/interrupt" && race !== "process-close") {
            response(currentChild, request.id as number, {});
            currentChild.stdout.write(
              `${JSON.stringify(completed("interrupted"))}\n`,
            );
          }
        });
        child.kill = (signal) => {
          signals.push(signal);
          return true;
        };
        return child as unknown as ChildProcess;
      },
    });
    const ending = session.runNextTurn({
      prompt: race,
      translate: (event) => ({
        terminal: event.method === "turn/completed",
      }),
      report: {
        message: () => {},
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      signal: controller.signal,
      missingAnswerMessage: "missing answer",
    });
    await started;
    assert.ok(child);

    if (race === "cancellation") controller.abort();
    else if (race === "completion")
      child.stdout.write(`${JSON.stringify(completed())}\n`);
    else if (race === "process-error")
      child.emit("error", new Error("process failed during close"));
    else child.finish(7);

    const firstClose = session.close();
    const secondClose = session.close();
    assert.strictEqual(firstClose, secondClose);
    await firstClose;
    const result = await ending;
    assert.equal(
      result.ending,
      race === "completion"
        ? "answered"
        : race === "process-error"
          ? "failed"
          : "cancelled",
    );
    assert.equal(
      requests.filter((request) => request.method === "turn/interrupt").length,
      race === "cancellation" || race === "process-close" ? 1 : 0,
    );
    assert.deepEqual(signals, race === "process-error" ? ["SIGTERM"] : []);
    assert.equal(timers.pending, 0);
    assert.equal(child.listenerCount("error"), 0);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stdin.listenerCount("error"), 0);
  }
});

test("a terminal idle connection cannot re-handshake or replay a prior Turn Ending", async () => {
  const requests: Record<string, unknown>[] = [];
  let child: FakeChild | undefined;
  let spawnCount = 0;
  let connectionClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    connectionClosed = resolve;
  });
  const firstReports: string[] = [];
  const laterReports: string[] = [];
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      spawnCount++;
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          currentChild.stdout.write(`${JSON.stringify(completed())}\n`);
        }
      });
      child.on("close", connectionClosed);
      return child as unknown as ChildProcess;
    },
  });
  const options = (prompt: string, reports: string[]) => ({
    prompt,
    translate: (event: CodexAppServerEvent) => ({
      terminal: event.method === "turn/completed",
    }),
    report: {
      message: () => reports.push("message"),
      transcript: () => reports.push("transcript"),
      activity: () => reports.push("activity"),
      stderr: () => reports.push("stderr"),
    },
    missingAnswerMessage: `${prompt} missing answer`,
  });

  const firstEnding = await session.runNextTurn(options("first", firstReports));
  assert.deepEqual(firstEnding, { ending: "answered" });
  assert.equal(session.continuationAvailable, true);
  assert.ok(child);
  child.finish(17);
  await closed;
  assert.equal(session.continuationAvailable, false);

  const transcriptBeforeLaterTurn = [...requests];
  const laterEnding = await session.runNextTurn(options("later", laterReports));
  assert.deepEqual(laterEnding, {
    ending: "failed",
    errorMessage: "Codex App Server session is closed",
  });
  assert.notDeepEqual(laterEnding, firstEnding);
  assert.deepEqual(laterReports, []);
  assert.deepEqual(requests, transcriptBeforeLaterTurn);
  assert.equal(spawnCount, 1);
  assert.equal(
    requests.filter((request) => request.method === "initialize").length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "initialized").length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "thread/start").length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    1,
  );

  await session.close();
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("idle process error synchronously disables continuation and closes without replacement", async (t) => {
  const timers = useManualTimers(t);
  const requests: Record<string, unknown>[] = [];
  const signals: string[] = [];
  let child: FakeChild | undefined;
  let spawnCount = 0;
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: () => {
      spawnCount++;
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          currentChild.stdout.write(`${JSON.stringify(completed())}\n`);
        }
      });
      child.ignoreStdinEnd = true;
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => child?.finish(137));
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });
  const options = (prompt: string) => ({
    prompt,
    translate: (event: CodexAppServerEvent) => ({
      terminal: event.method === "turn/completed",
    }),
    report: silentReporter(),
    missingAnswerMessage: "missing answer",
  });

  assert.equal(session.continuationAvailable, true);
  assert.deepEqual(await session.runNextTurn(options("first")), {
    ending: "answered",
  });
  assert.equal(session.continuationAvailable, true);
  assert.ok(child);

  child.emit("error", new Error("idle App Server failed"));
  assert.equal(session.continuationAvailable, false);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(timers.pending, 1);

  const transcriptAfterLoss = [...requests];
  assert.deepEqual(await session.runNextTurn(options("must not replay")), {
    ending: "failed",
    errorMessage: "Codex App Server session is closed",
  });
  assert.deepEqual(requests, transcriptAfterLoss);
  assert.equal(spawnCount, 1);
  assert.equal(
    requests.some((request) => request.method === "thread/resume"),
    false,
  );

  const firstClose = session.close();
  const secondClose = session.close();
  assert.strictEqual(firstClose, secondClose);
  timers.fireNext();
  await firstClose;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(timers.pending, 0);
  assertProcessListenersReleased(child);
});

test("active process error fails once with partial output and settles pending steering", async () => {
  const requests: Record<string, unknown>[] = [];
  const rejections: Error[] = [];
  const reports: Fact[] = [];
  const stderr: string[] = [];
  const signals: string[] = [];
  const controls = createControlSource();
  let child: FakeChild | undefined;
  let turnReady!: () => void;
  const started = new Promise<void>((resolve) => {
    turnReady = resolve;
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    onRequestRejection: (error) => rejections.push(error),
    spawn: () => {
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          turnReady();
        }
      });
      child.ignoreStdinEnd = true;
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") queueMicrotask(() => child?.finish(1));
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });
  const ending = session.runNextTurn({
    prompt: "active process loss",
    translate: (event) => ({
      terminal: event.method === "turn/completed",
      facts:
        event.method === "item/completed" &&
        event.params.item.type === "agentMessage"
          ? [
              {
                role: "assistant" as const,
                parts: [
                  { type: "text" as const, text: event.params.item.text },
                ],
              },
            ]
          : [],
    }),
    report: {
      message: (fact) => reports.push(fact),
      transcript: () => {},
      activity: () => {},
      stderr: (chunk) => stderr.push(chunk),
    },
    controls: controls.controls,
    missingAnswerMessage: "missing answer",
  });

  await started;
  assert.equal(
    controls.offer({ type: "steer", text: "in flight at process loss" }),
    "accepted",
  );
  assert.equal(
    controls.offer({ type: "steer", text: "queued at process loss" }),
    "accepted",
  );
  assert.ok(child);
  child.stdout.write(
    `${JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1,
        item: {
          type: "agentMessage",
          id: "partial-item",
          text: "retained partial answer",
          phase: "commentary",
        },
      },
    })}\n`,
  );
  const identities = {
    threadId: "thread-secret",
    turnId: "turn-secret",
    itemId: "item-secret",
    requestId: "request-secret",
    sessionId: "session-secret",
    correlationId: "correlation-secret",
  };
  child.emit(
    "error",
    new Error(
      `active transport failed ${JSON.stringify(identities)} ${"detail ".repeat(400)}`,
    ),
  );
  child.emit("error", new Error("duplicate process error"));
  assert.equal(session.continuationAvailable, false);

  const result = await ending;
  assert.equal(result.ending, "failed");
  assert.ok(result.errorMessage);
  assert.ok(result.errorMessage.length <= 1024);
  for (const identity of Object.values(identities))
    assert.doesNotMatch(result.errorMessage, new RegExp(identity));
  assert.match(result.errorMessage, /"threadId":"\[redacted\]"/);
  assert.deepEqual(reports, [
    {
      role: "assistant",
      parts: [{ type: "text", text: "retained partial answer" }],
    },
  ]);
  assert.equal(stderr.length, 1);
  assert.equal(rejections.length, 1);
  assert.ok(rejections[0] instanceof CodexAppServerTransportError);
  assert.equal(
    (rejections[0] as CodexAppServerTransportError).reason,
    "transport-settled",
  );
  assert.equal(
    controls.offer({ type: "steer", text: "after process loss" }),
    "closed",
  );
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(
    requests.filter((request) => request.method === "turn/steer").length,
    1,
  );

  const transcriptAfterLoss = [...requests];
  assert.deepEqual(
    await session.runNextTurn({
      prompt: "must not replace lost conversation",
      translate: () => undefined,
      report: silentReporter(),
      missingAnswerMessage: "missing answer",
    }),
    {
      ending: "failed",
      errorMessage: "Codex App Server session is closed",
    },
  );
  assert.deepEqual(requests, transcriptAfterLoss);
  await session.close();
  assert.ok(child);
  assertProcessListenersReleased(child);
});

test("process loss during initialization or root-thread creation drains startup and disables continuation", async () => {
  for (const loss of [
    {
      phase: "initialize",
      kind: "error",
      expectedMessage: 'startup transport failed {"threadId":"[redacted]"}',
      rejectionReason: "transport-settled",
    },
    {
      phase: "thread/start",
      kind: "close",
      expectedMessage: "Child codex exited with code 12",
      rejectionReason: "child-exited",
    },
  ] as const) {
    const requests: Record<string, unknown>[] = [];
    const rejections: Error[] = [];
    const signals: string[] = [];
    let child: FakeChild | undefined;
    let spawnCount = 0;
    let phaseReady!: () => void;
    const reachedPhase = new Promise<void>((resolve) => {
      phaseReady = resolve;
    });
    const session = createCodexAppServerSession({
      cwd: "/work",
      childDepth: 2,
      onRequestRejection: (error) => rejections.push(error),
      spawn: () => {
        spawnCount++;
        child = fakeChild((request, currentChild) => {
          requests.push(request);
          if (request.method === loss.phase) phaseReady();
          if (request.method === "initialize" && loss.phase === "thread/start")
            response(currentChild, request.id as number, initializeResult());
        });
        child.ignoreStdinEnd = true;
        child.kill = (signal) => {
          signals.push(signal);
          if (signal === "SIGTERM") queueMicrotask(() => child?.finish(1));
          return true;
        };
        return child as unknown as ChildProcess;
      },
    });
    const ending = session.runNextTurn({
      prompt: `loss during ${loss.phase}`,
      translate: () => undefined,
      report: silentReporter(),
      missingAnswerMessage: "missing answer",
    });

    await reachedPhase;
    assert.equal(session.continuationAvailable, true);
    assert.ok(child);
    if (loss.kind === "error")
      child.emit(
        "error",
        new Error('startup transport failed {"threadId":"startup-secret"}'),
      );
    else child.emit("close", 12, null);
    assert.equal(session.continuationAvailable, false);

    assert.deepEqual(await ending, {
      ending: "failed",
      errorMessage: loss.expectedMessage,
    });
    assert.equal(rejections.length, 1);
    assert.ok(rejections[0] instanceof CodexAppServerTransportError);
    assert.equal(
      (rejections[0] as CodexAppServerTransportError).reason,
      loss.rejectionReason,
    );
    const transcriptAfterLoss = [...requests];
    assert.deepEqual(
      await session.runNextTurn({
        prompt: "must not restart startup",
        translate: () => undefined,
        report: silentReporter(),
        missingAnswerMessage: "missing answer",
      }),
      {
        ending: "failed",
        errorMessage: "Codex App Server session is closed",
      },
    );
    assert.deepEqual(requests, transcriptAfterLoss);
    assert.equal(spawnCount, 1);
    assert.equal(
      requests.some((request) => request.method === "thread/resume"),
      false,
    );

    const firstClose = session.close();
    const secondClose = session.close();
    assert.strictEqual(firstClose, secondClose);
    await firstClose;
    assert.deepEqual(signals, loss.kind === "error" ? ["SIGTERM"] : []);
    assertProcessListenersReleased(child);
  }
});

test("process close has one winner before or immediately after semantic completion", async () => {
  for (const order of ["close-first", "completion-first"] as const) {
    const requests: Record<string, unknown>[] = [];
    const reports: Fact[] = [];
    let child: FakeChild | undefined;
    let spawnCount = 0;
    let boundaryReady!: () => void;
    const reachedBoundary = new Promise<void>((resolve) => {
      boundaryReady = resolve;
    });
    const session = createCodexAppServerSession({
      cwd: "/work",
      childDepth: 2,
      spawn: () => {
        spawnCount++;
        child = fakeChild((request, currentChild) => {
          requests.push(request);
          if (request.method === "initialize")
            response(currentChild, request.id as number, initializeResult());
          if (request.method === "thread/start")
            response(currentChild, request.id as number, threadResult());
          if (request.method === "turn/start") {
            response(currentChild, request.id as number, turnResult());
            const text =
              order === "close-first" ? "partial before close" : "final answer";
            currentChild.stdout.write(
              `${JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  completedAtMs: 1,
                  item: {
                    type: "agentMessage",
                    id: `message-${order}`,
                    text,
                    phase:
                      order === "close-first" ? "commentary" : "final_answer",
                  },
                },
              })}\n`,
            );
            if (order === "completion-first")
              currentChild.stdout.write(`${JSON.stringify(completed())}\n`);
            boundaryReady();
          }
        });
        return child as unknown as ChildProcess;
      },
    });
    const ending = session.runNextTurn({
      prompt: order,
      translate: (event) => ({
        terminal:
          event.method === "item/completed" &&
          event.params.item.type === "agentMessage" &&
          event.params.item.phase === "final_answer",
        facts:
          event.method === "item/completed" &&
          event.params.item.type === "agentMessage"
            ? [
                {
                  role: "assistant" as const,
                  parts: [
                    { type: "text" as const, text: event.params.item.text },
                  ],
                },
              ]
            : [],
      }),
      report: {
        message: (fact) => reports.push(fact),
        transcript: () => {},
        activity: () => {},
        stderr: () => {},
      },
      missingAnswerMessage: "missing answer",
    });

    await reachedBoundary;
    assert.ok(child);
    child.emit("close", 9, null);
    assert.equal(session.continuationAvailable, false);
    assert.deepEqual(
      await ending,
      order === "close-first"
        ? {
            ending: "failed",
            errorMessage: "Child codex exited with code 9",
          }
        : { ending: "answered" },
    );
    assert.deepEqual(reports, [
      {
        role: "assistant",
        parts: [
          {
            type: "text",
            text:
              order === "close-first" ? "partial before close" : "final answer",
          },
        ],
      },
    ]);

    const transcriptAfterLoss = [...requests];
    assert.deepEqual(
      await session.runNextTurn({
        prompt: "no later Turn",
        translate: () => undefined,
        report: silentReporter(),
        missingAnswerMessage: "missing answer",
      }),
      {
        ending: "failed",
        errorMessage: "Codex App Server session is closed",
      },
    );
    assert.deepEqual(requests, transcriptAfterLoss);
    assert.equal(spawnCount, 1);

    const firstClose = session.close();
    const secondClose = session.close();
    assert.strictEqual(firstClose, secondClose);
    await firstClose;
    assertProcessListenersReleased(child);
  }
});

test("process-close diagnostics contain only the active retained Turn stdout", async () => {
  const priorRunSecret = "PRIOR_RUN_SECRET_MUST_NOT_CROSS_TURNS";
  const currentRunOutput = "CURRENT_RUN_LOCAL_STDOUT";
  const currentProviderItemId = "current-provider-item-secret";
  let turnNumber = 0;
  const child = fakeChild((request, currentChild) => {
    if (request.method === "initialize")
      response(currentChild, request.id as number, initializeResult());
    if (request.method === "thread/start")
      response(currentChild, request.id as number, threadResult());
    if (request.method !== "turn/start") return;

    turnNumber++;
    const turnId = `turn-${turnNumber}`;
    response(currentChild, request.id as number, { turn: { id: turnId } });
    if (turnNumber === 1) {
      currentChild.stdout.write(
        `${JSON.stringify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId,
            completedAtMs: 1,
            item: {
              type: "agentMessage",
              id: "prior-message",
              text: priorRunSecret,
              phase: "final_answer",
            },
          },
        })}\n`,
      );
      currentChild.stdout.write(`${JSON.stringify(completedTurn(turnId))}\n`);
      return;
    }

    currentChild.stdout.write(`${currentRunOutput}\n`);
    currentChild.stdout.write(
      `${JSON.stringify({
        method: "future/current-turn-notification",
        params: {
          threadId: "thread-1",
          turnId,
          itemId: currentProviderItemId,
        },
      })}\n`,
    );
    currentChild.finish(9);
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    spawn: (() => child) as unknown as ChildProcessSpawn,
  });
  const turnOptions = (prompt: string, stderr: string[]) => ({
    prompt,
    translate: (event: CodexAppServerEvent) => ({
      terminal: event.method === "turn/completed",
    }),
    report: {
      message: () => {},
      transcript: () => {},
      activity: () => {},
      stderr: (chunk: string) => stderr.push(chunk),
    },
    missingAnswerMessage: "missing answer",
  });
  const firstStderr: string[] = [];
  assert.deepEqual(
    await session.runNextTurn(turnOptions("first", firstStderr)),
    { ending: "answered" },
  );
  assert.deepEqual(firstStderr, []);

  const secondStderr: string[] = [];
  const secondEnding = await session.runNextTurn(
    turnOptions("second", secondStderr),
  );
  const secondDiagnostic = secondStderr.join("");
  assert.deepEqual(secondEnding, {
    ending: "failed",
    errorMessage: "Child codex exited with code 9",
  });
  assert.match(secondDiagnostic, /Last stdout:/);
  assert.match(secondDiagnostic, new RegExp(currentRunOutput));
  assert.doesNotMatch(secondDiagnostic, new RegExp(priorRunSecret));
  assert.doesNotMatch(JSON.stringify(secondEnding), new RegExp(priorRunSecret));
  assert.doesNotMatch(
    secondDiagnostic,
    /thread-1|turn-2|current-provider-item-secret/,
  );

  await session.close();
  assertProcessListenersReleased(child);
});

test("process close racing cancellation settles the interrupt waiter and cannot resume", async (t) => {
  const timers = useManualTimers(t);
  const requests: Record<string, unknown>[] = [];
  const rejections: Error[] = [];
  const signals: string[] = [];
  const controller = new AbortController();
  const controls = createControlSource();
  let child: FakeChild | undefined;
  let turnReady!: () => void;
  const started = new Promise<void>((resolve) => {
    turnReady = resolve;
  });
  const session = createCodexAppServerSession({
    cwd: "/work",
    childDepth: 2,
    onRequestRejection: (error) => rejections.push(error),
    spawn: () => {
      child = fakeChild((request, currentChild) => {
        requests.push(request);
        if (request.method === "initialize")
          response(currentChild, request.id as number, initializeResult());
        if (request.method === "thread/start")
          response(currentChild, request.id as number, threadResult());
        if (request.method === "turn/start") {
          response(currentChild, request.id as number, turnResult());
          turnReady();
        }
      });
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });
  const ending = session.runNextTurn({
    prompt: "cancel as process closes",
    translate: () => undefined,
    report: silentReporter(),
    signal: controller.signal,
    controls: controls.controls,
    missingAnswerMessage: "missing answer",
  });

  await started;
  assert.equal(
    controls.offer({ type: "steer", text: "discard on cancellation" }),
    "accepted",
  );
  controller.abort();
  assert.equal(
    requests.filter((request) => request.method === "turn/interrupt").length,
    1,
  );
  assert.equal(timers.pending, 1);
  assert.ok(child);
  child.emit("close", 7, null);
  assert.equal(session.continuationAvailable, false);

  assert.deepEqual(await ending, { ending: "cancelled" });
  assert.equal(rejections.length, 2);
  for (const rejection of rejections) {
    assert.ok(rejection instanceof CodexAppServerTransportError);
    assert.equal(rejection.reason, "child-exited");
  }
  assert.equal(timers.cleared, 1);
  assert.equal(timers.pending, 0);
  assert.deepEqual(signals, []);
  assert.equal(
    controls.offer({ type: "steer", text: "after terminal loss" }),
    "closed",
  );

  const transcriptAfterLoss = [...requests];
  assert.deepEqual(
    await session.runNextTurn({
      prompt: "must remain unsupported",
      translate: () => undefined,
      report: silentReporter(),
      missingAnswerMessage: "missing answer",
    }),
    {
      ending: "failed",
      errorMessage: "Codex App Server session is closed",
    },
  );
  assert.deepEqual(requests, transcriptAfterLoss);

  const firstClose = session.close();
  const secondClose = session.close();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  assert.deepEqual(signals, []);
  assertProcessListenersReleased(child);
});

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

test("spawn failures return a bounded redacted diagnostic without retaining teardown timers", async (t) => {
  const timers = useManualTimers(t);
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
  assert.equal(timers.scheduled, 0);
  assert.equal(timers.pending, 0);
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
    { ending: "failed", errorMessage: "transport broke" },
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

test("repeated cancellation racing process failure starts terminal teardown and finalizes once", async () => {
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
          if (request.method === "thread/start")
            response(child, request.id as number, threadResult());
          if (request.method === "turn/start") {
            response(child, request.id as number, turnResult());
            ready();
          }
        },
        {
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
      assert.deepEqual(signals, ["SIGTERM"]);
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
