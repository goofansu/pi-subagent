/**
 * Pi harness tests: how the CLI is located, what argv it is given, how its
 * NDJSON becomes facts, and how its process source settles a run.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessSpawn } from "../../child-process.ts";
import { createControlGate } from "../../control-mailbox.ts";
import { formatNotification, fullOutput } from "../../presentation.ts";
import {
  createEmptyResult,
  createRunReporter,
  DEPTH_ENV_KEY,
  settleResultLifecycle,
} from "../../run.ts";
import type { AgentConfig, SingleResult } from "../../types.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "../conformance.ts";
import {
  buildPiArgs,
  getPiInvocation,
  type PiInvocationRuntime,
  runPiAgent,
  translatePiJsonEvent,
} from "./agent.ts";
import { createPiHarness } from "./harness.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Worker",
    systemPrompt: "Work.",
    ...overrides,
  };
}

function createPiScriptRuntime(
  relativeScriptPath: string[],
  execPath: string,
): { runtime: PiInvocationRuntime; cleanup: () => void } {
  const packageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi runtime with spaces-"),
  );
  const scriptPath = path.join(packageDir, ...relativeScriptPath);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "// Pi CLI fixture\n");

  return {
    runtime: {
      execPath,
      argv: [execPath, scriptPath],
      packageDir,
      isPiCli: true,
    },
    cleanup: () => fs.rmSync(packageDir, { recursive: true, force: true }),
  };
}

test("getPiInvocation reuses the active Node Pi CLI script", (t) => {
  const fixture = createPiScriptRuntime(
    ["dist", "cli.js"],
    path.join(os.tmpdir(), "Node Runtime", "node"),
  );
  t.after(fixture.cleanup);

  const invocation = getPiInvocation(["--mode", "json"], fixture.runtime);

  assert.equal(invocation.command, fixture.runtime.execPath);
  assert.deepEqual(invocation.args, [
    fixture.runtime.argv[1],
    "--mode",
    "json",
  ]);
});

test("getPiInvocation reuses a Bun-hosted Pi CLI script", (t) => {
  const fixture = createPiScriptRuntime(
    ["src", "bun", "cli.ts"],
    path.join(os.tmpdir(), "Bun Runtime", "bun"),
  );
  t.after(fixture.cleanup);

  const invocation = getPiInvocation(["-p"], fixture.runtime);

  assert.equal(invocation.command, fixture.runtime.execPath);
  assert.deepEqual(invocation.args, [fixture.runtime.argv[1], "-p"]);
});

test("getPiInvocation reuses a native Pi runtime", () => {
  const args = ["--mode", "json"];
  const execPath = path.join(os.tmpdir(), "Pi Native Runtime", "pi.exe");

  const invocation = getPiInvocation(args, {
    execPath,
    argv: [execPath, "/$bunfs/root/pi/dist/bun/cli.js"],
    packageDir: path.dirname(execPath),
    isPiCli: true,
  });

  assert.equal(invocation.command, execPath);
  assert.strictEqual(invocation.args, args);
});

test("getPiInvocation does not respawn an SDK embedding host", (t) => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-package-"));
  const hostPath = path.join(packageDir, "embedding host.js");
  fs.writeFileSync(hostPath, "// Application embedding Pi through the SDK\n");
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));

  const args = ["--mode", "json"];
  const invocation = getPiInvocation(args, {
    execPath: "/usr/bin/node",
    argv: ["/usr/bin/node", hostPath],
    packageDir,
    isPiCli: false,
  });

  assert.equal(invocation.command, "pi");
  assert.strictEqual(invocation.args, args);

  // Even an inherited marker is not enough to trust an arbitrary host.
  const nativeHostInvocation = getPiInvocation(args, {
    execPath: "/Applications/embedding-host",
    argv: ["/Applications/embedding-host"],
    packageDir,
    isPiCli: true,
  });
  assert.equal(nativeHostInvocation.command, "pi");
  assert.strictEqual(nativeHostInvocation.args, args);
});

test("getPiInvocation falls back when the argv script is absent or missing", (t) => {
  const packageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-missing-script-"),
  );
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));
  const execPath = "/usr/bin/node";
  const args = ["-p"];

  for (const argv of [
    [execPath],
    [execPath, path.join(packageDir, "dist", "cli.js")],
  ]) {
    const invocation = getPiInvocation(args, {
      execPath,
      argv,
      packageDir,
      isPiCli: true,
    });
    assert.equal(invocation.command, "pi");
    assert.strictEqual(invocation.args, args);
  }
});

test("getPiInvocation preserves child arguments and command boundaries", (t) => {
  const fixture = createPiScriptRuntime(
    ["dist", "cli.js"],
    path.join(os.tmpdir(), "Node Runtime With Spaces", "node"),
  );
  t.after(fixture.cleanup);
  const args = [
    "--model",
    "provider/model with spaces",
    "",
    "$(not-a-shell-command)",
  ];
  const originalArgs = [...args];

  const invocation = getPiInvocation(args, fixture.runtime);

  assert.equal(invocation.command, fixture.runtime.execPath);
  assert.deepEqual(invocation.args, [fixture.runtime.argv[1], ...originalArgs]);
  assert.deepEqual(args, originalArgs);
});

function emitLines(...lines: string[]): string {
  return lines
    .map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`)
    .join("\n");
}

async function runPiFixture(
  script: string,
  options: {
    signal?: AbortSignal;
    onEmit?: (result: SingleResult) => void;
    prompt?: string;
    killEscalationMs?: number;
    spawn?: ChildProcessSpawn;
  } = {},
): Promise<SingleResult> {
  const injectedSpawn: ChildProcessSpawn =
    options.spawn ??
    ((_command, _args, spawnOptions) =>
      realSpawn(process.execPath, ["-e", script], spawnOptions));
  const result = createEmptyResult("worker", "Work", 0);
  const report = createRunReporter(result, () => options.onEmit?.(result));

  const ending = await runPiAgent(
    {
      task: {
        config: agent({ systemPrompt: "" }),
        description: "Work",
        prompt: options.prompt ?? "do it",
        cwd: os.tmpdir(),
        childDepth: 1,
        projectTrusted: false,
      },
      report,
      signal: options.signal,
      controls: createControlGate([]).controls,
    },
    {
      ...(options.killEscalationMs === undefined
        ? {}
        : { killEscalationMs: options.killEscalationMs }),
      spawn: injectedSpawn,
    },
  );
  // What the dispatcher does with the ending, so assertions stay written
  // in result terms.
  settleResultLifecycle(result, ending, 1);
  return result;
}

interface FakePiChild extends ChildProcess {
  finish(code: number | null): void;
}

function fakePiChild(onKill: () => void): FakePiChild {
  const child = new EventEmitter() as unknown as FakePiChild;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let finished = false;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 1,
    kill: () => {
      onKill();
      return true;
    },
    finish: (code: number | null) => {
      if (finished) return;
      finished = true;
      stdout.end();
      stderr.end();
      queueMicrotask(() => child.emit("close", code, null));
    },
  });
  return child;
}

function piConformanceRig(): HarnessConformanceRig {
  return {
    name: "pi",
    build(
      scenario: HarnessConformanceScenario,
    ): HarnessConformanceFixture | undefined {
      let observedDepth: number | undefined;
      let ready: Promise<void> | undefined;
      let openReady = () => {};
      let releaseSteering = () => {};
      const childInputChunks: string[] = [];
      if (
        scenario === "abort-mid-run" ||
        scenario === "terminal-answer-then-abort" ||
        scenario.startsWith("steering-")
      ) {
        ready = new Promise<void>((resolve) => {
          openReady = resolve;
        });
      }

      const terminal = (text = "pi answer") => ({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text }],
            provider: "fixture-provider",
            model: "fixture-model",
            stopReason: "stop",
          },
        ],
      });
      const fixtureUsage = (text: string, usage: Record<string, unknown>) => ({
        role: "assistant",
        content: [{ type: "text", text }],
        usage,
      });

      const spawn: ChildProcessSpawn = (_command, _args, options) => {
        observedDepth = Number(options.env?.[DEPTH_ENV_KEY]);
        assert.equal(
          options.env?.PATH,
          process.env.PATH,
          "pi child env must inherit the parent environment",
        );
        let child!: FakePiChild;
        child = fakePiChild(() => {
          if (scenario === "abort-mid-run") child.finish(null);
          if (scenario === "terminal-answer-then-abort") child.finish(143);
        });
        const childStdin = child.stdin as PassThrough;
        childStdin.setEncoding("utf8");
        childStdin.on("data", (chunk) => childInputChunks.push(String(chunk)));

        queueMicrotask(() => {
          switch (scenario) {
            case "backend-crash":
              (child.stderr as PassThrough).write("fixture pi crash\n");
              child.finish(1);
              break;
            case "abort-mid-run":
              (child.stdout as PassThrough).write("silent child tail");
              openReady();
              break;
            case "terminal-answer-then-abort":
              (child.stdout as PassThrough).write(
                `${JSON.stringify(terminal())}\n`,
              );
              openReady();
              break;
            case "usage-totals": {
              const first = fixtureUsage("first turn", {
                input: 7,
                output: 3,
                cacheRead: 2,
                cacheWrite: 1,
                totalTokens: 10,
                cost: { total: 0.2 },
              });
              const second = fixtureUsage("second turn", {
                input: 5,
                output: 4,
                cacheRead: 1,
                cacheWrite: 2,
                totalTokens: 20,
                cost: { total: 0.3 },
              });
              (child.stdout as PassThrough).write(
                `${JSON.stringify({ type: "message_end", message: first })}\n`,
              );
              (child.stdout as PassThrough).write(
                `${JSON.stringify({ type: "message_end", message: second })}\n`,
              );
              (child.stdout as PassThrough).write(
                `${JSON.stringify({
                  type: "agent_end",
                  messages: [first, second],
                })}\n`,
              );
              child.finish(0);
              break;
            }
            case "child-depth":
            case "config-immutable":
            case "post-answer-failure":
              (child.stdout as PassThrough).write(
                `${JSON.stringify(terminal())}\n`,
              );
              child.finish(scenario === "post-answer-failure" ? 7 : 0);
              break;
            case "no-terminal-answer":
              child.finish(0);
              break;
            case "terminal-transcript-healing":
              (child.stdout as PassThrough).write(
                `${JSON.stringify({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [],
                    stopReason: "error",
                    errorMessage: "stale streamed error",
                  },
                })}\n`,
              );
              (child.stdout as PassThrough).write(
                `${JSON.stringify(terminal("healed terminal answer"))}\n`,
              );
              child.finish(0);
              break;
            case "steering-single-consumed":
            case "steering-fifo-consumed":
              releaseSteering = () => {
                (child.stdout as PassThrough).write(
                  `${JSON.stringify(terminal("unsupported steering answer"))}\n`,
                );
                child.finish(0);
              };
              openReady();
              break;
          }
        });
        return child;
      };

      const base = (
        expected: HarnessConformanceFixture["expected"],
      ): HarnessConformanceFixture => ({
        harness: createPiHarness({ spawn }),
        expected,
        ...(ready ? { readyForCancellation: ready } : {}),
        depthProbe: () => observedDepth,
      });

      switch (scenario) {
        case "backend-crash":
          return base({
            phase: "failed",
            errorMessage: "Child pi exited with code 1",
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
            finalOutput: "pi answer",
            stopReason: "stop",
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
              contextTokens: 20,
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
              "Child pi exited with code 0 without a valid terminal agent_end event (with a messages array).",
          });
        case "post-answer-failure":
          return base({
            phase: "completed",
            finalOutput: "pi answer",
            stopReason: "stop",
            errorMessage: undefined,
            stderrExcludes: "Last stdout:",
          });
        case "terminal-transcript-healing":
          return base({
            phase: "completed",
            finalOutput: "healed terminal answer",
            stopReason: "stop",
            errorMessage: undefined,
          });
        case "steering-single-consumed":
        case "steering-fifo-consumed": {
          const offeredTexts =
            scenario === "steering-single-consumed"
              ? ["first guidance"]
              : ["first guidance", "second guidance"];
          const fixture = base({
            phase: "completed",
            finalOutput: "unsupported steering answer",
            userFactTexts: [],
          });
          return {
            ...fixture,
            steering: {
              ready: ready as Promise<void>,
              offeredTexts,
              expectedOutcome: "unsupported",
              release: () => releaseSteering(),
              receivedTexts: () => childInputChunks.slice(1),
              providerControlStarts: () =>
                Math.max(0, childInputChunks.length - 1),
              maxConcurrentProviderControls: () => 0,
            },
          };
        }
      }
    },
  };
}

runHarnessConformance(piConformanceRig());

test("the child pi source accepts exit 0 after a valid agent_end event", async () => {
  const terminalEvent = JSON.stringify({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "fixture completed" }],
        provider: "fixture-provider",
        model: "fixture-model",
        stopReason: "stop",
      },
    ],
  });

  const settled = await runPiFixture(emitLines(terminalEvent));
  assert.equal(settled.stopReason, "stop");
  assert.equal(settled.errorMessage, undefined);
  assert.equal(settled.messages.length, 1);
});

test("a retained terminal error beats the generic child exit diagnostic", async () => {
  const terminalError = {
    role: "assistant",
    content: [],
    provider: "fixture-provider",
    model: "fixture-model",
    stopReason: "error",
    errorMessage: "provider says the request was rejected",
  };
  const result = await runPiFixture(
    `${emitLines(JSON.stringify({ type: "agent_end", messages: [terminalError] }))}
process.exitCode = 7;`,
  );

  assert.equal(result.lifecycle.phase, "failed");
  assert.equal(result.errorMessage, "provider says the request was rejected");
  assert.equal(result.stopReason, "error");
});

test("toolResult messages survive streamed delivery and transcript healing", async () => {
  const assistant = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
    provider: "fixture-provider",
    model: "fixture-model",
    stopReason: "toolUse",
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    isError: false,
  };
  const settled = await runPiFixture(
    emitLines(
      JSON.stringify({ type: "message_end", message: assistant }),
      JSON.stringify({ type: "message_end", message: toolResult }),
      JSON.stringify({ type: "agent_end", messages: [assistant, toolResult] }),
    ),
  );

  assert.equal(settled.lifecycle.phase, "completed");
  assert.deepEqual(
    settled.messages.map((message) => message.role),
    ["assistant", "tool"],
  );
  assert.deepEqual(settled.messages[1]?.parts, [
    { type: "text", text: "file contents" },
  ]);
});

test("a thinking-only message keeps its terminal metadata and usage", async () => {
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "planning" }],
    provider: "fixture-provider",
    model: "fixture-model",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 21,
      cost: { total: 0.12 },
    },
    stopReason: "stop",
  };
  const settled = await runPiFixture(
    emitLines(JSON.stringify({ type: "agent_end", messages: [message] })),
  );

  assert.equal(settled.lifecycle.phase, "completed");
  assert.deepEqual(settled.messages[0]?.parts, []);
  assert.equal(settled.stopReason, "stop");
  assert.equal(settled.usage.input, 11);
  assert.equal(settled.usage.output, 7);
  assert.equal(settled.usage.contextTokens, 21);
  assert.equal(settled.usage.cost, 0.12);
  assert.equal(settled.usage.turns, 1);
});

test("an error-bearing empty message fails an otherwise clean child", async () => {
  const message = {
    role: "assistant",
    content: [],
    provider: "fixture-provider",
    model: "fixture-model",
    usage: {
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { total: 0.05 },
    },
    stopReason: "error",
    errorMessage: "fixture in-band error",
  };
  const settled = await runPiFixture(
    emitLines(JSON.stringify({ type: "agent_end", messages: [message] })),
  );

  assert.equal(settled.lifecycle.phase, "failed");
  assert.deepEqual(settled.messages[0]?.parts, []);
  assert.equal(settled.errorMessage, "fixture in-band error");
  assert.equal(settled.stopReason, "error");
  assert.equal(settled.usage.input, 5);
  assert.equal(settled.usage.turns, 1);
});

test("the child pi source fails exit 0 without an agent_end event", async () => {
  const nonterminalEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial output" }],
      stopReason: "stop",
    },
  });

  const settled = await runPiFixture(emitLines(nonterminalEvent));
  assert.equal(settled.stopReason, "stop");
  assert.equal(settled.messages.length, 1);
  assert.match(settled.errorMessage ?? "", /valid terminal agent_end event/);
  assert.doesNotMatch(settled.errorMessage ?? "", /"type":"message_end"/);
  assert.match(fullOutput(settled), /partial output/);
  assert.match(fullOutput(settled), /Last stdout:/);
  assert.doesNotMatch(formatNotification("a1", settled), /partial output/);
});

test("a translated nonterminal event preserves stdout on a nonzero exit", async () => {
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial failure" }],
      stopReason: "stop",
    },
  });

  const settled = await runPiFixture(
    `${emitLines(event)}
process.exitCode = 7;`,
  );
  assert.equal(settled.lifecycle.phase, "failed");
  assert.equal(settled.errorMessage, "Child pi exited with code 7");
  assert.match(fullOutput(settled), /Last stdout:/);
  assert.match(fullOutput(settled), /partial failure/);
});

test("a translated error event preserves stdout on a nonzero exit", async () => {
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "translated failure",
    },
  });

  const settled = await runPiFixture(
    `${emitLines(event)}
process.exitCode = 7;`,
  );
  assert.equal(settled.lifecycle.phase, "failed");
  assert.equal(settled.errorMessage, "translated failure");
  assert.match(fullOutput(settled), /Last stdout:/);
});

test("the child pi source rejects a structurally invalid agent_end event", async () => {
  const fakeTerminalEvent = JSON.stringify({
    type: "agent_end",
    messages: { role: "assistant" },
  });

  const settled = await runPiFixture(emitLines(fakeTerminalEvent));
  assert.equal(settled.stopReason, undefined);
  assert.equal(settled.messages.length, 0);
  assert.match(settled.errorMessage ?? "", /valid terminal agent_end event/);
  assert.doesNotMatch(settled.errorMessage ?? "", /"messages":\{"role"/);
  assert.match(fullOutput(settled), /Last stdout:/);
  assert.match(fullOutput(settled), /"messages":\{"role"/);
});

test("a clean child without a terminal answer reports the no-output fallback", async () => {
  const settled = await runPiFixture("");

  assert.equal(settled.lifecycle.phase, "failed");
  assert.match(fullOutput(settled), /No stdout was captured\./);
});

test("the child pi source retains a bounded malformed stdout tail", async () => {
  const malformedOutput = `malformed-${"x".repeat(3000)}-diagnostic-tail`;

  const settled = await runPiFixture(emitLines(malformedOutput));
  assert.equal(settled.stopReason, undefined);
  assert.doesNotMatch(settled.errorMessage ?? "", /diagnostic-tail/);
  assert.match(fullOutput(settled), /Last stdout:/);
  assert.match(fullOutput(settled), /diagnostic-tail/);
  assert.doesNotMatch(fullOutput(settled), /malformed-/);
});

test("a signal death without abort is hidden by an earlier terminal answer", async () => {
  const terminalEvent = JSON.stringify({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer before signal death" }],
        provider: "fixture-provider",
        model: "fixture-model",
        stopReason: "stop",
      },
    ],
  });
  const settled = await runPiFixture(
    `${emitLines(terminalEvent)}
process.kill(process.pid, "SIGKILL");`,
  );

  assert.equal(settled.lifecycle.phase, "completed");
  assert.equal(settled.errorMessage, undefined);
  assert.doesNotMatch(fullOutput(settled), /Last stdout:/);
});

test("a terminal answer suppresses stdout on a nonzero exit", async () => {
  const terminalEvent = JSON.stringify({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer before failure" }],
        stopReason: "stop",
      },
    ],
  });

  const settled = await runPiFixture(
    `${emitLines(terminalEvent)}
process.exitCode = 7;`,
  );
  assert.equal(settled.lifecycle.phase, "completed");
  assert.doesNotMatch(fullOutput(settled), /Last stdout:/);
});

test("a process error keeps Pi's stderr-only fallback policy", async () => {
  const spawn: ChildProcessSpawn = () => {
    const child = fakePiChild(() => {});
    queueMicrotask(() => child.emit("error", new Error("fixture spawn error")));
    return child;
  };

  const settled = await runPiFixture("", { spawn });

  assert.equal(settled.lifecycle.phase, "failed");
  assert.equal(settled.errorMessage, undefined);
  assert.match(settled.stderr, /fixture spawn error/);
});

test("the child pi source preserves a nonzero child exit", async () => {
  const settled = await runPiFixture(
    `process.stdout.write("{not-json}\\n");
process.stderr.write("fixture failure\\n");
process.exitCode = 7;`,
  );
  assert.equal(settled.stopReason, undefined);
  assert.equal(settled.errorMessage, "Child pi exited with code 7");
  assert.match(settled.stderr, /fixture failure/);
  assert.match(fullOutput(settled), /fixture failure/);
  assert.match(
    formatNotification("a1", settled),
    /failed: Child pi exited with code 7/,
  );
  assert.doesNotMatch(formatNotification("a1", settled), /fixture failure/);
});

test("the child pi source keeps cancellation authoritative over a missing agent_end", async () => {
  // The backend contract: cancellation is a resolved result. Rejecting would
  // strip `details` on the way through the host and take the partial transcript
  // with it, so this asserts the resolution rather than a throw.
  const controller = new AbortController();
  let abortedAfterOutput = false;
  const partialEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial before cancellation" }],
      stopReason: "stop",
    },
  });

  const settled = await runPiFixture(
    `${emitLines(partialEvent)}
setTimeout(() => {}, 30_000);`,
    {
      signal: controller.signal,
      onEmit: (result) => {
        if (result.messages.length > 0 && !controller.signal.aborted) {
          abortedAfterOutput = true;
          controller.abort();
        }
      },
    },
  );

  assert.equal(abortedAfterOutput, true);
  assert.equal(settled.lifecycle.phase, "cancelled");
  assert.equal(settled.stopReason, undefined);
  assert.match(settled.errorMessage ?? "", /Subagent was cancelled/);
  assert.doesNotMatch(settled.errorMessage ?? "", /agent_end/);
  assert.doesNotMatch(fullOutput(settled), /Last stdout:/);
});

test("an aborted child that ignores SIGTERM is killed by the escalation", async () => {
  const controller = new AbortController();
  const partialEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "trap installed" }],
      stopReason: "stop",
    },
  });

  // Ignore SIGTERM so only the SIGKILL escalation can end the child.
  const settled = await runPiFixture(
    `process.on("SIGTERM", () => {});
${emitLines(partialEvent)}
setTimeout(() => {}, 30_000);`,
    {
      signal: controller.signal,
      killEscalationMs: 100,
      onEmit: (result) => {
        if (result.messages.length > 0 && !controller.signal.aborted) {
          controller.abort();
        }
      },
    },
  );

  assert.equal(settled.lifecycle.phase, "cancelled");
  assert.equal(settled.stopReason, undefined);
  assert.match(settled.errorMessage ?? "", /Subagent was cancelled/);
});

test("buildPiArgs forwards the parent's project trust decision", () => {
  const trusted = buildPiArgs(agent(), undefined, undefined, undefined, true);
  assert.equal(trusted.includes("--approve"), true);
  assert.equal(trusted.includes("--no-approve"), false);
  assert.equal(trusted.includes("--no-skills"), false);
  assert.equal(trusted.includes("--skill"), false);

  const untrusted = buildPiArgs(
    agent(),
    undefined,
    undefined,
    undefined,
    false,
  );
  assert.equal(untrusted.includes("--approve"), false);
  assert.equal(untrusted.includes("--no-approve"), true);
  // Pi's native discovery uses this trust decision to exclude project skills.
  assert.equal(untrusted.includes("--no-skills"), false);
  assert.equal(untrusted.includes("--skill"), false);

  // Unknown trust must fail closed.
  const unknown = buildPiArgs(agent(), undefined, undefined);
  assert.equal(unknown.includes("--approve"), false);
  assert.equal(unknown.includes("--no-approve"), true);
});

test("buildPiArgs passes the thinking level as its own flag", () => {
  const args = buildPiArgs(agent(), "sonnet", undefined, "high");

  assert.ok(args.includes("--thinking"));
  assert.equal(args[args.indexOf("--thinking") + 1], "high");
  // And never spliced into the model, which is what made a colon ambiguous.
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
});

test("buildPiArgs omits the thinking flag when no level applies", () => {
  const args = buildPiArgs(agent(), "sonnet", undefined, undefined);

  assert.equal(args.includes("--thinking"), false);
});

test("buildPiArgs shares tools trimming and empty-segment handling", () => {
  const args = buildPiArgs(
    agent({ tools: " read, , grep ,, " }),
    undefined,
    undefined,
  );

  assert.deepEqual(args.slice(-2), ["--tools", "read,grep"]);
});

test("buildPiArgs preserves an explicitly empty tools allowlist", () => {
  const args = buildPiArgs(agent({ tools: ", ," }), undefined, undefined);

  assert.deepEqual(args.slice(-2), ["--tools", ""]);
});

test("buildPiArgs passes tools and explicitly replaces native instructions", () => {
  const args = buildPiArgs(
    agent({
      name: "explore",
      description: "Explore code",
      tools: "read,grep,find,ls,bash",
      appendSystemPrompt: false,
      systemPrompt: "Search only.",
    }),
    "anthropic/claude",
    "/tmp/prompt.md",
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
    "--model",
    "anthropic/claude",
    "--tools",
    "read,grep,find,ls,bash",
    "--system-prompt",
    "/tmp/prompt.md",
  ]);
});

test("buildPiArgs appends the system prompt when appendSystemPrompt is omitted", () => {
  const args = buildPiArgs(agent(), undefined, "/tmp/prompt.md");

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
    "--append-system-prompt",
    "/tmp/prompt.md",
  ]);
});

test("buildPiArgs omits tools so a profile without them uses pi's own defaults", () => {
  assert.deepEqual(buildPiArgs(agent(), undefined, undefined), [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
  ]);
});

test("buildPiArgs does not include the prompt in argv", () => {
  // The prompt goes over stdin: argv is visible in process listings and is
  // bounded by the OS argument limit.
  const args = buildPiArgs(
    agent({ systemPrompt: "Do stuff." }),
    undefined,
    undefined,
  );

  assert.ok(
    !args.some((a) => a.includes("Do stuff")),
    "prompt must not appear in argv",
  );
});

test("Pi translates agent_end into a terminal transcript", () => {
  const translation = translatePiJsonEvent({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "final from agent_end" }],
        stopReason: "stop",
      },
    ],
  });

  assert.deepEqual(translation, {
    transcript: [
      {
        role: "assistant",
        parts: [{ type: "text", text: "final from agent_end" }],
        stopReason: "stop",
      },
    ],
    terminal: true,
  });
});

test("Pi context tokens are the latest gauge across multiple turns", () => {
  const current = createEmptyResult("general-purpose", "test", 0);
  const report = createRunReporter(current, () => {});
  const message = (text: string, totalTokens: number) => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { totalTokens },
    },
  });

  for (const translation of [
    translatePiJsonEvent(message("first", 10)),
    translatePiJsonEvent(message("second", 25)),
  ]) {
    for (const fact of translation?.facts ?? []) report.message(fact);
  }

  assert.equal(current.usage.contextTokens, 25);
});

test("the child pi source ignores an abort that arrives after a clean exit", async () => {
  const controller = new AbortController();
  const terminalEvent = JSON.stringify({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "finished before the abort" }],
        stopReason: "stop",
      },
    ],
  });

  const settled = await runPiFixture(emitLines(terminalEvent), {
    signal: controller.signal,
  });
  // A late cancellation must not retroactively fail a run that already
  // completed, which is what an abort listener left attached would do.
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled.stopReason, "stop");
  assert.equal(settled.errorMessage, undefined);
});

test("a child that exits before reading the prompt does not take the parent down", async () => {
  // Larger than a pipe buffer, so the write is still in flight when the child
  // goes away. Without a stdin error handler this surfaces as an unhandled
  // EPIPE in the parent process rather than a failed run.
  const oversizedPrompt = "x".repeat(1024 * 1024);
  const result = await runPiFixture("process.exit(3);", {
    prompt: oversizedPrompt,
  });
  assert.ok(
    result.errorMessage || result.stderr,
    "the run should report why it failed",
  );
});
