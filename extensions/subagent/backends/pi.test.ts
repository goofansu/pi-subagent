/**
 * Pi-backend tests for the pieces added by the multi-backend work. The original
 * argument-building and event-folding coverage lives in ../runner.test.ts, which
 * exercises the same functions through the re-exports.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createEmptyResult } from "../backend.ts";
import type { AgentConfig, SingleResult } from "../types.ts";
import {
  buildPiArgs,
  getPiInvocation,
  type PiInvocationRuntime,
  piBackend,
  resolveSubagentModel,
  resolveSubagentThinking,
} from "./pi.ts";

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
  } = {},
): Promise<SingleResult> {
  const shadow = shadowPiBinary(script);
  const result = createEmptyResult("worker", "Work", "pi");

  try {
    return await piBackend.run({
      task: {
        config: agent({ systemPrompt: "" }),
        description: "Work",
        prompt: "do it",
        cwd: os.tmpdir(),
        agentDir: os.tmpdir(),
        depth: 0,
      },
      result,
      emit: () => options.onEmit?.(result),
      signal: options.signal,
    });
  } finally {
    shadow.restore();
  }
}

test("pi backend accepts exit 0 after a valid agent_end event", async () => {
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

test("pi backend fails exit 0 without an agent_end event", async () => {
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

test("pi backend rejects a structurally invalid agent_end event", async () => {
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

test("pi backend retains a bounded malformed stdout tail", async () => {
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

test("pi backend preserves a nonzero child exit", async () => {
  const settled = await runPiFixture(
    "#!/bin/sh\nprintf '%s\\n' '{not-json}'\nprintf '%s\\n' 'fixture failure' >&2\nexit 7\n",
  );

  assert.equal(settled.exitCode, 7);
  assert.equal(settled.stopReason, undefined);
  assert.equal(settled.errorMessage, undefined);
  assert.match(settled.stderr, /fixture failure/);
});

test("pi backend keeps cancellation authoritative over a missing agent_end", async () => {
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
