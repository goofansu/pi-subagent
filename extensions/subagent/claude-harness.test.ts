import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildClaudeOptions,
  type ClaudeQuery,
  createClaudeHarness,
  resolveClaudeModel,
  translateClaudeMessage,
} from "./claude-harness.ts";
import { createHarnessRegistry } from "./harness.ts";
import { getFinalOutput } from "./messages.ts";
import type { SubagentTask } from "./run.ts";
import { startSubagent } from "./runner.ts";
import { createSubagentRuns } from "./runs.ts";
import type { AgentConfig } from "./types.ts";
import { renderRunLines } from "./widget.ts";

const config: AgentConfig = {
  name: "worker",
  description: "worker",
  harness: "claude",
  fields: { model: "sonnet", effort: "high", appendSystemPrompt: true },
  systemPrompt: "Be useful.",
};
const task: SubagentTask = {
  config,
  description: "task",
  prompt: "do it",
  cwd: "/work",
  childDepth: 1,
  projectTrusted: false,
};

test("Claude aliases and thinking budgets stay inside the adapter", () => {
  assert.equal(resolveClaudeModel("sonnet"), "claude-sonnet-4-6");
  assert.deepEqual(
    buildClaudeOptions(
      task,
      resolveClaudeModel("sonnet"),
      "high",
      new AbortController(),
    ).thinking,
    { type: "enabled", budgetTokens: 8192 },
  );
});

test("Claude validation accepts aliases and full model ids", () => {
  const harness = createClaudeHarness();
  for (const alias of ["opus", "sonnet", "haiku"]) {
    assert.deepEqual(
      harness.validate(
        { ...config, fields: { model: alias } },
        `/agents/${alias}.md`,
      ),
      [],
    );
  }

  assert.deepEqual(
    harness.validate(
      { ...config, fields: { model: "claude-opus-4-5-20251101" } },
      "/agents/full-id.md",
    ),
    [],
  );
});

test("Claude validation diagnoses a misspelled model with its value", () => {
  const harness = createClaudeHarness();
  for (const model of ["sontet", "claude-sontet-4-6", "claude-sonnet-bogus"]) {
    assert.deepEqual(
      harness.validate({ ...config, fields: { model } }, "/agents/typo.md"),
      [{ reason: `invalid Claude model '${model}'` }],
    );
  }
});

test("Claude permissions bypass either forwarded trust value and disallow child spawning", () => {
  for (const projectTrusted of [false, true]) {
    const options = buildClaudeOptions(
      { ...task, projectTrusted },
      undefined,
      "off",
      new AbortController(),
    );
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.deepEqual(options.disallowedTools, ["Agent"]);
  }
});

test("SDK messages translate to facts and terminal usage is counted once", () => {
  const assistant = {
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
      ],
    },
  } as unknown as SDKMessage;
  const result = {
    type: "result",
    result: "answer",
    is_error: false,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.25,
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        costUSD: 0.25,
      },
    },
  } as unknown as SDKMessage;
  const live = translateClaudeMessage(assistant);
  const terminal = translateClaudeMessage(result);
  assert.deepEqual(live[0].parts, [
    { type: "tool_call", name: "Read", arguments: { file_path: "a.ts" } },
  ]);
  assert.equal(live[0].usage?.turns, 0);
  assert.deepEqual(terminal[0].usage, {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    cost: 0.25,
    turns: 1,
  });
});

test("Claude keeps terminal facts when a successful result has empty text", () => {
  const [fact] = translateClaudeMessage({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    stop_reason: "end_turn",
    total_cost_usd: 0.25,
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        costUSD: 0.25,
      },
    },
  } as unknown as SDKMessage);

  assert.deepEqual(fact, {
    role: "assistant",
    parts: [],
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.25,
      turns: 2,
    },
    stopReason: "end_turn",
  });
});

test("an empty Claude result carries accounting into the cost widget", async () => {
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          result: "",
          is_error: false,
          num_turns: 2,
          stop_reason: "end_turn",
          total_cost_usd: 0.25,
          modelUsage: {
            "claude-sonnet-4-6": {
              inputTokens: 10,
              outputTokens: 4,
              cacheReadInputTokens: 2,
              cacheCreationInputTokens: 1,
              costUSD: 0.25,
            },
          },
        } as unknown as SDKMessage;
      },
      close() {},
    }) as never;
  const runs = createSubagentRuns();
  const started = startSubagent({
    config,
    description: "empty Claude result",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.deepEqual(result.messages[0]?.parts, []);
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.deepEqual(result.usage, {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    cost: 0.25,
    contextTokens: 0,
    turns: 2,
  });
  assert.equal(result.stopReason, "end_turn");

  const lines = renderRunLines(
    runs.list(),
    {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => text,
    },
    120,
  );
  assert.match(lines[1] ?? "", /\$0\.2500/);
});

test("Claude uses the SDK error text for an error-flagged success result", () => {
  const [fact] = translateClaudeMessage({
    type: "result",
    // This is the SDK's success-subtype API-error shape: result is the
    // provider diagnostic, not an answer to show the user.
    result:
      "API Error: 529 overloaded_error: service is temporarily overloaded",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 1100,
    is_error: true,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: "result-uuid",
    session_id: "session-id",
  } as unknown as SDKMessage);

  assert.equal(
    fact.errorMessage,
    "API Error: 529 overloaded_error: service is temporarily overloaded",
  );
  assert.deepEqual(fact.parts, []);
});

test("Claude runs end-to-end through the core run contract", async () => {
  const query: ClaudeQuery = ({ options }) => {
    options?.stderr?.("sdk diagnostic\\n");
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "live" }],
          },
        } as unknown as SDKMessage;
        yield {
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "second live turn" }],
          },
        } as unknown as SDKMessage;
        yield {
          type: "result",
          result: "answer",
          is_error: false,
          num_turns: 2,
          total_cost_usd: 0.1,
          modelUsage: {
            "claude-haiku-4-5-20251001": {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.02,
            },
            "claude-sonnet-4-6": {
              inputTokens: 2,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.08,
            },
          },
        } as unknown as SDKMessage;
      },
      close() {},
    } as never;
  };
  const started = startSubagent({
    config,
    description: "claude run",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs: createSubagentRuns(),
  });
  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(getFinalOutput(result.messages), "answer");
  assert.equal(result.stderr, "sdk diagnostic\\n");
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.usage.input, 3);
  assert.equal(result.usage.output, 2);
  assert.equal(result.usage.turns, 2);
});

test("Claude keeps a terminal result when abort arrives before stream close", async () => {
  const runs = createSubagentRuns();
  let releaseStream: () => void = () => {};
  const streamReleased = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  let closeCalled = false;
  let resultReceived = false;
  let abortController: AbortController | undefined;
  const query: ClaudeQuery = ({ options }) => {
    abortController = options?.abortController;
    return {
      async *[Symbol.asyncIterator]() {
        resultReceived = true;
        yield {
          type: "result",
          result: "answer",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          stop_reason: "end_turn",
          model: "claude-sonnet-4-6",
          modelUsage: {},
        } as unknown as SDKMessage;
        await streamReleased;
      },
      close() {
        closeCalled = true;
        releaseStream();
      },
    } as never;
  };
  const started = startSubagent({
    config,
    description: "late cancellation",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });

  while (!abortController)
    await new Promise((resolve) => setImmediate(resolve));
  // The result has been received, but the SDK stream has not closed yet.
  while (!resultReceived) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  runs.cancel([started.id], "requested");
  const result = await started.settled;

  assert.equal(closeCalled, true);
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.stopReason, "end_turn");
});

test("Claude cancellation stays cancelled when abort closes the stream gracefully", async () => {
  const runs = createSubagentRuns();
  let queryReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    queryReady = resolve;
  });
  let closeCalled = false;
  const query: ClaudeQuery = ({ options }) => {
    queryReady();
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) =>
          options?.abortController?.signal.addEventListener(
            "abort",
            () => resolve(),
            { once: true },
          ),
        );
      },
      close() {
        closeCalled = true;
      },
    } as never;
  };
  const started = startSubagent({
    config,
    description: "cancelled claude run",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });

  await ready;
  runs.cancel([started.id], "shutdown");
  const result = await started.settled;

  assert.equal(closeCalled, true);
  assert.equal(result.lifecycle.phase, "cancelled");
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "shutdown");
  }
});

test("Claude preserves the configured model when auxiliary usage is listed first", () => {
  const [fact] = translateClaudeMessage({
    type: "result",
    result: "answer",
    is_error: false,
    num_turns: 1,
    modelUsage: {
      "claude-haiku-4-5-20251001": { inputTokens: 2, outputTokens: 1 },
      "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 4 },
    },
  } as unknown as SDKMessage);

  assert.equal(fact.model, undefined);
  assert.equal(fact.usage?.input, 12);
  assert.equal(fact.usage?.output, 5);
});

test("Claude adapter feeds SDK stderr and normalizes abort", async () => {
  const captured: { options?: Record<string, unknown> } = {};
  let closeCalled = false;
  const query = () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {});
      },
      close() {
        closeCalled = true;
      },
    };
    return stream;
  };
  const harness = createClaudeHarness(async () => query as never);
  const prepared = harness.prepare(task);
  const controller = new AbortController();
  const run = {
    task,
    signal: controller.signal,
    report: {
      message() {},
      transcript() {},
      stderr(value: string) {
        captured.options = { stderr: value };
      },
    },
  };
  const pending = prepared.execute(run);
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.stopReason, "aborted");
  assert.equal(closeCalled, true);
  assert.equal(captured.options, undefined);
});
