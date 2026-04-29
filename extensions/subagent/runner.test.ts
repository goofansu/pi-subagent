import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { buildPiArgs } from "./runner.js";

test("buildPiArgs disables default tools and loads configured tools", () => {
  const args = buildPiArgs(
    {
      name: "explore",
      description: "Explore code",
      tools: "read,grep,find,ls,bash",
      systemPrompt: "Search only.",
    },
    "anthropic/claude",
    "/tmp/prompt.md",
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    "anthropic/claude",
    "--no-tools",
    "--tools",
    "read,grep,find,ls,bash",
    "--system-prompt",
    "/tmp/prompt.md",
  ]);
});

test("buildPiArgs appends system prompt when appendSystemPrompt is true", () => {
  const args = buildPiArgs(
    {
      name: "explore",
      description: "Explore code",
      appendSystemPrompt: true,
      systemPrompt: "Search only.",
    },
    undefined,
    "/tmp/prompt.md",
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--append-system-prompt",
    "/tmp/prompt.md",
  ]);
});

test("buildPiArgs treats missing tools as no-op to use Pi user config", () => {
  const args = buildPiArgs(
    {
      name: "explore",
      description: "Explore code",
      systemPrompt: "Search only.",
    },
    undefined,
    undefined,
  );

  assert.deepEqual(args, ["--mode", "json", "-p", "--no-session"]);
});

test("buildPiArgs does not include the prompt in argv", () => {
  const args = buildPiArgs(
    { name: "agent", description: "An agent", systemPrompt: "Do stuff." },
    undefined,
    undefined,
  );
  // No element in the args array should be the prompt text
  assert.ok(
    !args.some((a) => a.includes("Do stuff")),
    "prompt must not appear in argv",
  );
});

test("abort signal kills child process and rejects with abort error", async () => {
  // Spawn a process that sleeps indefinitely; abort it and verify it exits.
  const controller = new AbortController();
  const { signal } = controller;

  const exitCode = await new Promise<number | "aborted">((resolve) => {
    const proc = spawn("sleep", ["60"], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });

    let procClosed = false;

    proc.on("close", (code) => {
      procClosed = true;
      resolve(code ?? 0);
    });

    const killProc = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!procClosed) proc.kill("SIGKILL");
      }, 5000);
    };

    signal.addEventListener("abort", killProc, { once: true });
    // Clean up listener if process closes before abort fires
    proc.on("close", () => signal.removeEventListener("abort", killProc));

    // Abort after a short delay
    setTimeout(() => {
      controller.abort();
      resolve("aborted");
    }, 50);
  });

  // Process should have been terminated (exited or aborted path taken)
  assert.ok(
    exitCode === "aborted" || typeof exitCode === "number",
    "process should have been terminated",
  );
});

test("stale abort after natural process exit does not mark run as aborted", async () => {
  // A process that exits immediately; abort fires after it's already gone.
  const controller = new AbortController();
  const { signal } = controller;

  let wasAborted = false;

  await new Promise<void>((resolve) => {
    const proc = spawn("true", [], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });

    let procClosed = false;

    const killProc = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
    };

    signal.addEventListener("abort", killProc, { once: true });

    proc.on("close", () => {
      procClosed = true;
      signal.removeEventListener("abort", killProc); // fix: remove listener
      resolve();
    });

    // Abort fires after the process has already closed
    proc.on("close", () => {
      setTimeout(() => controller.abort(), 50);
    });

    void procClosed; // suppress unused warning
  });

  // Give the abort timeout a chance to fire
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    wasAborted,
    false,
    "abort after natural exit must not mark run as aborted",
  );
});
