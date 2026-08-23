/**
 * Child pi driver tests: how the CLI is located, what argv it is given, how its
 * NDJSON stream folds into a result, and how the process itself is settled.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getFinalOutput } from "./messages.ts";
import {
  applyPiJsonEvent,
  buildPiArgs,
  createNdjsonBuffer,
  getPiInvocation,
  getSpawnOptions,
  type PiInvocationRuntime,
  resolveSubagentModel,
  resolveSubagentThinking,
  runPiAgent,
} from "./pi-agent.ts";
import { createEmptyResult } from "./run.ts";
import type { AgentConfig, SingleResult } from "./types.ts";

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

test("resolveSubagentModel passes a variant-suffixed id through untouched", () => {
  assert.equal(
    resolveSubagentModel(
      agent({ model: "openrouter/google/gemma-4-31b-it:free" }),
      undefined,
    ),
    "openrouter/google/gemma-4-31b-it:free",
  );
});

/**
 * Put a stand-in `pi` on PATH so the backend's real spawn path runs without a
 * pi install. Returns a restore function.
 */
function shadowPiBinary(script: string): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bin-"));
  fs.writeFileSync(path.join(dir, "pi"), script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function runPiFixture(
  script: string,
  options: {
    signal?: AbortSignal;
    onEmit?: (result: SingleResult) => void;
    prompt?: string;
    killEscalationMs?: number;
  } = {},
): Promise<SingleResult> {
  const shadow = shadowPiBinary(script);
  const result = createEmptyResult("worker", "Work", 0);

  try {
    return await runPiAgent(
      {
        task: {
          config: agent({ systemPrompt: "" }),
          description: "Work",
          prompt: options.prompt ?? "do it",
          cwd: os.tmpdir(),
          depth: 0,
          projectTrusted: false,
        },
        result,
        emit: () => options.onEmit?.(result),
        signal: options.signal,
      },
      options.killEscalationMs === undefined
        ? {}
        : { killEscalationMs: options.killEscalationMs },
    );
  } finally {
    shadow.restore();
  }
}

test("the child pi driver accepts exit 0 after a valid agent_end event", async () => {
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

  const settled = await runPiFixture(
    `#!/bin/sh\nprintf '%s\\n' '${terminalEvent}'\n`,
  );

  assert.equal(settled.exitCode, 0);
  assert.equal(settled.stopReason, "stop");
  assert.equal(settled.errorMessage, undefined);
  assert.equal(settled.messages.length, 1);
});

test("the child pi driver fails exit 0 without an agent_end event", async () => {
  const nonterminalEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial output" }],
      stopReason: "stop",
    },
  });

  const settled = await runPiFixture(
    `#!/bin/sh\nprintf '%s\\n' '${nonterminalEvent}'\n`,
  );

  assert.equal(settled.exitCode, 1);
  assert.equal(settled.stopReason, "error");
  assert.equal(settled.messages.length, 1);
  assert.match(settled.errorMessage ?? "", /valid terminal agent_end event/);
  assert.match(settled.errorMessage ?? "", /"type":"message_end"/);
});

test("the child pi driver rejects a structurally invalid agent_end event", async () => {
  const fakeTerminalEvent = JSON.stringify({
    type: "agent_end",
    messages: { role: "assistant" },
  });

  const settled = await runPiFixture(
    `#!/bin/sh\nprintf '%s\\n' '${fakeTerminalEvent}'\n`,
  );

  assert.equal(settled.exitCode, 1);
  assert.equal(settled.stopReason, "error");
  assert.equal(settled.messages.length, 0);
  assert.match(settled.errorMessage ?? "", /valid terminal agent_end event/);
  assert.match(settled.errorMessage ?? "", /"messages":\{"role"/);
});

test("the child pi driver retains a bounded malformed stdout tail", async () => {
  const malformedOutput = `malformed-${"x".repeat(3000)}-diagnostic-tail`;

  const settled = await runPiFixture(
    `#!/bin/sh\nprintf '%s\\n' '${malformedOutput}'\n`,
  );

  assert.equal(settled.exitCode, 1);
  assert.equal(settled.stopReason, "error");
  assert.match(settled.errorMessage ?? "", /Last stdout:/);
  assert.match(settled.errorMessage ?? "", /diagnostic-tail/);
  assert.doesNotMatch(settled.errorMessage ?? "", /malformed-/);
  assert.ok((settled.errorMessage?.length ?? 0) < 2500);
});

test("the child pi driver preserves a nonzero child exit", async () => {
  const settled = await runPiFixture(
    "#!/bin/sh\nprintf '%s\\n' '{not-json}'\nprintf '%s\\n' 'fixture failure' >&2\nexit 7\n",
  );

  assert.equal(settled.exitCode, 7);
  assert.equal(settled.stopReason, undefined);
  assert.equal(settled.errorMessage, undefined);
  assert.match(settled.stderr, /fixture failure/);
});

test("the child pi driver keeps cancellation authoritative over a missing agent_end", async () => {
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
    `#!/bin/sh\nprintf '%s\\n' '${partialEvent}'\nexec sleep 30\n`,
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
  assert.equal(settled.exitCode, 1);
  assert.equal(settled.stopReason, "aborted");
  assert.match(settled.errorMessage ?? "", /Subagent was aborted/);
  assert.doesNotMatch(settled.errorMessage ?? "", /agent_end/);
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

  // `trap '' TERM` before the exec makes SIGTERM a no-op for the child (an
  // ignored signal survives exec), so only the SIGKILL escalation can end it.
  const settled = await runPiFixture(
    `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' '${partialEvent}'\nexec sleep 30\n`,
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

  assert.equal(settled.stopReason, "aborted");
  assert.match(settled.errorMessage ?? "", /Subagent was aborted/);
});

test("resolveSubagentModel hands pi the model exactly as written", () => {
  for (const model of [
    "openai-codex/gpt-5.5",
    "openrouter/google/gemma-4-31b-it:free",
    "sonnet",
  ]) {
    assert.equal(
      resolveSubagentModel(agent({ model }), undefined),
      model,
      model,
    );
  }
});

test("resolveSubagentModel uses the caller's model when the profile omits one", () => {
  // The level travels separately now, so nothing is spliced into the id.
  assert.equal(
    resolveSubagentModel(agent(), {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "low",
    }),
    "anthropic/claude-opus-4-5",
  );
});

test("resolveSubagentThinking prefers the profile's effort", () => {
  assert.equal(
    resolveSubagentThinking(agent({ model: "sonnet", effort: "high" }), {
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinkingLevel: "low",
    }),
    "high",
  );
});

test("resolveSubagentThinking uses the caller's level only when model is omitted", () => {
  const parent = {
    provider: "anthropic",
    id: "claude-opus-4-5",
    thinkingLevel: "low",
  };
  assert.equal(resolveSubagentThinking(agent(), parent), "low");
  // A pinned model with no effort means pi's default, not the caller's level.
  assert.equal(
    resolveSubagentThinking(agent({ model: "sonnet" }), parent),
    undefined,
  );
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

test("getSpawnOptions runs child pi in the configured project cwd", () => {
  const options = getSpawnOptions("/tmp/customer-project", 0);

  assert.equal(options.cwd, "/tmp/customer-project");
  assert.equal(options.env?.PI_SUBAGENT_DEPTH, "1");
});

test("applyPiJsonEvent collects final messages from agent_end events", () => {
  const current = createEmptyResult("general-purpose", "test", 0);

  assert.equal(
    applyPiJsonEvent(
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "final from agent_end" }],
            stopReason: "stop",
          },
        ],
      },
      current,
    ),
    true,
  );

  assert.equal(getFinalOutput(current.messages), "final from agent_end");
  assert.equal(current.stopReason, "stop");
  assert.equal(current.usage.turns, 1);
});

test("the child pi driver ignores an abort that arrives after a clean exit", async () => {
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

  const settled = await runPiFixture(
    `#!/bin/sh\nprintf '%s\\n' '${terminalEvent}'\n`,
    { signal: controller.signal },
  );
  // A late cancellation must not retroactively fail a run that already
  // completed, which is what an abort listener left attached would do.
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(settled.exitCode, 0);
  assert.equal(settled.stopReason, "stop");
  assert.equal(settled.errorMessage, undefined);
});

test("a child that exits before reading the prompt does not take the parent down", async () => {
  // Larger than a pipe buffer, so the write is still in flight when the child
  // goes away. Without a stdin error handler this surfaces as an unhandled
  // EPIPE in the parent process rather than a failed run.
  const oversizedPrompt = "x".repeat(1024 * 1024);
  const result = await runPiFixture("#!/bin/sh\nexit 3\n", {
    prompt: oversizedPrompt,
  });

  assert.equal(result.exitCode, 3);
  assert.ok(
    result.errorMessage || result.stderr,
    "the run should report why it failed",
  );
});

test("the stdout buffer splits lines across chunk boundaries", () => {
  const buffer = createNdjsonBuffer(1024);

  assert.deepEqual(buffer.push('{"a":1}\n{"b'), ['{"a":1}']);
  assert.deepEqual(buffer.push('":2}\n'), ['{"b":2}']);
  assert.deepEqual(buffer.flush(), []);
  assert.equal(buffer.overflowed(), false);
});

test("the stdout buffer keeps a trailing line that never got a newline", () => {
  const buffer = createNdjsonBuffer(1024);

  assert.deepEqual(buffer.push('{"a":1}'), []);
  assert.deepEqual(buffer.flush(), ['{"a":1}']);
});

test("the stdout buffer drops an oversized line and resyncs at the next newline", () => {
  const buffer = createNdjsonBuffer(16);

  assert.deepEqual(buffer.push("x".repeat(64)), []);
  assert.equal(buffer.overflowed(), true);
  // The rest of the dropped line arrives with the newline that ends it; that
  // tail is not a line, and the good line after it still parses.
  assert.deepEqual(buffer.push('more-of-it\n{"a":1}\n'), ['{"a":1}']);
});

test("the stdout buffer does not flush the tail of a dropped line", () => {
  const buffer = createNdjsonBuffer(16);

  buffer.push("x".repeat(64));
  assert.deepEqual(buffer.flush(), []);
});

test("an oversized line is dropped even when it arrives terminated in one chunk", () => {
  const buffer = createNdjsonBuffer(16);

  // The cap must not depend on chunk size: a line that never accumulates
  // un-terminated — it arrives whole, newline and all — is over the limit
  // just the same.
  assert.deepEqual(buffer.push(`${"x".repeat(64)}\n{"a":1}\n`), ['{"a":1}']);
  assert.equal(buffer.overflowed(), true);
});
