import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessSpawn } from "./child-process.ts";
import {
  buildCodexArgs,
  codexEffort,
  createCodexHarness,
  translateCodexJsonEvent,
} from "./codex-harness.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "./harness-conformance.ts";
import { DEPTH_ENV_KEY } from "./run.ts";
import { type AgentConfig, EFFORTS } from "./types.ts";

interface FakeCodexChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal: string): boolean;
  finish(code: number | null): void;
}

function fakeCodexChild(onKill: () => void): FakeCodexChild {
  const child = new EventEmitter() as FakeCodexChild;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let finished = false;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = (_signal) => {
    onKill();
    return true;
  };
  child.finish = (code) => {
    if (finished) return;
    finished = true;
    stdout.end();
    stderr.end();
    queueMicrotask(() => child.emit("close", code, null));
  };
  return child;
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function terminal(text = "codex answer"): Record<string, unknown> {
  return {
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text },
  };
}

function codexConformanceRig(): HarnessConformanceRig {
  return {
    name: "codex",
    build(
      scenario: HarnessConformanceScenario,
    ): HarnessConformanceFixture | undefined {
      let observedDepth: number | undefined;
      let ready: Promise<void> | undefined;
      let openReady = () => {};
      if (
        scenario === "abort-mid-run" ||
        scenario === "terminal-answer-then-abort"
      ) {
        ready = new Promise<void>((resolve) => {
          openReady = resolve;
        });
      }

      const spawn: ChildProcessSpawn = (_command, args, options) => {
        assert.deepEqual(args.slice(0, 6), [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          "-C",
          process.cwd(),
        ]);
        observedDepth = Number(options.env?.[DEPTH_ENV_KEY]);
        assert.equal(options.env?.PATH, process.env.PATH);
        let child!: FakeCodexChild;
        child = fakeCodexChild(() => {
          if (scenario === "abort-mid-run") child.finish(null);
          if (scenario === "terminal-answer-then-abort") child.finish(143);
        });
        queueMicrotask(() => {
          switch (scenario) {
            case "backend-crash":
              child.stdout.write("silent Codex crash diagnostic");
              child.finish(1);
              break;
            case "abort-mid-run":
              child.stdout.write("silent Codex child tail");
              openReady();
              break;
            case "terminal-answer-then-abort":
              child.stdout.write(json(terminal()));
              openReady();
              break;
            case "usage-totals":
              child.stdout.write(
                json({
                  type: "turn.completed",
                  usage: {
                    input_tokens: 12,
                    cached_input_tokens: 3,
                    cache_write_input_tokens: 3,
                    output_tokens: 7,
                    reasoning_output_tokens: 2,
                  },
                }),
              );
              child.stdout.write(json(terminal("usage answer")));
              child.finish(0);
              break;
            case "child-depth":
            case "config-immutable":
            case "post-answer-failure":
              child.stdout.write(json(terminal()));
              child.finish(scenario === "post-answer-failure" ? 7 : 0);
              break;
            case "no-terminal-answer":
              child.finish(0);
              break;
            case "terminal-transcript-healing":
              // Codex JSONL has no terminal transcript snapshot. Its closest
              // invariant is that the final terminal item remains an ordinary
              // streamed fact and wins final-output derivation without a
              // fabricated transcript replacement.
              child.stdout.write(json(terminal("codex draft")));
              child.stdout.write(json(terminal("codex final answer")));
              child.finish(0);
              break;
          }
        });
        return child as unknown as ChildProcess;
      };

      const base = (
        expected: HarnessConformanceFixture["expected"],
      ): HarnessConformanceFixture => ({
        harness: createCodexHarness({ spawn }),
        expected,
        ...(ready ? { readyForCancellation: ready } : {}),
        depthProbe: () => observedDepth,
      });

      switch (scenario) {
        case "backend-crash":
          return base({
            phase: "failed",
            errorMessage: "Child codex exited with code 1",
            stderrIncludes: "Last stdout:",
          });
        case "abort-mid-run":
          return base({
            phase: "cancelled",
            cancellationReason: "requested",
            stderrExcludes: "Last stdout:",
          });
        case "terminal-answer-then-abort":
          return base({
            phase: "completed",
            finalOutput: "codex answer",
            errorMessage: undefined,
          });
        case "usage-totals":
          return base({
            phase: "completed",
            usage: {
              input: 12,
              output: 9,
              cacheRead: 3,
              cacheWrite: 3,
              cost: 0,
              contextTokens: 0,
              turns: 1,
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
              "Codex exited without a terminal agent message answer.",
          });
        case "post-answer-failure":
          return base({
            phase: "completed",
            finalOutput: "codex answer",
            errorMessage: undefined,
            stderrExcludes: "Last stdout:",
          });
        case "terminal-transcript-healing":
          return base({
            phase: "completed",
            finalOutput: "codex final answer",
            messageCount: 2,
          });
      }
    },
  };
}

runHarnessConformance(codexConformanceRig());

test("Codex JSONL fixtures translate wire events into facts", () => {
  assert.deepEqual(
    translateCodexJsonEvent({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "printf hi",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }),
    {
      facts: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              name: "command_execution",
              arguments: { command: "printf hi" },
            },
          ],
          usage: { turns: 0 },
        },
      ],
    },
  );
  assert.deepEqual(
    translateCodexJsonEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    }),
    {
      facts: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
          usage: { turns: 0 },
        },
      ],
      terminal: true,
    },
  );
});

test("Codex terminal items are facts, not transcript snapshots", () => {
  const translation = translateCodexJsonEvent(terminal("final item"));
  assert.equal(translation?.terminal, true);
  assert.equal(translation?.transcript, undefined);
  assert.deepEqual(translation?.facts?.[0]?.parts, [
    { type: "text", text: "final item" },
  ]);
});

test("Codex usage adds reasoning output and counts each completed turn", () => {
  const translation = translateCodexJsonEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 33875,
      cached_input_tokens: 13824,
      cache_write_input_tokens: 0,
      output_tokens: 109,
      reasoning_output_tokens: 12,
    },
  });
  assert.deepEqual(translation?.facts, [
    {
      role: "metadata",
      parts: [],
      usage: {
        input: 33875,
        cacheRead: 13824,
        cacheWrite: 0,
        output: 121,
        turns: 1,
      },
    },
  ]);
});

test("Codex preserves provider error events as error facts", () => {
  const first = translateCodexJsonEvent({
    type: "error",
    message: "service unavailable",
  });
  const second = translateCodexJsonEvent({
    type: "turn.failed",
    error: { message: "turn rejected" },
  });
  assert.deepEqual(
    [first?.facts?.[0], second?.facts?.[0]],
    [
      {
        role: "metadata",
        parts: [],
        errorMessage: "service unavailable",
      },
      {
        role: "metadata",
        parts: [],
        errorMessage: "turn rejected",
      },
    ],
  );
});

test("Codex recognizes only model and effort profile fields", () => {
  const harness = createCodexHarness();
  const profile: AgentConfig = {
    name: "codex",
    description: "codex",
    harness: "codex",
    fields: { model: "future-model", effort: "high" },
    systemPrompt: "work",
  };
  assert.deepEqual(harness.validate(profile, "/agents/codex.md"), []);
  assert.deepEqual(
    harness.validate(
      { ...profile, fields: { tools: "Bash", appendSystemPrompt: true } },
      "/agents/codex.md",
    ),
    [
      { reason: "Codex harness does not recognize field 'tools'" },
      { reason: "Codex harness does not recognize field 'appendSystemPrompt'" },
    ],
  );
});

test("Codex maps off to none and preserves every other effort value", () => {
  assert.deepEqual(
    EFFORTS.map((effort) => [effort, codexEffort(effort)]),
    [
      ["off", "none"],
      ["minimal", "minimal"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ],
  );
});

test("Codex argv bypasses approvals for either forwarded trust value", () => {
  assert.deepEqual(
    buildCodexArgs("/project", "model-that-codex-validates", "off"),
    [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      "/project",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "model-that-codex-validates",
      "-c",
      "model_reasoning_effort=none",
      "-",
    ],
  );
  assert.deepEqual(buildCodexArgs("/project", undefined, "high"), [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    "/project",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "model_reasoning_effort=high",
    "-",
  ]);
});

test("Codex usage-only output keeps a raw tail on nonzero exit", async () => {
  const stderr: string[] = [];
  const spawn: ChildProcessSpawn = (_command, _args, _options) => {
    const child = fakeCodexChild(() => {});
    queueMicrotask(() => {
      child.stdout.write(
        json({
          type: "turn.completed",
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      );
      child.finish(7);
    });
    return child as unknown as ChildProcess;
  };
  const task = {
    config: {
      name: "worker",
      description: "worker",
      harness: "codex",
      fields: {},
      systemPrompt: "",
    },
    description: "work",
    prompt: "user prompt",
    cwd: "/project",
    childDepth: 1,
    projectTrusted: false,
  } as const;
  const ending = await createCodexHarness({ spawn })
    .prepare(task)
    .execute({
      task,
      report: {
        message: () => {},
        transcript: () => {},
        stderr: (chunk) => stderr.push(chunk),
      },
    });

  assert.deepEqual(ending, {
    ending: "failed",
    errorMessage: "Child codex exited with code 7",
  });
  assert.match(stderr.join(""), /Last stdout:/);
  assert.match(stderr.join(""), /turn.completed/);
});

test("Codex prepends its profile system prompt to stdin", async () => {
  let prompt = "";
  const spawn: ChildProcessSpawn = (_command, _args, options) => {
    const child = fakeCodexChild(() => {});
    child.stdin.on("data", (chunk) => {
      prompt += chunk.toString();
    });
    queueMicrotask(() => {
      child.stdout.write(json(terminal("ok")));
      child.finish(0);
    });
    assert.equal(options.cwd, "/project");
    return child as unknown as ChildProcess;
  };
  const harness = createCodexHarness({ spawn });
  const prepared = harness.prepare({
    config: {
      name: "worker",
      description: "worker",
      harness: "codex",
      fields: {},
      systemPrompt: "system instructions",
    },
    description: "work",
    prompt: "user prompt",
    cwd: "/project",
    childDepth: 1,
    projectTrusted: false,
  });
  await prepared.execute({
    task: {
      config: {
        name: "worker",
        description: "worker",
        harness: "codex",
        fields: {},
        systemPrompt: "system instructions",
      },
      description: "work",
      prompt: "user prompt",
      cwd: "/project",
      childDepth: 1,
      projectTrusted: false,
    },
    report: {
      message: () => {},
      transcript: () => {},
      stderr: () => {},
    },
  });
  assert.equal(prompt, "system instructions\n\nuser prompt");
});
