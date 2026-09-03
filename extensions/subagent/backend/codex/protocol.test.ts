import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPTH_ENV_KEY } from "../depth.ts";
import { codexChildEnvironment, codexSpawnRequest } from "./process.ts";
import {
  CODEX_APPROVAL_POLICY,
  CODEX_CLIENT_INFO,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SANDBOX,
  decodeCodexItem,
  initializeParams,
  isCodexInitializeResult,
  readCodexNotification,
  readCodexThreadId,
  readCodexTurnId,
  threadStartParams,
  turnInterruptParams,
  turnStartParams,
  turnSteerParams,
} from "./protocol.ts";

/**
 * The protocol declarations, read against the shapes the spike recorded live.
 *
 * The payloads below are the ones from `docs/v2/spikes/codex-backend-api-risk.md`
 * and from v1's own fixtures, including the keys the live server stamps that
 * the schema never declared — `emittedAtMs` on a notification and `itemsView`
 * on a completion frame. A declaration that rejected those would reject every
 * real frame, which is why the decode is not exact-keyed here and is at the
 * observation seam instead.
 */

test("the initialize request introduces the client by name", () => {
  assert.deepEqual(initializeParams(), {
    clientInfo: CODEX_CLIENT_INFO,
    capabilities: null,
  });
  assert.equal(CODEX_CLIENT_INFO.name, "pi-subagent");
});

test("an initialize result is recognized by the four fields it documents", () => {
  assert.equal(
    isCodexInitializeResult({
      userAgent: "codex/0.150.1",
      codexHome: "/Users/x/.codex",
      platformFamily: "unix",
      platformOs: "darwin",
    }),
    true,
  );
  assert.equal(isCodexInitializeResult({ userAgent: "codex" }), false);
  assert.equal(isCodexInitializeResult(undefined), false);
});

test("a thread starts ephemeral, never-approving, and fully sandboxed", () => {
  // The posture is fixed regardless of what the Subagent's forwarded trust
  // value says. ADR-0009: a child runs non-interactively and cannot answer an
  // approval prompt, so an approving policy would be a child that hangs.
  assert.deepEqual(threadStartParams({ cwd: "/work" }), {
    cwd: "/work",
    ephemeral: true,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX,
  });
  assert.equal(CODEX_APPROVAL_POLICY, "never");
  assert.equal(CODEX_SANDBOX, "danger-full-access");
});

test("a pinned model and a mapped effort reach the thread parameters", () => {
  assert.deepEqual(threadStartParams({ cwd: "/work", model: "gpt-5.6" }), {
    cwd: "/work",
    ephemeral: true,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX,
    model: "gpt-5.6",
  });
  assert.deepEqual(threadStartParams({ cwd: "/work", effort: "none" }), {
    cwd: "/work",
    ephemeral: true,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX,
    config: { model_reasoning_effort: "none" },
  });
});

test("a Turn is started, steered, and interrupted with the ids it needs", () => {
  assert.deepEqual(turnStartParams("root", "do it"), {
    threadId: "root",
    input: [{ type: "text", text: "do it", text_elements: [] }],
  });
  // `expectedTurnId` is the protocol refusing guidance for the wrong Turn
  // before this adapter has to, and the client message id is the only thing
  // that can later confirm the guidance was read.
  assert.deepEqual(turnSteerParams("root", "turn-1", "also this", "cid-1"), {
    threadId: "root",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "also this", text_elements: [] }],
    clientUserMessageId: "cid-1",
  });
  assert.deepEqual(turnInterruptParams("root", "turn-1"), {
    threadId: "root",
    turnId: "turn-1",
  });
});

test("the root and turn ids are read from the responses that carry them", () => {
  assert.equal(readCodexThreadId({ thread: { id: "root-1" } }), "root-1");
  assert.equal(readCodexThreadId({ thread: {} }), undefined);
  assert.equal(readCodexTurnId({ turn: { id: "turn-1" } }), "turn-1");
  assert.equal(readCodexTurnId({}), undefined);
});

test("an undeclared method is ignored rather than rejected", () => {
  // Everything the spike saw and this adapter does not consume:
  for (const method of [
    "remoteControl/status/changed",
    "thread/started",
    "mcpServer/startupStatus/updated",
    "thread/status/changed",
    "turn/started",
    "account/rateLimits/updated",
  ]) {
    assert.deepEqual(
      readCodexNotification(method, { threadId: "root" }),
      { outcome: "ignored" },
      `${method} was not ignored`,
    );
  }
});

test("a declared method with a payload that does not fit is malformed", () => {
  assert.deepEqual(readCodexNotification("turn/completed", { turn: {} }), {
    outcome: "malformed",
    method: "turn/completed",
  });
  assert.deepEqual(
    readCodexNotification("thread/tokenUsage/updated", {
      threadId: "root",
      turnId: "turn-1",
      tokenUsage: { total: { totalTokens: 1.5 } },
    }),
    { outcome: "malformed", method: "thread/tokenUsage/updated" },
  );
});

test("an item frame carrying a variant this adapter does not read is ignored", () => {
  // Not malformed: the protocol carries item kinds for hook prompts and
  // sub-agent activity, and a frame about one produces no observation. v1
  // filtered them for exactly this reason.
  assert.deepEqual(
    readCodexNotification("item/started", {
      threadId: "root",
      turnId: "turn-1",
      startedAtMs: 1,
      item: { type: "todoList", id: "t1", items: [] },
    }),
    { outcome: "ignored" },
  );
});

test("an item frame keeps the undeclared keys the live server stamps out of the way", () => {
  const reading = readCodexNotification("item/completed", {
    threadId: "root",
    turnId: "turn-1",
    completedAtMs: 2,
    emittedAtMs: 3,
    item: {
      type: "agentMessage",
      id: "m1",
      text: "done",
      phase: "final_answer",
    },
  });

  assert.deepEqual(reading, {
    outcome: "notification",
    notification: {
      method: "item/completed",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "m1",
        text: "done",
        phase: "final_answer",
      },
    },
  });
});

test("the usage frame the spike recorded reads as a total, a last, and a window", () => {
  const reading = readCodexNotification("thread/tokenUsage/updated", {
    threadId: "root",
    turnId: "turn-1",
    tokenUsage: {
      total: {
        totalTokens: 16858,
        inputTokens: 16853,
        cachedInputTokens: 6912,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 16858,
        inputTokens: 16853,
        cachedInputTokens: 6912,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 272000,
    },
  });

  assert.equal(reading.outcome, "notification");
  if (reading.outcome !== "notification") return;
  const notification = reading.notification;
  assert.equal(notification.method, "thread/tokenUsage/updated");
  if (notification.method !== "thread/tokenUsage/updated") return;
  assert.equal(notification.total.totalTokens, 16858);
  assert.equal(notification.last.inputTokens, 16853);
  assert.equal(notification.contextWindow, 272000);
});

test("a completion frame keeps its status and drops the items it cannot read", () => {
  const reading = readCodexNotification("turn/completed", {
    threadId: "root",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: [],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      error: null,
      items: [
        { type: "agentMessage", id: "m1", text: "done" },
        { type: "todoList", id: "t1", items: [] },
      ],
    },
  });

  assert.equal(reading.outcome, "notification");
  if (reading.outcome !== "notification") return;
  const notification = reading.notification;
  assert.equal(notification.method, "turn/completed");
  if (notification.method !== "turn/completed") return;
  assert.equal(notification.status, "completed");
  assert.deepEqual(
    notification.items.map((item) => item.id),
    ["m1"],
  );
  assert.equal(notification.errorMessage, undefined);
});

test("an error frame keeps whether the provider will retry", () => {
  const retrying = readCodexNotification("error", {
    threadId: "root",
    turnId: "turn-1",
    willRetry: true,
    error: { message: "rate limited" },
  });
  assert.deepEqual(retrying, {
    outcome: "notification",
    notification: {
      method: "error",
      turnId: "turn-1",
      willRetry: true,
      errorMessage: "rate limited",
    },
  });
});

test("a command execution item reads with its command and its optional fields", () => {
  assert.deepEqual(
    decodeCodexItem({
      type: "commandExecution",
      id: "c1",
      command: "bash -lc ls",
      cwd: "/work",
      status: "completed",
      aggregatedOutput: "a\nb",
      exitCode: 0,
      durationMs: 12,
      processId: 9999,
      commandActions: [{ type: "read", command: "ls" }],
    }),
    {
      type: "commandExecution",
      id: "c1",
      command: "bash -lc ls",
      cwd: "/work",
      status: "completed",
      aggregatedOutput: "a\nb",
      exitCode: 0,
      durationMs: 12,
      commandActions: [{ type: "read", command: "ls" }],
    },
  );
});

test("the declared method list is what the drift check has to cover", () => {
  assert.deepEqual(
    [...CODEX_NOTIFICATION_METHODS],
    [
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/reasoning/summaryTextDelta",
      "thread/tokenUsage/updated",
      "turn/completed",
      "error",
    ],
  );
});

test("the child environment is the operator's, plus the depth key", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x", EMPTY: undefined };

  const env = codexChildEnvironment(1, base);

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/x",
    [DEPTH_ENV_KEY]: "1",
  });
});

test("building the spawn request does not mutate the process environment", () => {
  const before = process.env[DEPTH_ENV_KEY];

  const request = codexSpawnRequest("/work", 2, { PATH: "/usr/bin" });

  assert.deepEqual(request, {
    command: "codex",
    args: ["app-server"],
    cwd: "/work",
    env: { PATH: "/usr/bin", [DEPTH_ENV_KEY]: "2" },
  });
  assert.equal(process.env[DEPTH_ENV_KEY], before);
});
