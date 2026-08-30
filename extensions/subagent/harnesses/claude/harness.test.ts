import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ModelUsage,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKModelRefusalFallbackMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createControlGate } from "../../control-source.ts";
import { getFinalOutput } from "../../messages.ts";
import {
  createEmptyResult,
  createRunReporter,
  DEPTH_ENV_KEY,
  type SubagentContext,
} from "../../run.ts";
import { createSubagentRuns } from "../../runs.ts";
import { startSubagent } from "../../standalone-run-helper.ts";
import { createSubagentManager } from "../../subagents.ts";
import type { AgentConfig } from "../../types.ts";
import { renderRunLines } from "../../widget.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "../conformance.ts";
import { createHarnessRegistry } from "../contract.ts";
import {
  buildClaudeOptions,
  CLAUDE_MODEL_ALIASES,
  type ClaudeQuery,
  type ClaudeQueryLoader,
  createClaudeHarness,
  createClaudeTranslator,
} from "./harness.ts";

const config: AgentConfig = {
  name: "worker",
  description: "worker",
  harness: "claude",
  fields: { model: "sonnet", effort: "high", appendSystemPrompt: true },
  systemPrompt: "Be useful.",
};
const context: SubagentContext = {
  config,
  cwd: "/work",
  childDepth: 1,
  projectTrusted: false,
};

const modelUsage = (overrides: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  ...overrides,
});

const resultUsage: SDKResultSuccess["usage"] = {
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: { status: { type: "redeemed" } },
  inference_geo: "unknown",
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
};

function assistantMessage(
  id: string,
  content: SDKAssistantMessage["message"]["content"],
  overrides: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id,
      container: null,
      content,
      context_management: null,
      diagnostics: null,
      model: "claude-sonnet-4-6",
      role: "assistant",
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        fallback_credit: null,
        inference_geo: null,
        input_tokens: 0,
        iterations: null,
        output_tokens: 0,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: "standard",
        speed: "standard",
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "00000000-0000-4000-8000-000000000099",
    ...overrides,
  };
}

function resultMessage(
  result: string,
  overrides: Partial<SDKResultSuccess> = {},
): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: resultUsage,
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: "00000000-0000-4000-8000-000000000099",
    ...overrides,
  };
}

function errorResultMessage(
  errors: string[],
  overrides: Partial<SDKResultError> = {},
): SDKResultError {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 0,
    stop_reason: "error",
    total_cost_usd: 0,
    usage: resultUsage,
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: "00000000-0000-4000-8000-000000000099",
    ...overrides,
  };
}

function initMessage(model: string): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "1.0.0",
    cwd: "/work",
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-8000-000000000004",
    session_id: "00000000-0000-4000-8000-000000000099",
  };
}

function refusalFallback(): SDKModelRefusalFallbackMessage {
  return {
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    scope: "session",
    original_model: "claude-sonnet-4-6",
    fallback_model: "claude-opus-4-6",
    request_id: "request-1",
    retracted_message_uuids: ["00000000-0000-4000-8000-000000000001"],
    refused_user_message_uuid: "00000000-0000-4000-8000-000000000005",
    content: "Retrying with the fallback model",
    uuid: "00000000-0000-4000-8000-000000000006",
    session_id: "00000000-0000-4000-8000-000000000099",
  };
}

function factsFrom(message: SDKMessage) {
  return createClaudeTranslator()(message)?.facts ?? [];
}

async function runClaudeMessages(messages: SDKMessage[]) {
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
      close() {},
    }) as never;
  return startSubagent({
    config,
    description: "Claude fixture run",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs: createSubagentRuns(),
  }).settled;
}

function claudeConformanceRig(): HarnessConformanceRig {
  return {
    name: "claude",
    build(
      scenario: HarnessConformanceScenario,
    ): HarnessConformanceFixture | undefined {
      if (scenario === "terminal-transcript-healing") return undefined;

      let observedDepth: number | undefined;
      let ready: Promise<void> | undefined;
      let openReady = () => {};
      let releaseSteering = () => {};
      const queryPrompts: string[] = [];
      let providerControlStarts = 0;
      let activeProviderControls = 0;
      let maxConcurrentProviderControls = 0;
      if (
        scenario === "abort-mid-run" ||
        scenario === "terminal-answer-then-abort" ||
        scenario.startsWith("steering-")
      ) {
        ready = new Promise<void>((resolve) => {
          openReady = resolve;
        });
      }
      const steeringReleased = new Promise<void>((resolve) => {
        releaseSteering = resolve;
      });
      let openIntermediate = () => {};
      const intermediateCheckpoint = new Promise<void>((resolve) => {
        openIntermediate = resolve;
      });

      const query: ClaudeQuery = ({ options, prompt }) => {
        queryPrompts.push(typeof prompt === "string" ? prompt : "<stream>");
        observedDepth = Number(options?.env?.[DEPTH_ENV_KEY]);
        assert.equal(
          options?.env?.PATH,
          process.env.PATH,
          "Claude SDK options must inherit the parent environment",
        );

        let releaseAbort = () => {};
        const aborted = new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
        options?.abortController?.signal.addEventListener(
          "abort",
          releaseAbort,
          { once: true },
        );

        const stream = {
          async *[Symbol.asyncIterator]() {
            switch (scenario) {
              case "backend-crash":
                throw new Error("fixture Claude backend crashed");
              case "abort-mid-run":
                openReady();
                await aborted;
                return;
              case "terminal-answer-then-abort":
                yield resultMessage("terminal answer");
                openReady();
                await aborted;
                return;
              case "usage-totals":
                yield assistantMessage("msg-1", [
                  { type: "text", text: "first turn", citations: null },
                ]);
                yield assistantMessage("msg-2", [
                  { type: "text", text: "second turn", citations: null },
                ]);
                yield resultMessage("claude answer", {
                  num_turns: 2,
                  total_cost_usd: 0.5,
                  modelUsage: {
                    "claude-sonnet-4-6": modelUsage({
                      inputTokens: 12,
                      outputTokens: 7,
                      cacheReadInputTokens: 3,
                      cacheCreationInputTokens: 3,
                      costUSD: 0.5,
                    }),
                  },
                });
                return;
              case "child-depth":
              case "config-immutable":
                yield resultMessage("claude answer");
                return;
              case "no-terminal-answer":
                return;
              case "post-answer-failure":
                yield resultMessage("claude answer");
                throw new Error("late Claude failure");
              case "steering-single-consumed":
              case "steering-fifo-consumed":
              case "steering-intermediate-completion":
              case "steering-admission-no-fact": {
                assert.notEqual(typeof prompt, "string");
                const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
                  Symbol.asyncIterator
                ]();
                const initial = await iterator.next();
                assert.equal(initial.done, false);
                const initialUuid = initial.value.uuid;
                openReady();
                const expectedControls =
                  scenario === "steering-fifo-consumed" ? 2 : 1;
                let firstControlUuid = "";
                for (let index = 0; index < expectedControls; index++) {
                  const next = await iterator.next();
                  assert.equal(next.done, false);
                  const message = next.value as SDKUserMessage;
                  assert.equal(
                    message.priority,
                    "later",
                    "Controls must survive the current provider Turn",
                  );
                  if (index === 0) firstControlUuid = message.uuid ?? "";
                  const block = Array.isArray(message.message.content)
                    ? message.message.content[0]
                    : undefined;
                  assert.ok(block && block.type === "text");
                  queryPrompts.push(block.text);
                  providerControlStarts++;
                  activeProviderControls++;
                  maxConcurrentProviderControls = Math.max(
                    maxConcurrentProviderControls,
                    activeProviderControls,
                  );
                  if (
                    index === 0 &&
                    scenario === "steering-intermediate-completion"
                  ) {
                    yield resultMessage("intermediate answer", {
                      num_turns: 1,
                      user_message_uuid: initialUuid,
                      queued_turn_count: 0,
                    });
                    openIntermediate();
                  }
                  if (index === 0) await steeringReleased;
                  if (
                    index === 0 &&
                    scenario === "steering-intermediate-completion"
                  ) {
                    // Live streaming input emits a fresh init boundary before
                    // the later queued Turn while retaining the same Query.
                    yield initMessage("claude-sonnet-4-6");
                  }
                  if (
                    scenario !== "steering-admission-no-fact" &&
                    scenario !== "steering-intermediate-completion"
                  ) {
                    yield {
                      ...message,
                      session_id: "00000000-0000-4000-8000-000000000099",
                    } as SDKMessage;
                  }
                  activeProviderControls--;
                }
                yield resultMessage("controlled answer", {
                  num_turns:
                    scenario === "steering-intermediate-completion" ? 2 : 1,
                  ...(scenario === "steering-intermediate-completion"
                    ? {
                        queued_turn_count: 0,
                        user_message_uuid: firstControlUuid,
                      }
                    : {}),
                });
                return;
              }
            }
          },
          close() {
            releaseAbort();
          },
        };
        return stream as unknown as Query;
      };

      const base = (
        expected: HarnessConformanceFixture["expected"],
      ): HarnessConformanceFixture => ({
        harness: createClaudeHarness(async () => query),
        expected,
        ...(ready ? { readyForCancellation: ready } : {}),
        depthProbe: () => observedDepth,
      });

      switch (scenario) {
        case "backend-crash":
          return base({
            phase: "failed",
            errorMessage: "fixture Claude backend crashed",
          });
        case "abort-mid-run":
          return base({ phase: "cancelled", cancellationReason: "requested" });
        case "terminal-answer-then-abort":
          return base({
            phase: "completed",
            finalOutput: "terminal answer",
            stopReason: "end_turn",
            errorMessage: undefined,
          });
        case "usage-totals":
          return base({
            phase: "completed",
            usage: {
              input: 12,
              output: 7,
              cacheRead: 3,
              cacheWrite: 3,
              cost: 0.5,
              contextTokens: 0,
              turns: 2,
            },
          });
        case "child-depth":
          return base({ phase: "completed", childDepth: 1 });
        case "config-immutable":
          return base({ phase: "completed" });
        case "no-terminal-answer":
          return base({
            phase: "failed",
            errorMessage:
              "Claude stream ended without a terminal result answer.",
          });
        case "post-answer-failure":
          return base({
            phase: "completed",
            finalOutput: "claude answer",
            errorMessage: undefined,
          });
        case "steering-single-consumed":
        case "steering-fifo-consumed":
        case "steering-intermediate-completion":
        case "steering-admission-no-fact": {
          const offeredTexts =
            scenario === "steering-fifo-consumed"
              ? ["first guidance", "second guidance"]
              : ["first guidance"];
          const fixture = base({
            phase: "completed",
            finalOutput: "controlled answer",
            userFactTexts:
              scenario === "steering-admission-no-fact" ? [] : offeredTexts,
          });
          return {
            ...fixture,
            steering: {
              ready: ready as Promise<void>,
              offeredTexts,
              expectedOutcome: "accepted",
              release: () => releaseSteering(),
              receivedTexts: () => queryPrompts.slice(1),
              providerControlStarts: () => providerControlStarts,
              maxConcurrentProviderControls: () =>
                maxConcurrentProviderControls,
              ...(scenario === "steering-intermediate-completion"
                ? { intermediateCheckpoint }
                : {}),
            },
          };
        }
      }
    },
  };
}

runHarnessConformance(claudeConformanceRig());

test("Claude validation accepts exactly the SDK family aliases", () => {
  const harness = createClaudeHarness();
  assert.deepEqual(
    [...CLAUDE_MODEL_ALIASES],
    ["fable", "opus", "sonnet", "haiku"],
  );
  for (const model of [...CLAUDE_MODEL_ALIASES, "Sonnet", "OPUS"]) {
    assert.deepEqual(
      harness.validate({ ...config, fields: { model } }, `/agents/${model}.md`),
      [],
      model,
    );
  }
});

test("Claude passes the alias through unresolved for the SDK to interpret", () => {
  const harness = createClaudeHarness();
  assert.equal(harness.prepare(context).model, "sonnet");
  assert.equal(
    harness.prepare({
      ...context,
      config: { ...config, fields: { model: "Opus" } },
    }).model,
    "opus",
  );
  assert.equal(
    harness.prepare({ ...context, config: { ...config, fields: {} } }).model,
    undefined,
  );
});

test("Claude shares tools trimming and empty-segment handling with Pi", () => {
  const options = buildClaudeOptions(
    {
      ...context,
      config: { ...config, fields: { tools: " read, , grep ,, " } },
    },
    undefined,
    undefined,
    new AbortController(),
  );

  assert.deepEqual(options.tools, ["read", "grep"]);
});

test("Claude preserves an explicitly empty tools allowlist", () => {
  const options = buildClaudeOptions(
    { ...context, config: { ...config, fields: { tools: ", ," } } },
    undefined,
    undefined,
    new AbortController(),
  );

  assert.deepEqual(options.tools, []);
});

test("Claude thinking budgets stay inside the adapter", () => {
  assert.deepEqual(
    buildClaudeOptions(context, "sonnet", "high", new AbortController())
      .thinking,
    { type: "enabled", budgetTokens: 8192 },
  );
});

test("Claude validation diagnoses a non-alias model with its value", () => {
  const harness = createClaudeHarness();
  for (const model of [
    "sontet",
    "fableish",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-latest",
  ]) {
    assert.deepEqual(
      harness.validate({ ...config, fields: { model } }, "/agents/typo.md"),
      [
        {
          reason: `invalid Claude model '${model}' (expected one of: fable, opus, sonnet, haiku)`,
        },
      ],
    );
  }
});

test("Claude permissions bypass either forwarded trust value and disallow child spawning", () => {
  for (const projectTrusted of [false, true]) {
    const options = buildClaudeOptions(
      { ...context, projectTrusted },
      undefined,
      "off",
      new AbortController(),
    );
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.deepEqual(options.disallowedTools, ["Agent", "Task"]);
  }
});

test("Claude children carry a nontrivial depth and inherit the environment", () => {
  const marker = "CLAUDE_HARNESS_DEPTH_TEST_MARKER";
  const previous = process.env[marker];
  process.env[marker] = "inherited";
  try {
    const options = buildClaudeOptions(
      { ...context, childDepth: 7 },
      undefined,
      "off",
      new AbortController(),
    );
    assert.equal(options.env?.[DEPTH_ENV_KEY], "7");
    assert.equal(options.env?.[marker], "inherited");
    assert.equal(options.env?.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) delete process.env[marker];
    else process.env[marker] = previous;
  }
});

test("SDK assistant messages translate tool calls with one turn delta", () => {
  const assistant = assistantMessage("msg-tool", [
    {
      type: "tool_use",
      id: "tool-1",
      name: "Read",
      input: { file_path: "a.ts" },
    },
  ]);
  const [live] = factsFrom(assistant);
  assert.deepEqual(live.parts, [
    { type: "tool_call", name: "Read", arguments: { file_path: "a.ts" } },
  ]);
  assert.equal(live.usage?.turns, 1);
});

test("Claude keeps model metadata from an empty assistant message", () => {
  const [fact] = factsFrom(
    assistantMessage("msg-thinking", [
      { type: "thinking", thinking: "planning", signature: "signature" },
    ]),
  );

  assert.deepEqual(fact, {
    role: "assistant",
    parts: [],
    usage: { turns: 1 },
    model: "claude-sonnet-4-6",
  });
});

test("Claude translates init provenance as metadata without usage", () => {
  const [fact] = factsFrom(initMessage("claude-opus-5"));

  assert.deepEqual(fact, {
    role: "metadata",
    parts: [],
    model: "claude-opus-5",
  });
});

test("Claude keeps terminal facts when a successful result has empty text", () => {
  const terminalWithCompatibleModel = {
    ...resultMessage("", {
      num_turns: 2,
      total_cost_usd: 0.25,
      modelUsage: {
        "claude-sonnet-4-6": modelUsage({
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          costUSD: 0.25,
        }),
      },
    }),
    // The harness deliberately tolerates this older/alternate wire field even
    // though the installed SDK result type does not currently declare it.
    model: "claude-sonnet-4-6",
  };
  const [fact] = factsFrom(terminalWithCompatibleModel);

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
    model: "claude-sonnet-4-6",
  });
});

test("an unpinned empty Claude result carries streamed model and accounting", async () => {
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield assistantMessage(
          "msg-thinking",
          [
            {
              type: "thinking",
              thinking: "planning",
              signature: "signature",
            },
          ],
          {
            message: {
              ...assistantMessage("template", []).message,
              id: "msg-thinking",
              model: "claude-haiku-4-5-20251001",
              content: [
                {
                  type: "thinking",
                  thinking: "planning",
                  signature: "signature",
                },
              ],
            },
          },
        );
        yield resultMessage("", {
          num_turns: 2,
          total_cost_usd: 0.25,
          modelUsage: {
            "claude-haiku-4-5-20251001": modelUsage({
              inputTokens: 10,
              outputTokens: 4,
              costUSD: 0.25,
            }),
          },
        });
      },
      close() {},
    }) as never;
  const runs = createSubagentRuns();
  const started = startSubagent({
    config: { ...config, fields: {} },
    description: "default Claude result",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.model, "claude-haiku-4-5-20251001");
  assert.equal(result.usage.input, 10);
  assert.equal(result.usage.output, 4);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.stopReason, "end_turn");
});

test("Claude shows completed provider turns while it is still running", async () => {
  let assistantReported = () => {};
  const reported = new Promise<void>((resolve) => {
    assistantReported = resolve;
  });
  let releaseResult = () => {};
  const resultReleased = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        const firstResponseId = "msg_01K3CLAUDETURN000000000000";
        yield assistantMessage(
          firstResponseId,
          [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
          { uuid: "00000000-0000-4000-8000-000000000011" },
        );
        // A second block from the same API response is not another turn.
        yield assistantMessage(
          firstResponseId,
          [{ type: "text", text: "Reading", citations: null }],
          { uuid: "00000000-0000-4000-8000-000000000012" },
        );
        // Sidechain model responses do not belong to the main-loop turn total.
        yield assistantMessage(
          "sidechain-msg",
          [{ type: "text", text: "auxiliary work", citations: null }],
          { parent_tool_use_id: "tool-1" },
        );
        yield assistantMessage("msg-2", [
          { type: "text", text: "Done", citations: null },
        ]);
        assistantReported();
        await resultReleased;
        yield resultMessage("done", { num_turns: 5 });
      },
      close() {},
    }) as never;
  const runs = createSubagentRuns();
  const started = startSubagent({
    config,
    description: "live Claude turns",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });

  await reported;
  assert.equal(runs.list()[0]?.status, "running");
  assert.equal(runs.list()[0]?.turns, 2);
  const lines = renderRunLines(
    runs.list(),
    {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => text,
    },
    120,
  );
  assert.match(lines[1] ?? "", /2 turns.*running/);

  releaseResult();
  const result = await started.settled;
  assert.equal(result.usage.turns, 5, "a higher terminal total catches up");
});

test("Claude translator stamps one nonnegative integer delta on each accounting event", () => {
  const translate = createClaudeTranslator();
  const events: SDKMessage[] = [
    assistantMessage("msg-1", [
      { type: "text", text: "first", citations: null },
    ]),
    assistantMessage("msg-1", [
      { type: "text", text: "same response", citations: null },
    ]),
    assistantMessage(
      "sidechain-msg",
      [{ type: "text", text: "sidechain", citations: null }],
      { parent_tool_use_id: "tool-1" },
    ),
    resultMessage("done", { num_turns: 1 }),
  ];

  for (const event of events) {
    const translation = translate(event);
    assert.ok(translation);
    assert.equal(translation.facts?.length, 1);
    const accountingFacts =
      translation.facts?.filter((fact) => fact.usage?.turns !== undefined) ??
      [];
    assert.equal(accountingFacts.length, 1);
    const delta = accountingFacts[0]?.usage?.turns;
    assert.equal(Number.isFinite(delta), true);
    assert.equal(Number.isInteger(delta), true);
    assert.ok((delta ?? -1) >= 0);
  }

  const [metadata] = translate(initMessage("claude-sonnet-4-6"))?.facts ?? [];
  assert.equal(metadata?.role, "metadata");
  assert.equal(metadata?.usage, undefined);
});

test("Claude differences cumulative accounting at every provider Result boundary", () => {
  const translate = createClaudeTranslator();
  const totals = [
    { inputTokens: 10, outputTokens: 4, costUSD: 0.1 },
    { inputTokens: 16, outputTokens: 9, costUSD: 0.25 },
    // A provider-side counter reset begins a new nonnegative segment.
    { inputTokens: 3, outputTokens: 2, costUSD: 0.04 },
  ];
  const deltas = totals.map((usage, index) => {
    const translation = translate(
      resultMessage(`result ${index}`, {
        num_turns: index + 1,
        total_cost_usd: usage.costUSD,
        modelUsage: {
          "claude-sonnet-4-6": modelUsage(usage),
        },
      }),
    );
    return translation?.facts?.[0]?.usage;
  });

  assert.deepEqual(
    deltas.map((usage) => ({
      input: usage?.input,
      output: usage?.output,
      cost: usage?.cost,
    })),
    [
      { input: 10, output: 4, cost: 0.1 },
      { input: 6, output: 5, cost: 0.15 },
      { input: 3, output: 2, cost: 0.04 },
    ],
  );
  for (const usage of deltas) {
    assert.ok((usage?.input ?? -1) >= 0);
    assert.ok((usage?.output ?? -1) >= 0);
    assert.ok((usage?.cost ?? -1) >= 0);
  }
});

test("Claude rejects a successful Result without an authoritative Conversation identity", async () => {
  const terminal = resultMessage("unattached answer") as unknown as Record<
    string,
    unknown
  >;
  delete terminal.session_id;

  const result = await runClaudeMessages([terminal as unknown as SDKMessage]);

  assert.equal(result.lifecycle.phase, "failed");
  assert.equal(
    result.errorMessage,
    "Claude query returned an invalid conversation identity",
  );
  assert.equal(getFinalOutput(result.messages), "");
});

test("Claude reports one user Fact when Result correlation authoritatively confirms steering", async () => {
  let openReady = () => {};
  const ready = new Promise<void>((resolve) => {
    openReady = resolve;
  });
  const query: ClaudeQuery = ({ prompt }) =>
    ({
      async *[Symbol.asyncIterator]() {
        assert.notEqual(typeof prompt, "string");
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
          Symbol.asyncIterator
        ]();
        await iterator.next();
        openReady();
        const control = await iterator.next();
        assert.equal(control.done, false);
        assert.equal(
          control.value.priority,
          "later",
          "admitted guidance must remain queued across the active provider Turn",
        );
        const uuid = control.value.uuid;
        yield {
          ...resultMessage("steered answer"),
          user_message_uuid: uuid,
        } as SDKMessage;
        // A duplicate provider echo with the same correlation cannot add a
        // second neutral user Fact after the Result already confirmed it.
        yield {
          ...control.value,
          session_id: "00000000-0000-4000-8000-000000000099",
        } as SDKMessage;
      },
      close() {},
    }) as never;
  const runs = createSubagentRuns();
  const started = startSubagent({
    config,
    description: "result correlation",
    prompt: "start",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });
  await ready;
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "exact guidance" }),
    "accepted",
  );

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.deepEqual(
    result.messages
      .filter((fact) => fact.role === "user")
      .flatMap((fact) =>
        fact.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ),
    ["exact guidance"],
  );
});

for (const correlation of ["missing", "foreign"] as const) {
  test(`Claude keeps a valid answer and does not hang when Control correlation is ${correlation}`, {
    timeout: 2_000,
  }, async () => {
    let openReady = () => {};
    const ready = new Promise<void>((resolve) => {
      openReady = resolve;
    });
    let inputClosed = false;
    let queryClosed = false;
    const query: ClaudeQuery = ({ prompt }) =>
      ({
        async *[Symbol.asyncIterator]() {
          assert.notEqual(typeof prompt, "string");
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
            Symbol.asyncIterator
          ]();
          await iterator.next();
          openReady();
          const control = await iterator.next();
          assert.equal(control.done, false);
          yield {
            ...resultMessage(`${correlation} correlation answer`),
            ...(correlation === "foreign"
              ? {
                  user_message_uuid: "00000000-0000-4000-8000-000000000088",
                }
              : {}),
          } as SDKMessage;
          inputClosed = (await iterator.next()).done === true;
        },
        close() {
          queryClosed = true;
        },
      }) as never;
    const runs = createSubagentRuns();
    const started = startSubagent({
      config,
      description: `${correlation} Control correlation`,
      prompt: "start",
      harnesses: createHarnessRegistry([
        createClaudeHarness(async () => query),
      ]),
      runs,
    });
    await ready;
    assert.equal(
      runs.offer(started.id, { type: "steer", text: "unconfirmed guidance" }),
      "accepted",
    );

    const result = await started.settled;

    assert.equal(result.lifecycle.phase, "completed");
    assert.equal(
      getFinalOutput(result.messages),
      `${correlation} correlation answer`,
    );
    assert.equal(
      result.messages.some((fact) => fact.role === "user"),
      false,
      "unmatched correlation must not fabricate a user Fact",
    );
    assert.equal(inputClosed, true);
    assert.equal(queryClosed, true);
  });
}

test("Claude orders Control and cancellation by ingress in both directions", async () => {
  for (let iteration = 0; iteration < 32; iteration++) {
    for (const order of ["control-first", "cancellation-first"] as const) {
      let openReady = () => {};
      const ready = new Promise<void>((resolve) => {
        openReady = resolve;
      });
      let openControlStarted = () => {};
      const controlStarted = new Promise<void>((resolve) => {
        openControlStarted = resolve;
      });
      let providerControlStarts = 0;
      const query: ClaudeQuery = ({ prompt, options }) =>
        ({
          async *[Symbol.asyncIterator]() {
            assert.notEqual(typeof prompt, "string");
            const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
              Symbol.asyncIterator
            ]();
            await iterator.next();
            openReady();
            const next = await iterator.next();
            if (!next.done) {
              providerControlStarts++;
              openControlStarted();
              if (!options?.abortController?.signal.aborted) {
                await new Promise<void>((resolve) =>
                  options?.abortController?.signal.addEventListener(
                    "abort",
                    () => resolve(),
                    { once: true },
                  ),
                );
              }
            }
          },
          close() {},
        }) as never;
      const runs = createSubagentRuns();
      const started = startSubagent({
        config,
        description: `Claude ${order}`,
        prompt: "start",
        harnesses: createHarnessRegistry([
          createClaudeHarness(async () => query),
        ]),
        runs,
      });
      await ready;

      if (order === "control-first") {
        assert.equal(
          runs.offer(started.id, { type: "steer", text: "first guidance" }),
          "accepted",
        );
        await controlStarted;
        assert.deepEqual(runs.cancel([started.id], "requested"), [started.id]);
      } else {
        assert.deepEqual(runs.cancel([started.id], "requested"), [started.id]);
        assert.notEqual(
          runs.offer(started.id, { type: "steer", text: "late guidance" }),
          "accepted",
        );
      }

      const result = await started.settled;
      assert.equal(result.lifecycle.phase, "cancelled");
      assert.equal(providerControlStarts, order === "control-first" ? 1 : 0);
      assert.equal(
        result.messages.some((fact) => fact.role === "user"),
        false,
        "cancellation cannot fabricate authoritative Control consumption",
      );
    }
  }
});

test("Claude resumes through one fresh Query without replay and never falls back after attachment failure", async () => {
  const firstSession = "00000000-0000-4000-8000-000000000090";
  const wrongSession = "00000000-0000-4000-8000-000000000091";
  const prompts: AsyncIterable<SDKUserMessage>[] = [];
  const resumeOptions: Array<string | undefined> = [];
  let attempt = 0;
  const query: ClaudeQuery = ({ prompt, options }) => {
    assert.notEqual(typeof prompt, "string");
    prompts.push(prompt as AsyncIterable<SDKUserMessage>);
    resumeOptions.push(options?.resume);
    const current = attempt++;
    return {
      async *[Symbol.asyncIterator]() {
        const initial = await (prompt as AsyncIterable<SDKUserMessage>)
          [Symbol.asyncIterator]()
          .next();
        assert.equal(initial.done, false);
        if (current === 0) {
          yield resultMessage("first answer", { session_id: firstSession });
          return;
        }
        yield {
          ...assistantMessage("historical", [
            { type: "text", text: "replayed first answer", citations: null },
          ]),
          session_id: firstSession,
          isReplay: true,
        } as SDKMessage;
        yield resultMessage("must not survive", {
          session_id: wrongSession,
        });
      },
      close() {},
    } as never;
  };
  const runs = createSubagentRuns();
  const manager = createSubagentManager({
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
    generateSubagentId: () => "claude-managed",
  });
  const first = manager.start({
    config,
    description: "first",
    prompt: "remember a private marker",
  });
  const firstResult = await first.settled;
  assert.equal(firstResult.lifecycle.phase, "completed");

  const resumed = manager.resume({
    subagentId: first.subagentId,
    description: "second",
    prompt: "recall it",
  });
  assert.equal(resumed.outcome, "started");
  if (resumed.outcome !== "started") assert.fail("resume did not start");
  const resumedResult = await resumed.settled;

  assert.equal(resumedResult.lifecycle.phase, "failed");
  assert.equal(
    resumedResult.errorMessage,
    "Claude continuation attachment failed",
  );
  assert.equal(
    attempt,
    2,
    "attachment failure must not create a fallback Query",
  );
  assert.deepEqual(resumeOptions, [undefined, firstSession]);
  assert.equal(prompts.length, 2);
  assert.notStrictEqual(prompts[0], prompts[1]);
  assert.equal(
    resumedResult.messages.some((fact) =>
      fact.parts.some(
        (part) => part.type === "text" && part.text.includes("replayed"),
      ),
    ),
    false,
  );
  assert.equal(
    resumedResult.errorMessage?.includes(firstSession) ||
      resumedResult.errorMessage?.includes(wrongSession),
    false,
  );
  assert.equal(getFinalOutput(firstResult.messages), "first answer");
  await manager.shutdown();
});

test("Claude resume filters replayed user, assistant, and system history before the current attachment", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000090";
  let attempt = 0;
  const query: ClaudeQuery = ({ prompt }) =>
    ({
      async *[Symbol.asyncIterator]() {
        assert.notEqual(typeof prompt, "string");
        await (prompt as AsyncIterable<SDKUserMessage>)
          [Symbol.asyncIterator]()
          .next();
        if (attempt++ === 0) {
          yield resultMessage("first answer", { session_id: sessionId });
          return;
        }
        yield {
          type: "user",
          message: { role: "user", content: "historical user" },
          parent_tool_use_id: null,
          session_id: sessionId,
          uuid: "00000000-0000-4000-8000-000000000081",
        } as unknown as SDKMessage;
        yield {
          ...assistantMessage("historical-assistant", [
            { type: "text", text: "historical assistant", citations: null },
          ]),
          session_id: sessionId,
        } as SDKMessage;
        yield {
          type: "system",
          subtype: "status",
          status: "historical system",
          session_id: sessionId,
          uuid: "00000000-0000-4000-8000-000000000082",
        } as unknown as SDKMessage;
        yield { ...initMessage("claude-sonnet-4-6"), session_id: sessionId };
        yield assistantMessage(
          "current-assistant",
          [{ type: "text", text: "current assistant", citations: null }],
          { session_id: sessionId },
        );
        yield resultMessage("resumed answer", { session_id: sessionId });
      },
      close() {},
    }) as never;
  const manager = createSubagentManager({
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs: createSubagentRuns(),
    generateSubagentId: () => "claude-history-filter",
  });
  const first = manager.start({
    config,
    description: "first",
    prompt: "remember",
  });
  assert.equal((await first.settled).lifecycle.phase, "completed");
  const resumed = manager.resume({
    subagentId: first.subagentId,
    description: "second",
    prompt: "recall",
  });
  assert.equal(resumed.outcome, "started");
  if (resumed.outcome !== "started") assert.fail("resume did not start");

  const result = await resumed.settled;

  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(getFinalOutput(result.messages), "resumed answer");
  assert.doesNotMatch(JSON.stringify(result.messages), /historical/);
  assert.match(JSON.stringify(result.messages), /current assistant/);
  await manager.shutdown();
});

test("Claude adapter close stops and waits for its active Attempt", async () => {
  let openReady = () => {};
  const ready = new Promise<void>((resolve) => {
    openReady = resolve;
  });
  let releaseStream = () => {};
  const streamReleased = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  let queryClosed = false;
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        openReady();
        await streamReleased;
        yield* [] as SDKMessage[];
      },
      close() {
        queryClosed = true;
        releaseStream();
      },
    }) as never;
  const adapter = createClaudeHarness(async () => query).prepare(context);
  const result = createEmptyResult("worker", "active close", 0);
  const execution = adapter
    .prepareRun({
      description: "active close",
      prompt: "wait",
    })
    .execute({
      report: createRunReporter(result, () => {}),
      signal: new AbortController().signal,
      controls: createControlGate(["steer"]).controls,
    });
  await ready;

  await adapter.close();

  assert.equal(queryClosed, true);
  assert.deepEqual(await execution, { ending: "cancelled" });
});

test("Claude preserves observed turns when an error result reports zero", async () => {
  const result = await runClaudeMessages([
    assistantMessage("msg-1", [
      { type: "text", text: "first", citations: null },
    ]),
    assistantMessage("msg-2", [
      { type: "text", text: "second", citations: null },
    ]),
    errorResultMessage(["backend failed"], { num_turns: 0 }),
  ]);

  assert.equal(result.lifecycle.phase, "failed");
  assert.equal(result.usage.turns, 2);
});

test("Claude preserves observed turns when a terminal total is missing", async () => {
  const terminal = resultMessage("done", { num_turns: 3 }) as unknown as Record<
    string,
    unknown
  >;
  delete terminal.num_turns;
  const result = await runClaudeMessages([
    assistantMessage("msg-1", [
      { type: "text", text: "first", citations: null },
    ]),
    assistantMessage("msg-2", [
      { type: "text", text: "second", citations: null },
    ]),
    assistantMessage("msg-3", [
      { type: "text", text: "third", citations: null },
    ]),
    terminal as unknown as SDKMessage,
  ]);

  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.usage.turns, 3);
});

test("Claude preserves observed turns for invalid terminal totals", async () => {
  for (const numTurns of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    const terminal = resultMessage("done") as unknown as Record<
      string,
      unknown
    >;
    terminal.num_turns = numTurns;
    const result = await runClaudeMessages([
      assistantMessage("msg-1", [
        { type: "text", text: "first", citations: null },
      ]),
      assistantMessage("msg-2", [
        { type: "text", text: "second", citations: null },
      ]),
      terminal as unknown as SDKMessage,
    ]);

    assert.equal(result.lifecycle.phase, "completed");
    assert.equal(result.usage.turns, 2, String(numTurns));
  }
});

test("Claude treats an absent parent id as a root response", async () => {
  const assistant = assistantMessage("msg-1", [
    { type: "text", text: "older SDK response", citations: null },
  ]);
  const { parent_tool_use_id: _missing, ...withoutParent } = assistant;
  const result = await runClaudeMessages([
    withoutParent as SDKMessage,
    resultMessage("done", { num_turns: 0 }),
  ]);

  assert.equal(result.usage.turns, 1);
});

test("Claude refusal fallback keeps the accepted additive overcount", async () => {
  const result = await runClaudeMessages([
    assistantMessage("refused-msg", [
      { type: "text", text: "partial refusal leg", citations: null },
    ]),
    assistantMessage(
      "fallback-msg",
      [{ type: "text", text: "fallback answer", citations: null }],
      {
        supersedes: ["00000000-0000-4000-8000-000000000001"],
      },
    ),
    refusalFallback(),
    resultMessage("fallback answer", { num_turns: 1 }),
  ]);

  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.usage.turns, 2);
});

test("Claude cancellation preserves provisional turns", async () => {
  const runs = createSubagentRuns();
  let observationsReported = () => {};
  const reported = new Promise<void>((resolve) => {
    observationsReported = resolve;
  });
  let releaseAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const query: ClaudeQuery = ({ options }) => {
    options?.abortController?.signal.addEventListener("abort", releaseAbort, {
      once: true,
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield assistantMessage("msg-1", [
          { type: "text", text: "first", citations: null },
        ]);
        yield assistantMessage("msg-2", [
          { type: "text", text: "second", citations: null },
        ]);
        observationsReported();
        await aborted;
      },
      close() {
        releaseAbort();
      },
    } as never;
  };
  const started = startSubagent({
    config,
    description: "cancel after Claude observations",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });

  await reported;
  runs.cancel([started.id], "requested");
  const result = await started.settled;

  assert.equal(result.lifecycle.phase, "cancelled");
  assert.equal(result.usage.turns, 2);
});

test("Claude backend failure preserves provisional turns", async () => {
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield assistantMessage("msg-1", [
          { type: "text", text: "first", citations: null },
        ]);
        yield assistantMessage("msg-2", [
          { type: "text", text: "second", citations: null },
        ]);
        throw new Error("backend failed after responses");
      },
      close() {},
    }) as never;
  const result = await startSubagent({
    config,
    description: "Claude backend failure after observations",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs: createSubagentRuns(),
  }).settled;

  assert.equal(result.lifecycle.phase, "failed");
  assert.equal(result.usage.turns, 2);
});

test("an empty Claude result carries turns into the widget", async () => {
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield initMessage("claude-sonnet-4-6");
        yield resultMessage("", {
          num_turns: 2,
          total_cost_usd: 0.25,
          modelUsage: {
            "claude-sonnet-4-6": modelUsage({
              inputTokens: 10,
              outputTokens: 4,
              cacheReadInputTokens: 2,
              cacheCreationInputTokens: 1,
              costUSD: 0.25,
            }),
          },
        });
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
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1]?.role, "assistant");
  assert.deepEqual(result.messages[1]?.parts, []);
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
  assert.match(lines[1] ?? "", /2 turns/);
});

test("Claude uses the SDK error text for an error-flagged success result", () => {
  const [fact] = factsFrom(
    resultMessage(
      // This is the SDK's success-subtype API-error shape: result is the
      // provider diagnostic, not an answer to show the user.
      "API Error: 529 overloaded_error: service is temporarily overloaded",
      {
        duration_ms: 1200,
        duration_api_ms: 1100,
        is_error: true,
        total_cost_usd: 0.01,
      },
    ),
  );

  assert.equal(
    fact.errorMessage,
    "API Error: 529 overloaded_error: service is temporarily overloaded",
  );
  assert.deepEqual(fact.parts, []);
});

test("an auxiliary-only error result preserves the initialized model", async () => {
  const query: ClaudeQuery = () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield initMessage("claude-opus-5");
        yield errorResultMessage(["API Error: 529 Overloaded"], {
          total_cost_usd: 0.001,
          modelUsage: {
            "claude-haiku-4-5-20251001": modelUsage({
              inputTokens: 1,
              outputTokens: 1,
              costUSD: 0.001,
            }),
          },
        });
      },
      close() {},
    }) as never;
  const started = startSubagent({
    config: { ...config, fields: { model: "opus", effort: "high" } },
    description: "review",
    prompt: "review it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs: createSubagentRuns(),
  });

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "failed");
  assert.equal(result.model, "claude-opus-5");
  assert.equal(result.messages[0]?.role, "metadata");
  assert.equal(result.usage.turns, 0);
  assert.equal(result.usage.cost, 0.001);
});

test("Claude runs end-to-end through the core run contract", async () => {
  const query: ClaudeQuery = ({ options }) => {
    options?.stderr?.("sdk diagnostic\\n");
    return {
      async *[Symbol.asyncIterator]() {
        yield assistantMessage("msg-1", [
          { type: "text", text: "live", citations: null },
        ]);
        yield assistantMessage("msg-2", [
          { type: "text", text: "second live turn", citations: null },
        ]);
        yield resultMessage("answer", {
          num_turns: 2,
          total_cost_usd: 0.1,
          modelUsage: {
            "claude-haiku-4-5-20251001": modelUsage({
              inputTokens: 1,
              outputTokens: 1,
              costUSD: 0.02,
            }),
            "claude-sonnet-4-6": modelUsage({
              inputTokens: 2,
              outputTokens: 1,
              costUSD: 0.08,
            }),
          },
        });
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

test("Claude keeps a terminal result when the terminal fact arrives before abort", async () => {
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
        yield resultMessage("answer");
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

test("Claude cancellation stays cancelled when abort arrives before a later terminal result", async () => {
  const runs = createSubagentRuns();
  let queryReady: () => void = () => {};
  let releaseResult: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    queryReady = resolve;
  });
  const resultReleased = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let closeCalled = false;
  const query: ClaudeQuery = () => {
    queryReady();
    return {
      async *[Symbol.asyncIterator]() {
        // The abort closes the stream, but this SDK-shaped fixture still
        // delivers its queued terminal result afterward.
        await resultReleased;
        yield resultMessage("late answer");
      },
      close() {
        closeCalled = true;
        releaseResult();
      },
    } as never;
  };
  const started = startSubagent({
    config,
    description: "abort before terminal result",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(async () => query)]),
    runs,
  });

  await ready;
  runs.cancel([started.id], "requested");
  const result = await started.settled;

  assert.equal(closeCalled, true);
  assert.equal(result.lifecycle.phase, "cancelled");
  assert.equal(result.stopReason, undefined);
  assert.equal(
    result.messages.length,
    0,
    "a provider Result first observed after cancellation is not current-Run truth",
  );
});

test("Claude cancellation during SDK loading never invokes query", async () => {
  let releaseLoader: () => void = () => {};
  let queryCalled = false;
  const loader: ClaudeQueryLoader = () =>
    new Promise((resolve) => {
      releaseLoader = () =>
        resolve(() => {
          queryCalled = true;
          return {
            async *[Symbol.asyncIterator]() {},
            close() {},
          } as never;
        });
    });
  const runs = createSubagentRuns();
  const started = startSubagent({
    config,
    description: "cancel while loading Claude",
    prompt: "do it",
    harnesses: createHarnessRegistry([createClaudeHarness(loader)]),
    runs,
  });

  runs.cancel([started.id], "requested");
  releaseLoader();
  const result = await started.settled;

  assert.equal(queryCalled, false);
  assert.equal(result.lifecycle.phase, "cancelled");
  assert.equal(result.stopReason, undefined);
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
    const abortSignal = options?.abortController?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        if (abortSignal?.aborted) return;
        await new Promise<void>((resolve) =>
          abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
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

test("Claude does not infer provenance from one terminal usage entry", () => {
  const [fact] = factsFrom(
    resultMessage("answer", {
      modelUsage: {
        "claude-sonnet-4-6": modelUsage({
          inputTokens: 10,
          outputTokens: 4,
        }),
      },
    }),
  );

  assert.equal(fact.model, undefined);
});

test("Claude does not infer provenance from multiple terminal usage entries", () => {
  const [fact] = factsFrom(
    resultMessage("answer", {
      modelUsage: {
        "claude-haiku-4-5-20251001": modelUsage({
          inputTokens: 2,
          outputTokens: 1,
        }),
        "claude-sonnet-4-6": modelUsage({
          inputTokens: 10,
          outputTokens: 4,
        }),
      },
    }),
  );

  assert.equal(fact.model, undefined);
  assert.equal(fact.usage?.input, 12);
  assert.equal(fact.usage?.output, 5);
});
