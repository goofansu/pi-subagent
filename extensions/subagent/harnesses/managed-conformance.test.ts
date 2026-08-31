import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChildProcessSpawn } from "../child-process.ts";
import type { RunEnding } from "../run.ts";
import { type ClaudeQuery, createClaudeHarness } from "./claude/harness.ts";
import { createCodexHarness } from "./codex/harness.ts";
import type { Harness, HarnessAdapter } from "./contract.ts";
import {
  type ManagedConformanceObservation,
  runManagedSubagentConformance,
} from "./managed-conformance.ts";
import type { PiSession, PiSessionFactory } from "./pi/agent.ts";
import { createPiHarness } from "./pi/harness.ts";

function observation(): ManagedConformanceObservation & {
  executionStarted(): void;
  executionSettled(): void;
  adapterClosed(): void;
} {
  let started = 0;
  let settled = 0;
  let active = 0;
  let maximumActive = 0;
  let closes = 0;
  return {
    executionsStarted: () => started,
    executionsSettled: () => settled,
    activeExecutions: () => active,
    maximumActiveExecutions: () => maximumActive,
    adapterCloses: () => closes,
    executionStarted() {
      started++;
      active++;
      maximumActive = Math.max(maximumActive, active);
    },
    executionSettled() {
      settled++;
      active--;
    },
    adapterClosed() {
      closes++;
    },
  };
}

function observeAdapterClose(
  harness: Harness,
  observed: ReturnType<typeof observation>,
): Harness {
  return {
    ...harness,
    prepare(context): HarnessAdapter {
      const adapter = harness.prepare(context);
      let closed = false;
      return {
        ...adapter,
        close: async () => {
          await adapter.close();
          if (closed) return;
          closed = true;
          observed.adapterClosed();
        },
      };
    },
  };
}

function controlledFixture() {
  const observed = observation();
  let openCancellation = () => {};
  const cancellationReady = new Promise<void>((resolve) => {
    openCancellation = resolve;
  });
  const harness: Harness = {
    name: "controlled",
    validate: () => [],
    prepare: () => {
      let marker: string | undefined;
      let closed = false;
      return {
        capabilities: { resume: true },
        model: undefined,
        prepareRun: (task) => ({
          supportedControls: [],
          execute: async (run): Promise<RunEnding> => {
            observed.executionStarted();
            try {
              await Promise.resolve();
              if (task.prompt === "wait until cancelled") {
                run.report.message({
                  role: "assistant",
                  parts: [{ type: "text", text: "controlled partial" }],
                  usage: { input: 5 },
                });
                openCancellation();
                await new Promise<void>((resolve) => {
                  if (run.signal?.aborted) return resolve();
                  run.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                return { ending: "cancelled" };
              }
              const remembered = task.prompt.match(/remember (\S+)/)?.[1];
              if (remembered) marker = remembered;
              const text = remembered
                ? "first controlled answer"
                : `controlled retained marker: ${marker ?? "missing"}`;
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text }],
                usage: { input: remembered ? 11 : 3 },
              });
              return { ending: "answered" };
            } finally {
              observed.executionSettled();
            }
          },
        }),
        close: async () => {
          if (closed) return;
          closed = true;
          observed.adapterClosed();
        },
      };
    },
  };
  return {
    harness,
    observation: observed,
    expectation: {
      resume: "supported" as const,
      firstOutput: "first controlled answer",
      secondOutput: "controlled retained marker: amber",
      cancellationOutput: "controlled partial",
      firstUsageInput: 11,
      resumedUsageInput: 3,
    },
    cancellationReady,
  };
}

function unsupportedFixture() {
  const observed = observation();
  const harness: Harness = {
    name: "controlled-unsupported",
    validate: () => [],
    prepare: () => {
      let closed = false;
      return {
        capabilities: { resume: false },
        model: undefined,
        prepareRun: () => ({
          supportedControls: [],
          execute: async (run): Promise<RunEnding> => {
            observed.executionStarted();
            try {
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text: "unsupported first answer" }],
              });
              return { ending: "answered" };
            } finally {
              observed.executionSettled();
            }
          },
        }),
        close: async () => {
          if (closed) return;
          closed = true;
          observed.adapterClosed();
        },
      };
    },
  };
  return {
    harness,
    observation: observed,
    expectation: {
      resume: "unsupported" as const,
      firstOutput: "unsupported first answer",
    },
  };
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal: string): boolean;
  finish(code: number | null): void;
}

function fakeChild(
  onRequest?: (request: Record<string, unknown>, child: FakeChild) => void,
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim())
        onRequest?.(JSON.parse(line) as Record<string, unknown>, child);
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

function initializeResponse(id: unknown) {
  return {
    id,
    result: {
      userAgent: "managed-conformance",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "test",
    },
  };
}

function send(child: FakeChild, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

function codexFixture() {
  const observed = observation();
  let openCancellation = () => {};
  const cancellationReady = new Promise<void>((resolve) => {
    openCancellation = resolve;
  });
  let marker: string | undefined;
  let turnNumber = 0;
  let activeTurnId: string | undefined;
  let spawnCount = 0;
  const spawn: ChildProcessSpawn = () => {
    spawnCount++;
    assert.equal(spawnCount, 1, "managed Codex must retain one App Server");
    const threadId = "managed-provider-thread";
    const child = fakeChild((request, current) => {
      if (request.method === "initialize") {
        send(current, initializeResponse(request.id));
        return;
      }
      if (request.method === "thread/start") {
        send(current, { id: request.id, result: { thread: { id: threadId } } });
        return;
      }
      if (request.method === "turn/start") {
        observed.executionStarted();
        turnNumber++;
        activeTurnId = `managed-provider-turn-${turnNumber}`;
        const input = (request.params as { input: Array<{ text: string }> })
          .input;
        const prompt = input[0]?.text ?? "";
        const remembered = prompt.match(/remember (\S+)/)?.[1];
        if (remembered) marker = remembered;
        const text =
          turnNumber === 1
            ? "first Codex answer"
            : `Codex retained marker: ${marker ?? "missing"}`;
        send(current, {
          id: request.id,
          result: {
            turn: { id: activeTurnId, status: "inProgress" },
          },
        });
        const cumulativeInput = [11, 14, 19, 22][turnNumber - 1];
        assert.ok(cumulativeInput);
        send(current, {
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId: activeTurnId,
            tokenUsage: {
              total: {
                totalTokens: cumulativeInput,
                inputTokens: cumulativeInput,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: cumulativeInput,
                inputTokens: cumulativeInput,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 100,
            },
          },
        });
        if (prompt === "wait until cancelled") {
          send(current, {
            method: "item/completed",
            params: {
              threadId,
              turnId: activeTurnId,
              item: {
                type: "agentMessage",
                id: `managed-partial-${turnNumber}`,
                text: "Codex partial before cancellation",
                phase: "commentary",
              },
              completedAtMs: 1,
            },
          });
          openCancellation();
          return;
        }
        send(current, {
          method: "item/completed",
          params: {
            threadId,
            turnId: activeTurnId,
            item: {
              type: "agentMessage",
              id: `managed-answer-${turnNumber}`,
              text,
              phase: "final_answer",
            },
            completedAtMs: 1,
          },
        });
        send(current, {
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: activeTurnId,
              items: [],
              status: "completed",
              error: null,
            },
          },
        });
        observed.executionSettled();
        return;
      }
      if (request.method === "turn/interrupt") {
        assert.ok(activeTurnId);
        send(current, { id: request.id, result: {} });
        send(current, {
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: activeTurnId,
              items: [],
              status: "interrupted",
              error: null,
            },
          },
        });
        observed.executionSettled();
      }
    });
    child.stdin.on("finish", () => child.finish(0));
    return child as unknown as ChildProcess;
  };
  const harness = observeAdapterClose(
    createCodexHarness({ spawn, killEscalationMs: 1 }),
    observed,
  );
  return {
    harness,
    observation: observed,
    expectation: {
      resume: "supported" as const,
      firstOutput: "first Codex answer",
      secondOutput: "Codex retained marker: amber",
      cancellationOutput: "Codex partial before cancellation",
      firstUsageInput: 11,
      resumedUsageInput: 3,
    },
    cancellationReady,
  };
}

function piFixture() {
  const observed = observation();
  let openCancellation = () => {};
  const cancellationReady = new Promise<void>((resolve) => {
    openCancellation = resolve;
  });
  let releaseCancelledPrompt = () => {};
  const cancelledPrompt = new Promise<void>((resolve) => {
    releaseCancelledPrompt = resolve;
  });
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: unknown[] = [];
  let marker: string | undefined;
  let creations = 0;
  const emit = (event: unknown): void => {
    for (const listener of listeners) listener(event as AgentSessionEvent);
  };
  const session: PiSession = {
    get messages() {
      return messages as PiSession["messages"];
    },
    get isIdle() {
      return true;
    },
    async prompt(text) {
      observed.executionStarted();
      try {
        if (text === "wait until cancelled") {
          const user = { role: "user", content: [{ type: "text", text }] };
          const partial = {
            role: "assistant",
            content: [{ type: "text", text: "Pi partial before cancellation" }],
            provider: "fixture",
            model: "fixture",
            usage: {
              input: 5,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 5,
              cost: { total: 0 },
            },
          };
          messages.push(user, partial);
          emit({ type: "message_end", message: partial });
          openCancellation();
          await cancelledPrompt;
          return;
        }
        const remembered = text.match(/remember (\S+)/)?.[1];
        if (remembered) marker = remembered;
        const user = { role: "user", content: [{ type: "text", text }] };
        const assistant = {
          role: "assistant",
          content: [
            {
              type: "text",
              text: remembered
                ? "first Pi answer"
                : `Pi retained marker: ${marker ?? "missing"}`,
            },
          ],
          provider: "fixture",
          model: "fixture",
          stopReason: "stop",
          usage: {
            input: remembered ? 11 : 3,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: remembered ? 11 : 3,
            cost: { total: 0 },
          },
        };
        messages.push(user, assistant);
        emit({ type: "message_end", message: assistant });
        emit({ type: "agent_end", messages: [...messages], willRetry: false });
      } finally {
        observed.executionSettled();
      }
    },
    async steer() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async bindExtensions() {},
    async abort() {
      releaseCancelledPrompt();
    },
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {},
    extensionRunner: { async emit() {} },
  };
  const sessionFactory: PiSessionFactory = async () => {
    creations++;
    if (creations > 1) throw new Error("Pi created more than one SDK session");
    return { session };
  };
  return {
    harness: observeAdapterClose(
      createPiHarness({
        sessionFactory,
        sessionOptionsFactory: async () => ({}),
      }),
      observed,
    ),
    observation: observed,
    expectation: {
      resume: "supported" as const,
      firstOutput: "first Pi answer",
      secondOutput: "Pi retained marker: amber",
      cancellationOutput: "Pi partial before cancellation",
      firstUsageInput: 11,
      resumedUsageInput: 3,
    },
    cancellationReady,
  };
}

function claudeFixture() {
  const observed = observation();
  let openCancellation = () => {};
  const cancellationReady = new Promise<void>((resolve) => {
    openCancellation = resolve;
  });
  const sessionId = "00000000-0000-4000-8000-000000000077";
  let marker: string | undefined;
  let attempt = 0;
  const query: ClaudeQuery = ({ prompt, options }) => {
    const currentAttempt = attempt++;
    if (currentAttempt === 0 && options?.resume !== undefined)
      throw new Error("first Claude attempt unexpectedly resumed");
    if (currentAttempt > 0 && options?.resume !== sessionId)
      throw new Error("Claude resume did not use retained continuation");
    observed.executionStarted();
    let releaseAbort = () => {};
    const aborted = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    options?.abortController?.signal.addEventListener("abort", releaseAbort, {
      once: true,
    });
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      observed.executionSettled();
    };
    return {
      async *[Symbol.asyncIterator]() {
        try {
          if (typeof prompt === "string")
            throw new Error("Claude managed Run did not use streaming input");
          const first = await prompt[Symbol.asyncIterator]().next();
          if (first.done)
            throw new Error("Claude input omitted the Run prompt");
          const content = first.value.message.content;
          const block = Array.isArray(content) ? content[0] : undefined;
          const text = block && block.type === "text" ? block.text : "";
          const remembered = text.match(/remember (\S+)/)?.[1];
          if (remembered) marker = remembered;
          yield {
            type: "system",
            subtype: "init",
            model: "claude-managed-fixture",
            session_id: sessionId,
            uuid: "00000000-0000-4000-8000-000000000078",
          } as unknown as SDKMessage;
          if (text === "wait until cancelled") {
            yield {
              type: "assistant",
              message: {
                id: "managed-claude-partial",
                model: "claude-managed-fixture",
                content: [
                  {
                    type: "text",
                    text: "Claude partial before cancellation",
                  },
                ],
              },
              parent_tool_use_id: null,
              session_id: sessionId,
              uuid: "00000000-0000-4000-8000-000000000076",
            } as unknown as SDKMessage;
            openCancellation();
            await aborted;
            return;
          }
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result:
              currentAttempt === 0
                ? "first Claude answer"
                : `Claude retained marker: ${marker ?? "missing"}`,
            num_turns: 1,
            total_cost_usd: 0,
            modelUsage: {
              "claude-managed-fixture": {
                inputTokens: currentAttempt === 0 ? 11 : 3,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                costUSD: 0,
              },
            },
            stop_reason: "end_turn",
            session_id: sessionId,
            uuid: "00000000-0000-4000-8000-000000000079",
          };
        } finally {
          settle();
        }
      },
      close() {
        releaseAbort();
        settle();
      },
    } as unknown as Query;
  };
  return {
    harness: observeAdapterClose(
      createClaudeHarness(async () => query),
      observed,
    ),
    observation: observed,
    expectation: {
      resume: "supported" as const,
      firstOutput: "first Claude answer",
      secondOutput: "Claude retained marker: amber",
      cancellationOutput: "Claude partial before cancellation",
      firstUsageInput: 11,
      resumedUsageInput: 3,
    },
    cancellationReady,
  };
}

runManagedSubagentConformance({ name: "controlled", build: controlledFixture });
runManagedSubagentConformance({
  name: "controlled-unsupported",
  build: unsupportedFixture,
});
runManagedSubagentConformance({ name: "codex", build: codexFixture });
runManagedSubagentConformance({ name: "pi", build: piFixture });
runManagedSubagentConformance({ name: "claude", build: claudeFixture });
