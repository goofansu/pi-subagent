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
import { getFinalOutput } from "./messages.ts";
import type { SubagentTask } from "./run.ts";
import { startSubagent } from "./runner.ts";
import { createSubagentRuns } from "./runs.ts";
import type { AgentConfig } from "./types.ts";

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
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
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
  for (const model of ["sontet", "claude-sontet-4-6"]) {
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
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
  });
});

test("Claude reports an error flag truthfully even with a success subtype", () => {
  const [fact] = translateClaudeMessage({
    type: "result",
    result: "",
    subtype: "success",
    is_error: true,
  } as unknown as SDKMessage);

  assert.match(fact.errorMessage ?? "", /error/i);
  assert.match(fact.errorMessage ?? "", /success/i);
  assert.doesNotMatch(fact.errorMessage ?? "", /ended with success/i);
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
            "claude-sonnet-4-6": {
              inputTokens: 2,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.1,
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
    harness: createClaudeHarness(async () => query),
    runs: createSubagentRuns(),
  });
  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(getFinalOutput(result.messages), "answer");
  assert.equal(result.stderr, "sdk diagnostic\\n");
  assert.equal(result.usage.input, 2);
  assert.equal(result.usage.output, 1);
  assert.equal(result.usage.turns, 2);
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
    harness: createClaudeHarness(async () => query),
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
