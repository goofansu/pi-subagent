import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcessSpawn } from "../child-process.ts";
import type { RunEnding } from "../run.ts";
import { createClaudeHarness } from "./claude/harness.ts";
import { createCodexHarness } from "./codex/harness.ts";
import type { Harness, HarnessAdapter } from "./contract.ts";
import {
  type ManagedConformanceObservation,
  runManagedSubagentConformance,
} from "./managed-conformance.ts";
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
              const remembered = task.prompt.match(/remember (\S+)/)?.[1];
              if (remembered) marker = remembered;
              const text = remembered
                ? "first controlled answer"
                : `controlled retained marker: ${marker ?? "missing"}`;
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text }],
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
  let marker: string | undefined;
  let attempt = 0;
  const spawn: ChildProcessSpawn = () => {
    const currentAttempt = attempt++;
    observed.executionStarted();
    const threadId = "managed-provider-thread";
    const turnId = `managed-provider-turn-${currentAttempt + 1}`;
    const child = fakeChild((request, current) => {
      if (request.method === "initialize") {
        send(current, initializeResponse(request.id));
      } else if (request.method === "thread/start") {
        send(current, { id: request.id, result: { thread: { id: threadId } } });
      } else if (request.method === "thread/resume") {
        send(current, { id: request.id, result: { thread: { id: threadId } } });
      } else if (request.method === "turn/start") {
        const input = (request.params as { input: Array<{ text: string }> })
          .input;
        const prompt = input[0]?.text ?? "";
        const remembered = prompt.match(/remember (\S+)/)?.[1];
        if (remembered) marker = remembered;
        const text =
          currentAttempt === 0
            ? "first Codex answer"
            : `Codex retained marker: ${marker ?? "missing"}`;
        send(current, {
          id: request.id,
          result: { turn: { id: turnId, status: "inProgress" } },
        });
        send(current, {
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              type: "agentMessage",
              id: `managed-answer-${currentAttempt + 1}`,
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
            turn: { id: turnId, items: [], status: "completed", error: null },
          },
        });
      }
    });
    child.stdin.on("finish", () => child.finish(0));
    child.once("close", () => observed.executionSettled());
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
    },
  };
}

function piFixture() {
  const observed = observation();
  const spawn: ChildProcessSpawn = () => {
    observed.executionStarted();
    const child = fakeChild();
    child.stdin.once("finish", () => {
      send(child, {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "first Pi answer" }],
            provider: "fixture",
            model: "fixture",
            stopReason: "stop",
          },
        ],
      });
      child.finish(0);
    });
    child.once("close", () => observed.executionSettled());
    return child as unknown as ChildProcess;
  };
  return {
    harness: observeAdapterClose(createPiHarness({ spawn }), observed),
    observation: observed,
    expectation: {
      resume: "unsupported" as const,
      firstOutput: "first Pi answer",
    },
  };
}

function claudeFixture() {
  const observed = observation();
  const query = (() => {
    observed.executionStarted();
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "first Claude answer",
            num_turns: 1,
            total_cost_usd: 0,
            modelUsage: {},
            stop_reason: "end_turn",
          };
        } finally {
          observed.executionSettled();
        }
      },
      close() {},
    } as unknown as Query;
  }) as unknown as () => Query;
  return {
    harness: observeAdapterClose(
      createClaudeHarness(async () => query),
      observed,
    ),
    observation: observed,
    expectation: {
      resume: "unsupported" as const,
      firstOutput: "first Claude answer",
    },
  };
}

runManagedSubagentConformance({ name: "controlled", build: controlledFixture });
runManagedSubagentConformance({ name: "codex", build: codexFixture });
runManagedSubagentConformance({ name: "pi", build: piFixture });
runManagedSubagentConformance({ name: "claude", build: claudeFixture });
