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
import {
  type AgentSessionEvent,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ChildProcessSpawn } from "../../child-process.ts";
import { createControlGate } from "../../control-source.ts";
import { getFinalOutput } from "../../messages.ts";
import { formatNotification, fullOutput } from "../../presentation.ts";
import {
  createEmptyResult,
  createRunReporter,
  DEPTH_ENV_KEY,
  settleResultLifecycle,
} from "../../run.ts";
import { createSubagentRuns } from "../../runs.ts";
import { startSubagent } from "../../standalone-run-helper.ts";
import { createSubagentManager } from "../../subagents.ts";
import type { AgentConfig, SingleResult } from "../../types.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "../conformance.ts";
import { createHarnessRegistry } from "../contract.ts";
import {
  buildPiArgs,
  createPiSessionOptions,
  filterPiChildExtensions,
  getPiInvocation,
  type PiInvocationRuntime,
  type PiSession,
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
      report,
      signal: options.signal,
      controls: createControlGate([]).controls,
    },
    {
      context: {
        config: agent({ systemPrompt: "" }),
        cwd: os.tmpdir(),
        childDepth: 1,
        projectTrusted: false,
      },
      task: {
        description: "Work",
        prompt: options.prompt ?? "do it",
      },
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
      if (
        scenario === "steering-single-consumed" ||
        scenario === "steering-fifo-consumed" ||
        scenario === "steering-intermediate-completion" ||
        scenario === "steering-admission-no-fact"
      ) {
        const offeredTexts =
          scenario === "steering-fifo-consumed"
            ? ["first guidance", "second guidance"]
            : ["first guidance"];
        const listeners = new Set<(event: AgentSessionEvent) => void>();
        const messages: unknown[] = [];
        const received: string[] = [];
        let providerStarts = 0;
        let activeProviderControls = 0;
        let maxActiveProviderControls = 0;
        let openReady = () => {};
        const ready = new Promise<void>((resolve) => {
          openReady = resolve;
        });
        let releaseFirst = () => {};
        const firstReleased = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let openIntermediate = () => {};
        const intermediateCheckpoint = new Promise<void>((resolve) => {
          openIntermediate = resolve;
        });
        let finishPrompt = () => {};
        const promptFinished = new Promise<void>((resolve) => {
          finishPrompt = resolve;
        });
        const emit = (event: unknown): void => {
          for (const listener of listeners)
            listener(event as AgentSessionEvent);
        };
        const session: PiSession = {
          get messages() {
            return messages as PiSession["messages"];
          },
          get isIdle() {
            return true;
          },
          async prompt(text) {
            messages.push({
              role: "user",
              content: [{ type: "text", text }],
            });
            openReady();
            await promptFinished;
          },
          async steer(text) {
            providerStarts++;
            activeProviderControls++;
            maxActiveProviderControls = Math.max(
              maxActiveProviderControls,
              activeProviderControls,
            );
            received.push(text);
            if (providerStarts === 1) openIntermediate();
            if (providerStarts === 1) await firstReleased;
            if (scenario !== "steering-admission-no-fact") {
              const user = {
                role: "user",
                content: [{ type: "text", text }],
              };
              messages.push(user);
              emit({ type: "message_end", message: user });
            }
            activeProviderControls--;
            if (providerStarts === offeredTexts.length) {
              const assistant = {
                role: "assistant",
                content: [{ type: "text", text: "controlled Pi answer" }],
                provider: "fixture",
                model: "fixture",
                stopReason: "stop",
              };
              messages.push(assistant);
              emit({ type: "message_end", message: assistant });
              emit({
                type: "agent_end",
                messages: [...messages],
                willRetry: false,
              });
              finishPrompt();
            }
          },
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async bindExtensions() {},
          async abort() {},
          async waitForIdle() {},
          clearQueue: () => ({ steering: [], followUp: [] }),
          dispose() {},
          extensionRunner: { async emit() {} },
        };
        return {
          harness: createPiHarness({
            sessionFactory: async () => ({ session }),
            sessionOptionsFactory: async () => ({}),
          }),
          expected: {
            phase: "completed",
            finalOutput: "controlled Pi answer",
            userFactTexts:
              scenario === "steering-admission-no-fact" ? [] : offeredTexts,
          },
          steering: {
            ready,
            offeredTexts,
            expectedOutcome: "accepted",
            release: releaseFirst,
            receivedTexts: () => received,
            providerControlStarts: () => providerStarts,
            maxConcurrentProviderControls: () => maxActiveProviderControls,
            ...(scenario === "steering-intermediate-completion"
              ? { intermediateCheckpoint }
              : {}),
          },
          depthProbe: () => undefined,
        };
      }
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const messages: unknown[] = [];
      let observedDepth: number | undefined;
      let openReady = () => {};
      const ready = new Promise<void>((resolve) => {
        openReady = resolve;
      });
      let releasePrompt = () => {};
      const promptReleased = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      const emit = (event: unknown): void => {
        for (const listener of listeners) listener(event as AgentSessionEvent);
      };
      const assistant = (text: string, usage?: Record<string, unknown>) => ({
        role: "assistant",
        content: [{ type: "text", text }],
        provider: "fixture-provider",
        model: "fixture-model",
        stopReason: "stop",
        ...(usage ? { usage } : {}),
      });
      const terminal = (terminalMessages: unknown[]): void => {
        messages.push(...terminalMessages);
        emit({
          type: "agent_end",
          messages: [...messages],
          willRetry: false,
        });
      };
      const session: PiSession = {
        get messages() {
          return messages as PiSession["messages"];
        },
        get isIdle() {
          return true;
        },
        async prompt() {
          switch (scenario) {
            case "backend-crash":
              throw new Error("Pi SDK backend crashed");
            case "abort-mid-run":
              openReady();
              await promptReleased;
              return;
            case "terminal-answer-then-abort": {
              const answer = assistant("pi answer");
              emit({ type: "message_end", message: answer });
              terminal([answer]);
              openReady();
              await promptReleased;
              return;
            }
            case "usage-totals": {
              const first = assistant("first turn", {
                input: 7,
                output: 3,
                cacheRead: 2,
                cacheWrite: 1,
                totalTokens: 10,
                cost: { total: 0.2 },
              });
              const second = assistant("second turn", {
                input: 5,
                output: 4,
                cacheRead: 1,
                cacheWrite: 2,
                totalTokens: 20,
                cost: { total: 0.3 },
              });
              emit({ type: "message_end", message: first });
              emit({ type: "message_end", message: second });
              terminal([first, second]);
              return;
            }
            case "child-depth":
            case "config-immutable": {
              const answer = assistant("pi answer");
              emit({ type: "message_end", message: answer });
              terminal([answer]);
              return;
            }
            case "no-terminal-answer":
              return;
            case "post-answer-failure": {
              const partial = assistant("partial answer");
              emit({ type: "message_end", message: partial });
              throw new Error("Pi SDK backend failed after answer");
            }
            case "terminal-transcript-healing": {
              emit({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [],
                  stopReason: "error",
                  errorMessage: "stale streamed error",
                },
              });
              terminal([assistant("healed terminal answer")]);
              return;
            }
          }
        },
        async steer() {},
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async bindExtensions() {},
        async abort() {
          releasePrompt();
        },
        async waitForIdle() {},
        clearQueue: () => ({ steering: [], followUp: [] }),
        dispose() {},
        extensionRunner: { async emit() {} },
      };
      const base = (
        expected: HarnessConformanceFixture["expected"],
      ): HarnessConformanceFixture => ({
        harness: createPiHarness({
          sessionFactory: async () => ({ session }),
          sessionOptionsFactory: async (context) => {
            observedDepth = context.childDepth;
            return {};
          },
        }),
        expected,
        ...(scenario === "abort-mid-run" ||
        scenario === "terminal-answer-then-abort"
          ? { readyForCancellation: ready }
          : {}),
        depthProbe: () => observedDepth,
      });

      switch (scenario) {
        case "backend-crash":
          return base({
            phase: "failed",
            errorMessage: "Pi SDK backend crashed",
          });
        case "abort-mid-run":
          return base({ phase: "cancelled", cancellationReason: "requested" });
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
          return base({ phase: "completed", finalOutput: "pi answer" });
        case "no-terminal-answer":
          return base({
            phase: "failed",
            errorMessage:
              "Child pi exited with code 0 without a valid terminal agent_end event (with a messages array).",
          });
        case "post-answer-failure":
          return base({
            phase: "failed",
            errorMessage: "Pi SDK backend failed after answer",
          });
        case "terminal-transcript-healing":
          return base({
            phase: "completed",
            finalOutput: "healed terminal answer",
            stopReason: "stop",
            errorMessage: undefined,
          });
      }
    },
  };
}

runHarnessConformance(piConformanceRig());

test("Pi child resource filtering removes this package by identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resource-filter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const self = path.join(root, "renamed-self");
  const other = path.join(root, "other");
  for (const directory of [self, other]) {
    fs.mkdirSync(path.join(directory, "extensions"), { recursive: true });
  }
  fs.writeFileSync(
    path.join(self, "package.json"),
    JSON.stringify({ name: "pi-subagent" }),
  );
  fs.writeFileSync(
    path.join(other, "package.json"),
    JSON.stringify({ name: "librarian-tools" }),
  );
  const selfExtension = path.join(self, "extensions", "index.ts");
  const otherExtension = path.join(other, "extensions", "librarian.ts");
  fs.writeFileSync(selfExtension, "");
  fs.writeFileSync(otherExtension, "");

  const filtered = filterPiChildExtensions({
    extensions: [
      { resolvedPath: selfExtension },
      { resolvedPath: otherExtension },
    ],
    errors: [],
    runtime: {},
  } as never);

  assert.deepEqual(
    filtered.extensions.map((extension) => extension.resolvedPath),
    [otherExtension],
  );
});

test("Pi SDK options preserve normal resources, trust, profile policy, and memory-only state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-options-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "native instructions");

  const options = await createPiSessionOptions(
    {
      config: agent({
        fields: {
          tools: "bash, read, agent_start",
          appendSystemPrompt: true,
        },
      }),
      cwd,
      childDepth: 3,
      projectTrusted: true,
    },
    undefined,
    "medium",
    agentDir,
  );

  assert.equal(options.settingsManager?.isProjectTrusted(), true);
  assert.equal(options.sessionManager?.getSessionFile(), undefined);
  assert.deepEqual(options.tools, ["bash", "read", "agent_start"]);
  assert.deepEqual(options.excludeTools, [
    "agent_start",
    "agent_resume",
    "agent_wait",
    "agent_result",
    "agent_cancel",
    "agent_steer",
  ]);
  assert.equal(options.customTools?.[0]?.name, "bash");
  assert.equal(options.thinkingLevel, "medium");
  assert.deepEqual(options.resourceLoader?.getAppendSystemPrompt(), ["Work."]);
  assert.equal(
    options.resourceLoader?.getSystemPrompt(),
    "native instructions",
  );
});

test("an empty Pi profile prompt keeps the discovered system prompt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-empty-prompt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "discovered instructions");

  const options = await createPiSessionOptions(
    {
      config: agent({ systemPrompt: "" }),
      cwd,
      childDepth: 1,
      projectTrusted: false,
    },
    undefined,
    undefined,
    agentDir,
  );

  assert.equal(options.settingsManager?.isProjectTrusted(), false);
  assert.equal(
    options.resourceLoader?.getSystemPrompt(),
    "discovered instructions",
  );
  assert.deepEqual(options.resourceLoader?.getAppendSystemPrompt(), []);
});

test("the installed Pi SDK enforces the tool deny-list and injects depth per Bash spawn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  const inheritedDepth = process.env[DEPTH_ENV_KEY];
  const options = await createPiSessionOptions(
    {
      config: agent({ fields: { tools: "bash, agent_start" } }),
      cwd,
      childDepth: 7,
      projectTrusted: true,
    },
    undefined,
    undefined,
    agentDir,
  );
  const { session } = await createAgentSession(options);
  try {
    await session.bindExtensions({ mode: "print" });
    assert.deepEqual(session.getActiveToolNames(), ["bash"]);
    const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
    assert.ok(bash);
    const result = await bash.execute("depth-probe", {
      command: `printf '%s' "$${DEPTH_ENV_KEY}"`,
    });
    assert.deepEqual(result.content[0], { type: "text", text: "7" });
    assert.equal(process.env[DEPTH_ENV_KEY], inheritedDepth);
  } finally {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
});

test("trusted Pi project resources keep a profile-selected extension tool while untrusted resources stay excluded", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-resource-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const extensionDir = path.join(cwd, ".pi", "extensions");
  const extensionPath = path.join(extensionDir, "librarian.js");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(
    extensionPath,
    `export default (pi) => {
      pi.registerTool({
        name: "librarian_lookup",
        label: "Librarian lookup",
        description: "Hermetic project extension fixture",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: "ok" }] }; },
      });
    };`,
  );
  const makeOptions = (projectTrusted: boolean, suffix: string) => {
    const agentDir = path.join(root, `agent-${suffix}`);
    fs.mkdirSync(agentDir);
    return createPiSessionOptions(
      {
        config: agent({ fields: { tools: "librarian_lookup" } }),
        cwd,
        childDepth: 1,
        projectTrusted,
      },
      undefined,
      undefined,
      agentDir,
    );
  };

  const trusted = await makeOptions(true, "trusted");
  const untrusted = await makeOptions(false, "untrusted");
  assert.equal(
    trusted.resourceLoader
      ?.getExtensions()
      .extensions.some((extension) => extension.resolvedPath === extensionPath),
    true,
  );
  assert.equal(
    untrusted.resourceLoader
      ?.getExtensions()
      .extensions.some((extension) => extension.resolvedPath === extensionPath),
    false,
  );

  const { session } = await createAgentSession(trusted);
  try {
    await session.bindExtensions({ mode: "print" });
    assert.deepEqual(session.getActiveToolNames(), ["librarian_lookup"]);
  } finally {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
});

test("Pi initialization and prompt failures clean the SDK session exactly once", async () => {
  for (const failure of ["bind", "prompt"] as const) {
    let binds = 0;
    let prompts = 0;
    let shutdowns = 0;
    let disposals = 0;
    const session: PiSession = {
      messages: [],
      isIdle: true,
      async prompt() {
        prompts++;
        if (failure === "prompt") throw new Error("prompt failed");
      },
      async steer() {},
      subscribe: () => () => {},
      async bindExtensions(bindings) {
        binds++;
        assert.deepEqual(bindings, { mode: "print" });
        if (failure === "bind") throw new Error("bind failed");
      },
      async abort() {},
      async waitForIdle() {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      dispose() {
        disposals++;
      },
      extensionRunner: {
        async emit() {
          shutdowns++;
        },
      },
    };
    const result = await startSubagent({
      config: agent({ harness: "pi" }),
      description: `${failure} failure`,
      prompt: "do it",
      harnesses: createHarnessRegistry([
        createPiHarness({
          sessionFactory: async () => ({ session }),
          sessionOptionsFactory: async () => ({}),
        }),
      ]),
      runs: createSubagentRuns(),
    }).settled;

    assert.equal(result.lifecycle.phase, "failed");
    assert.equal(result.errorMessage, `${failure} failed`);
    assert.equal(binds, 1);
    assert.equal(prompts, failure === "bind" ? 0 : 1);
    assert.equal(shutdowns, 1);
    assert.equal(disposals, 1);
  }
});

test("Pi cancellation during resource loading, session creation, or extension binding leaves no detached session", async () => {
  for (const phase of ["resources", "creation", "binding"] as const) {
    let openPhase = () => {};
    const phaseEntered = new Promise<void>((resolve) => {
      openPhase = resolve;
    });
    let releasePhase = () => {};
    const phaseReleased = new Promise<void>((resolve) => {
      releasePhase = resolve;
    });
    let creations = 0;
    let prompts = 0;
    let shutdowns = 0;
    let disposals = 0;
    const session: PiSession = {
      messages: [],
      isIdle: true,
      async prompt() {
        prompts++;
      },
      async steer() {},
      subscribe: () => () => {},
      async bindExtensions() {
        if (phase === "binding") {
          openPhase();
          await phaseReleased;
        }
      },
      async abort() {},
      async waitForIdle() {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      dispose() {
        disposals++;
      },
      extensionRunner: {
        async emit() {
          shutdowns++;
        },
      },
    };
    const runs = createSubagentRuns();
    const started = startSubagent({
      config: agent({ harness: "pi" }),
      description: `cancel during ${phase}`,
      prompt: "must not run",
      harnesses: createHarnessRegistry([
        createPiHarness({
          sessionOptionsFactory: async () => {
            if (phase === "resources") {
              openPhase();
              await phaseReleased;
            }
            return {};
          },
          sessionFactory: async () => {
            creations++;
            if (phase === "creation") {
              openPhase();
              await phaseReleased;
            }
            return { session };
          },
        }),
      ]),
      runs,
    });
    await phaseEntered;
    assert.deepEqual(runs.cancel([started.id], "requested"), [started.id]);
    releasePhase();
    const result = await started.settled;

    assert.equal(result.lifecycle.phase, "cancelled", phase);
    assert.equal(prompts, 0, phase);
    assert.equal(creations, phase === "resources" ? 0 : 1, phase);
    assert.equal(shutdowns, phase === "resources" ? 0 : 1, phase);
    assert.equal(disposals, phase === "resources" ? 0 : 1, phase);
  }
});

test("Pi orders Control and cancellation by ingress and never carries stale guidance into resume", async () => {
  for (let iteration = 0; iteration < 32; iteration++) {
    for (const order of ["control-first", "cancellation-first"] as const) {
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const operations: string[] = [];
      let pendingGuidance: string | undefined;
      let finishPrompt = () => {};
      let promptFinished = new Promise<void>((resolve) => {
        finishPrompt = resolve;
      });
      let openReady = () => {};
      const ready = new Promise<void>((resolve) => {
        openReady = resolve;
      });
      let releaseSteer = () => {};
      const steerReleased = new Promise<void>((resolve) => {
        releaseSteer = resolve;
      });
      let openSteerStarted = () => {};
      const steerStarted = new Promise<void>((resolve) => {
        openSteerStarted = resolve;
      });
      const messages: unknown[] = [];
      const emit = (event: unknown): void => {
        for (const listener of listeners) listener(event as AgentSessionEvent);
      };
      const session: PiSession = {
        get messages() {
          return messages as PiSession["messages"];
        },
        isIdle: true,
        async prompt(text) {
          operations.push(`prompt:${text}`);
          if (text === "first goal") {
            openReady();
            await promptFinished;
            return;
          }
          const answer = {
            role: "assistant",
            content: [
              {
                type: "text",
                text: pendingGuidance
                  ? `stale guidance: ${pendingGuidance}`
                  : "clean resumed answer",
              },
            ],
            provider: "fixture",
            model: "fixture",
            stopReason: "stop",
          };
          messages.push(answer);
          emit({ type: "message_end", message: answer });
          emit({
            type: "agent_end",
            messages: [...messages],
            willRetry: false,
          });
        },
        async steer(text) {
          operations.push("steer:start");
          openSteerStarted();
          await steerReleased;
          pendingGuidance = text;
          operations.push("steer:end");
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async bindExtensions() {},
        async abort() {
          operations.push("abort");
          finishPrompt();
        },
        async waitForIdle() {},
        clearQueue() {
          operations.push("clear");
          pendingGuidance = undefined;
          return { steering: [], followUp: [] };
        },
        dispose() {},
        extensionRunner: { async emit() {} },
      };
      const runs = createSubagentRuns();
      const manager = createSubagentManager({
        harnesses: createHarnessRegistry([
          createPiHarness({
            sessionFactory: async () => ({ session }),
            sessionOptionsFactory: async () => ({}),
          }),
        ]),
        runs,
        generateSubagentId: () => `pi-order-${iteration}-${order}`,
      });
      const first = manager.start({
        config: agent({ harness: "pi" }),
        description: "ordered cancellation",
        prompt: "first goal",
      });
      await ready;

      if (order === "control-first") {
        assert.equal(
          runs.offer(first.runId, {
            type: "steer",
            text: "must not reach resume",
          }),
          "accepted",
        );
        await steerStarted;
        assert.deepEqual(runs.cancel([first.runId], "requested"), [
          first.runId,
        ]);
        assert.equal(
          operations.includes("abort"),
          false,
          "cancellation must join in-flight steering before native abort",
        );
        releaseSteer();
      } else {
        assert.deepEqual(runs.cancel([first.runId], "requested"), [
          first.runId,
        ]);
        assert.notEqual(
          runs.offer(first.runId, {
            type: "steer",
            text: "rejected after cancellation",
          }),
          "accepted",
        );
        releaseSteer();
      }

      const cancelled = await first.settled;
      assert.equal(cancelled.lifecycle.phase, "cancelled");
      if (order === "control-first") {
        assert.ok(
          operations.indexOf("steer:end") < operations.lastIndexOf("clear"),
        );
        assert.ok(
          operations.lastIndexOf("clear") < operations.indexOf("abort"),
        );
      } else {
        assert.equal(operations.includes("steer:start"), false);
      }

      finishPrompt = () => {};
      promptFinished = Promise.resolve();
      const resumed = manager.resume({
        subagentId: first.subagentId,
        description: "resume cleanly",
        prompt: "second goal",
      });
      assert.equal(resumed.outcome, "started");
      if (resumed.outcome !== "started") assert.fail("Pi resume did not start");
      const resumedResult = await resumed.settled;
      assert.equal(
        getFinalOutput(resumedResult.messages),
        "clean resumed answer",
      );
      await manager.shutdown();
    }
  }
});

test("Pi cancellation remains honest when native abort rejects", async () => {
  let openReady = () => {};
  const ready = new Promise<void>((resolve) => {
    openReady = resolve;
  });
  let finishPrompt = () => {};
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  let aborts = 0;
  const session: PiSession = {
    messages: [],
    isIdle: true,
    async prompt() {
      openReady();
      await promptFinished;
    },
    async steer() {},
    subscribe: () => () => {},
    async bindExtensions() {},
    async abort() {
      aborts++;
      finishPrompt();
      throw new Error("native abort rejected");
    },
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {},
    extensionRunner: { async emit() {} },
  };
  const runs = createSubagentRuns();
  const started = startSubagent({
    config: agent({ harness: "pi" }),
    description: "abort failure",
    prompt: "wait",
    harnesses: createHarnessRegistry([
      createPiHarness({
        sessionFactory: async () => ({ session }),
        sessionOptionsFactory: async () => ({}),
      }),
    ]),
    runs,
  });
  await ready;
  runs.cancel([started.id], "requested");

  const result = await started.settled;

  assert.equal(result.lifecycle.phase, "cancelled");
  assert.ok(aborts >= 1);
  assert.doesNotMatch(result.errorMessage ?? "", /native abort rejected/);
});

test("Pi ignores retry checkpoints and settles from the later terminal snapshot", async () => {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const retryAnswer = {
    role: "assistant",
    content: [{ type: "text", text: "retryable answer" }],
    provider: "fixture",
    model: "fixture",
    stopReason: "error",
  };
  const finalAnswer = {
    role: "assistant",
    content: [{ type: "text", text: "answer after retry" }],
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
  };
  const messages: unknown[] = [];
  const session: PiSession = {
    get messages() {
      return messages as PiSession["messages"];
    },
    isIdle: true,
    async prompt() {
      messages.push(retryAnswer);
      for (const listener of listeners) {
        listener({
          type: "agent_end",
          messages: [retryAnswer],
          willRetry: true,
        } as AgentSessionEvent);
        messages.push(finalAnswer);
        listener({
          type: "message_end",
          message: finalAnswer,
        } as AgentSessionEvent);
        listener({
          type: "agent_end",
          messages,
          willRetry: false,
        } as AgentSessionEvent);
      }
    },
    async steer() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async bindExtensions() {},
    async abort() {},
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {},
    extensionRunner: { async emit() {} },
  };

  const result = await startSubagent({
    config: agent({ harness: "pi" }),
    description: "retry",
    prompt: "work",
    harnesses: createHarnessRegistry([
      createPiHarness({
        sessionFactory: async () => ({ session }),
        sessionOptionsFactory: async () => ({}),
      }),
    ]),
    runs: createSubagentRuns(),
  }).settled;

  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(getFinalOutput(result.messages), "answer after retry");
});

test("Pi adapter close aborts and waits for active work before disposal", async () => {
  let openReady = () => {};
  const ready = new Promise<void>((resolve) => {
    openReady = resolve;
  });
  let finishPrompt = () => {};
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  let disposed = false;
  const session: PiSession = {
    messages: [],
    isIdle: false,
    async prompt() {
      openReady();
      await promptFinished;
    },
    async steer() {},
    subscribe: () => () => {},
    async bindExtensions() {},
    async abort() {
      finishPrompt();
    },
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {
      disposed = true;
    },
    extensionRunner: { async emit() {} },
  };
  const adapter = createPiHarness({
    sessionFactory: async () => ({ session }),
    sessionOptionsFactory: async () => ({}),
  }).prepare({
    config: agent({ harness: "pi" }),
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
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

  assert.deepEqual(await execution, { ending: "cancelled" });
  assert.equal(disposed, true);
});

test("Pi adapter bounds extension shutdown before disposal", {
  timeout: 2_000,
}, async () => {
  let disposed = false;
  const session: PiSession = {
    messages: [],
    isIdle: true,
    async prompt() {},
    async steer() {},
    subscribe: () => () => {},
    async bindExtensions() {},
    async abort() {},
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {
      disposed = true;
    },
    extensionRunner: { emit: () => new Promise(() => {}) },
  };
  const adapter = createPiHarness({
    sessionFactory: async () => ({ session }),
    sessionOptionsFactory: async () => ({}),
  }).prepare({
    config: agent({ harness: "pi" }),
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  const result = createEmptyResult("worker", "initialize", 0);
  await adapter
    .prepareRun({ description: "initialize", prompt: "work" })
    .execute({
      report: createRunReporter(result, () => {}),
      signal: new AbortController().signal,
      controls: createControlGate(["steer"]).controls,
    });

  await adapter.close();

  assert.equal(disposed, true);
});

test("Pi steering rejection is diagnostic-only and creates no user Fact", async () => {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let finishPrompt = () => {};
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  let openReady = () => {};
  const ready = new Promise<void>((resolve) => {
    openReady = resolve;
  });
  let observeSteer = () => {};
  const steerObserved = new Promise<void>((resolve) => {
    observeSteer = resolve;
  });
  const terminal = {
    role: "assistant",
    content: [{ type: "text", text: "original answer" }],
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
  };
  const session: PiSession = {
    messages: [],
    isIdle: true,
    async prompt() {
      openReady();
      await promptFinished;
    },
    async steer() {
      observeSteer();
      throw new Error(`native rejection ${"x".repeat(4_096)}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async bindExtensions() {},
    async abort() {
      finishPrompt();
    },
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {},
    extensionRunner: { async emit() {} },
  };
  const runs = createSubagentRuns();
  const started = startSubagent({
    config: agent({ harness: "pi" }),
    description: "rejected steering",
    prompt: "do it",
    harnesses: createHarnessRegistry([
      createPiHarness({
        sessionFactory: async () => ({ session }),
        sessionOptionsFactory: async () => ({}),
      }),
    ]),
    runs,
  });
  await ready;
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "rejected guidance" }),
    "accepted",
  );
  await steerObserved;
  for (const listener of listeners) {
    listener({ type: "message_end", message: terminal } as AgentSessionEvent);
    listener({
      type: "agent_end",
      messages: [terminal],
      willRetry: false,
    } as AgentSessionEvent);
  }
  finishPrompt();

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(getFinalOutput(result.messages), "original answer");
  assert.equal(
    result.messages.some((fact) => fact.role === "user"),
    false,
  );
  assert.match(
    result.stderr,
    /Pi steering was not delivered: native rejection/,
  );
  assert.ok(
    result.stderr.length <= 2_100,
    "steering diagnostic must be bounded",
  );
});

test("Pi preserves two separately consumed Controls with identical text", async () => {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: unknown[] = [];
  let openReady = () => {};
  const ready = new Promise<void>((resolve) => {
    openReady = resolve;
  });
  let finishPrompt = () => {};
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  let steeringCount = 0;
  const emit = (event: unknown): void => {
    for (const listener of listeners) listener(event as AgentSessionEvent);
  };
  const session: PiSession = {
    get messages() {
      return messages as PiSession["messages"];
    },
    isIdle: true,
    async prompt() {
      openReady();
      await promptFinished;
    },
    async steer(text) {
      steeringCount++;
      const user = { role: "user", content: [{ type: "text", text }] };
      messages.push(user);
      emit({ type: "message_end", message: user });
      if (steeringCount === 2) {
        const answer = {
          role: "assistant",
          content: [{ type: "text", text: "used both Controls" }],
          provider: "fixture",
          model: "fixture",
          stopReason: "stop",
        };
        messages.push(answer);
        emit({ type: "message_end", message: answer });
        emit({
          type: "agent_end",
          messages: [...messages],
          willRetry: false,
        });
        finishPrompt();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async bindExtensions() {},
    async abort() {
      finishPrompt();
    },
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {},
    extensionRunner: { async emit() {} },
  };
  const runs = createSubagentRuns();
  const started = startSubagent({
    config: agent({ harness: "pi" }),
    description: "identical Controls",
    prompt: "start",
    harnesses: createHarnessRegistry([
      createPiHarness({
        sessionFactory: async () => ({ session }),
        sessionOptionsFactory: async () => ({}),
      }),
    ]),
    runs,
  });
  await ready;
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "same" }),
    "accepted",
  );
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "same" }),
    "accepted",
  );

  const result = await started.settled;

  assert.deepEqual(
    result.messages
      .filter((fact) => fact.role === "user")
      .flatMap((fact) =>
        fact.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ),
    ["same", "same"],
  );
});

test("Pi cancellation without agent_end preserves identical consumed Controls as distinct Facts", async () => {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let openReady = () => {};
  const ready = new Promise<void>((resolve) => {
    openReady = resolve;
  });
  let finishPrompt = () => {};
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  let openControlsConsumed = () => {};
  const controlsConsumed = new Promise<void>((resolve) => {
    openControlsConsumed = resolve;
  });
  let steeringCount = 0;
  const session: PiSession = {
    messages: [],
    isIdle: true,
    async prompt() {
      openReady();
      await promptFinished;
    },
    async steer(text) {
      steeringCount++;
      const user = { role: "user", content: [{ type: "text", text }] };
      for (const listener of listeners) {
        listener({ type: "message_end", message: user } as AgentSessionEvent);
        // Re-emitting the same provider object is a duplicate representation,
        // unlike the next Control's separately created equal-content message.
        listener({ type: "message_end", message: user } as AgentSessionEvent);
      }
      if (steeringCount === 2) openControlsConsumed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async bindExtensions() {},
    async abort() {
      finishPrompt();
    },
    async waitForIdle() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() {},
    extensionRunner: { async emit() {} },
  };
  const runs = createSubagentRuns();
  const started = startSubagent({
    config: agent({ harness: "pi" }),
    description: "identical Controls before cancellation",
    prompt: "start",
    harnesses: createHarnessRegistry([
      createPiHarness({
        sessionFactory: async () => ({ session }),
        sessionOptionsFactory: async () => ({}),
      }),
    ]),
    runs,
  });
  await ready;
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "same" }),
    "accepted",
  );
  assert.equal(
    runs.offer(started.id, { type: "steer", text: "same" }),
    "accepted",
  );
  await controlsConsumed;
  assert.deepEqual(runs.cancel([started.id], "requested"), [started.id]);

  const result = await started.settled;

  assert.equal(result.lifecycle.phase, "cancelled");
  assert.deepEqual(
    result.messages
      .filter((fact) => fact.role === "user")
      .flatMap((fact) =>
        fact.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ),
    ["same", "same"],
  );
});

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
