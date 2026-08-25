/**
 * The child pi driver — spawns pi in headless JSON mode and translates its
 * NDJSON event stream into the facts the run contract defines. It witnesses
 * what the child did; it never writes the run record. Wire-format knowledge
 * stops at this file.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getPackageDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type { RunReporter, SubagentOutcome, SubagentRun } from "./run.ts";
import { DEPTH_ENV_KEY } from "./run.ts";
import type { AgentConfig } from "./types.ts";

export interface PiInvocationRuntime {
  execPath: string;
  argv: readonly string[];
  packageDir: string;
  isPiCli: boolean;
}

const PI_CLI_SCRIPT_PATHS = [
  ["dist", "cli.js"],
  ["dist", "bun", "cli.js"],
  ["src", "cli.ts"],
  ["src", "bun", "cli.ts"],
] as const;

const RAW_STDOUT_TAIL_LIMIT = 2000;

/**
 * Cap on a single un-terminated stdout line, in characters.
 *
 * Unlike stderr, stdout carries structured events whose size is legitimately
 * large: an `agent_end` event holds the child's entire transcript, so a tight
 * cap would reject real traffic. This is a backstop against a child that emits
 * without ever writing a newline, not a budget — anything under it is normal.
 */
export const STDOUT_LINE_LIMIT = 32 * 1024 * 1024;

const OVERSIZED_STDOUT_LINE_MESSAGE =
  "[... oversized stdout line dropped; resyncing at the next newline ...]\n";

/**
 * Splits a byte stream into newline-delimited lines, dropping any single line
 * that grows past `limit` and resuming cleanly at the next newline.
 *
 * The guarantee is unconditional: no returned line exceeds the limit, however
 * the stream was chunked. Pipe reads are in practice far smaller than the
 * limit, so an oversized line is normally caught while it accumulates
 * un-terminated — but the cap must not *depend* on chunk size, so a line that
 * arrives already terminated inside one chunk is dropped just the same.
 *
 * The resync is the part worth having in one place: after a line is dropped,
 * the remainder of it still arrives, and the newline that ends it would
 * otherwise look like the end of a complete, parseable line.
 */
export interface NdjsonBuffer {
  /** Feed a chunk; returns the complete lines it finished. */
  push(chunk: string): string[];
  /** Take the trailing partial line, if it is one worth reading. */
  flush(): string[];
  /** Whether any line was dropped for exceeding the limit. */
  overflowed(): boolean;
}

export function createNdjsonBuffer(
  limit: number = STDOUT_LINE_LIMIT,
): NdjsonBuffer {
  let buffer = "";
  let skipNextLine = false;
  let sawOverflow = false;

  const takeLines = (): string[] => {
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    const lines: string[] = [];
    for (const part of parts) {
      // The tail of a dropped line ends with a newline like any other; it is
      // not a line, so it is discarded rather than parsed.
      if (skipNextLine) {
        skipNextLine = false;
        continue;
      }
      // A line over the limit is dropped whether or not it managed to end
      // itself; see the interface doc for why completed lines are checked.
      if (part.length > limit) {
        sawOverflow = true;
        continue;
      }
      lines.push(part);
    }
    return lines;
  };

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = takeLines();
      if (buffer.length > limit) {
        if (!skipNextLine) sawOverflow = true;
        buffer = "";
        skipNextLine = true;
      }
      return lines;
    },
    flush(): string[] {
      const trailing = buffer;
      buffer = "";
      if (skipNextLine || !trailing.trim()) return [];
      return [trailing];
    },
    overflowed: () => sawOverflow,
  };
}
const MISSING_AGENT_END_ERROR =
  "Child pi exited with code 0 without a valid terminal agent_end event (with a messages array).";

function executableName(executablePath: string): string {
  // Splitting both separators also keeps the resolver testable across platforms.
  return executablePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function isGenericScriptRuntime(executablePath: string): boolean {
  return /^(?:node|nodejs|bun)(?:\.exe)?$/.test(executableName(executablePath));
}

function isNativePiRuntime(executablePath: string): boolean {
  return /^pi(?:\.exe)?$/.test(executableName(executablePath));
}

function resolveExistingPath(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return fs.realpathSync(filePath);
  } catch {
    // A path can disappear or become inaccessible between exists and realpath.
    return undefined;
  }
}

function isPiCliScript(scriptPath: string, packageDir: string): boolean {
  const resolvedScript = resolveExistingPath(scriptPath);
  if (!resolvedScript) return false;

  // The CLI entrypoint must belong to the same Pi package that loaded this
  // extension. This prevents SDK embedding hosts from being mistaken for Pi.
  return PI_CLI_SCRIPT_PATHS.some((segments) => {
    const candidate = resolveExistingPath(path.join(packageDir, ...segments));
    return candidate === resolvedScript;
  });
}

/**
 * Resolve the active Pi installation without constructing a shell command.
 *
 * The CLI's process marker distinguishes it from SDK hosts. Node/Bun script
 * launches are then reused only when argv[1] resolves to a known CLI entrypoint
 * in the Pi package that loaded the extension. Standalone releases are reused
 * only when the active executable is named `pi`; all ambiguous SDK embedding
 * hosts fall back to normal PATH resolution.
 */
export function getPiInvocation(
  args: string[],
  runtime: PiInvocationRuntime = {
    execPath: process.execPath,
    argv: process.argv,
    packageDir: getPackageDir(),
    isPiCli: process.env.PI_CODING_AGENT === "true",
  },
): { command: string; args: string[] } {
  if (!runtime.isPiCli) return { command: "pi", args };

  if (isNativePiRuntime(runtime.execPath)) {
    return { command: runtime.execPath, args };
  }

  const scriptPath = runtime.argv[1];
  if (
    scriptPath &&
    isGenericScriptRuntime(runtime.execPath) &&
    isPiCliScript(scriptPath, runtime.packageDir)
  ) {
    return { command: runtime.execPath, args: [scriptPath, ...args] };
  }

  return { command: "pi", args };
}

function stringField(config: AgentConfig, name: string): string | undefined {
  const value = config.fields?.[name] ?? config[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(config: AgentConfig, name: string): boolean {
  return (config.fields?.[name] ?? config[name]) !== false;
}

export function buildPiArgs(
  config: AgentConfig,
  resolvedModel: string | undefined,
  systemPromptPath: string | undefined,
  thinkingLevel?: string,
  projectTrusted = false,
): string[] {
  // The child runs non-interactively, so it cannot inherit a session-only
  // decision by prompting. Forward the parent's resolved trust explicitly;
  // otherwise saved or default trust could disagree with the parent session,
  // in either direction.
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    projectTrusted ? "--approve" : "--no-approve",
  ];
  if (resolvedModel) args.push("--model", resolvedModel);
  // pi takes the thinking level as its own flag, so nothing has to be spliced
  // into the model string — which is what made a colon ambiguous before.
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  const tools = stringField(config, "tools");
  if (tools) args.push("--tools", tools);
  if (systemPromptPath) {
    args.push(
      booleanField(config, "appendSystemPrompt")
        ? "--append-system-prompt"
        : "--system-prompt",
      systemPromptPath,
    );
  }
  // Prompt is passed via stdin, not as a CLI arg, to avoid process-listing
  // exposure of sensitive content and OS argument-length limits (E2BIG).
  return args;
}

export function getSpawnOptions(cwd: string, childDepth: number): SpawnOptions {
  return {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      [DEPTH_ENV_KEY]: String(childDepth),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function factPart(value: unknown): import("./run.ts").FactPart | undefined {
  if (typeof value === "string") return { type: "text", text: value };
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "toolCall" && typeof value.name === "string") {
    return {
      type: "tool_call",
      name: value.name,
      ...(isRecord(value.arguments) ? { arguments: value.arguments } : {}),
    };
  }
  return undefined;
}

function piFact(value: unknown): import("./run.ts").Fact | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role;
  if (role !== "user" && role !== "assistant" && role !== "tool")
    return undefined;
  if (typeof value.content !== "string" && !Array.isArray(value.content)) {
    return undefined;
  }
  const rawParts = Array.isArray(value.content)
    ? value.content
    : [value.content];
  const parts = rawParts
    .map(factPart)
    .filter((part): part is import("./run.ts").FactPart => part !== undefined);
  if (parts.length === 0) return undefined;
  const rawUsage = isRecord(value.usage) ? value.usage : undefined;
  const rawCost =
    rawUsage && isRecord(rawUsage.cost) ? rawUsage.cost : undefined;
  const usage = rawUsage
    ? {
        input: typeof rawUsage.input === "number" ? rawUsage.input : undefined,
        output:
          typeof rawUsage.output === "number" ? rawUsage.output : undefined,
        cacheRead:
          typeof rawUsage.cacheRead === "number"
            ? rawUsage.cacheRead
            : undefined,
        cacheWrite:
          typeof rawUsage.cacheWrite === "number"
            ? rawUsage.cacheWrite
            : undefined,
        contextTokens:
          typeof rawUsage.totalTokens === "number"
            ? rawUsage.totalTokens
            : undefined,
        cost:
          rawCost && typeof rawCost.total === "number"
            ? rawCost.total
            : undefined,
      }
    : undefined;
  return {
    role,
    parts,
    ...(usage ? { usage } : {}),
    ...(typeof value.provider === "string" && typeof value.model === "string"
      ? { model: `${value.provider}/${value.model}` }
      : {}),
    ...(typeof value.stopReason === "string"
      ? { stopReason: value.stopReason }
      : {}),
    ...(typeof value.errorMessage === "string"
      ? { errorMessage: value.errorMessage }
      : {}),
  };
}

function isValidAgentEndEvent(
  event: Record<string, unknown>,
): event is Record<string, unknown> & { messages: unknown[] } {
  return event.type === "agent_end" && Array.isArray(event.messages);
}

/** Translate parsed pi wire events into domain facts at the adapter edge. */
export function translatePiJsonEvent(
  event: Record<string, unknown>,
  report: RunReporter,
): boolean {
  if (
    (event.type === "message_end" || event.type === "tool_result_end") &&
    event.message
  ) {
    const fact = piFact(event.message);
    if (fact) report.message(fact);
    return true;
  }
  if (isValidAgentEndEvent(event)) {
    report.transcript(
      event.messages
        .map(piFact)
        .filter((fact): fact is import("./run.ts").Fact => fact !== undefined),
    );
    return true;
  }
  return false;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

/** How long an aborted child gets to obey SIGTERM before SIGKILL. */
const KILL_ESCALATION_MS = 5_000;

/**
 * Run one agent in a child pi process. This is the dispatcher's default
 * executor; see `SubagentExecutor` in `run.ts` for the contract it satisfies,
 * cancellation included.
 *
 * `killEscalationMs` is injected for tests: the SIGTERM→SIGKILL path cannot
 * be exercised at all against a five-second wall-clock wait.
 */
export async function runPiAgent(
  run: SubagentRun,
  {
    killEscalationMs = KILL_ESCALATION_MS,
    resolvedModel,
    resolvedThinking,
  }: {
    killEscalationMs?: number;
    resolvedModel?: string;
    resolvedThinking?: string;
  } = {},
): Promise<SubagentOutcome> {
  const { task, signal } = run;
  const { config } = task;

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let wasAborted = false;
  let sawValidAgentEnd = false;
  let rawStdoutTail = "";

  // The ending sometimes needs to know whether a diagnosis was already
  // reported, and the executor no longer holds the record to look at — so it
  // tracks what it witnessed itself, on the way past.
  let reportedStderr = false;
  let reportedErrorMessage = false;
  const carriesErrorMessage = (fact: import("./run.ts").Fact): boolean =>
    fact.role === "assistant" && Boolean(fact.errorMessage);
  const report: RunReporter = {
    message(fact) {
      if (carriesErrorMessage(fact)) reportedErrorMessage = true;
      run.report.message(fact);
    },
    transcript(facts) {
      reportedErrorMessage = facts.some(carriesErrorMessage);
      run.report.transcript(facts);
    },
    stderr(chunk) {
      reportedStderr = true;
      run.report.stderr(chunk);
    },
  };

  try {
    if (config.systemPrompt) {
      const tmp = await writePromptToTempFile(config.name, config.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildPiArgs(
      config,
      resolvedModel,
      tmpPromptPath ?? undefined,
      resolvedThinking,
      task.projectTrusted,
    );

    let closeErrorMessage: string | undefined;
    const exitCode = await new Promise<number | undefined>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(
        invocation.command,
        invocation.args,
        getSpawnOptions(task.cwd, task.childDepth),
      );
      if (!proc.stdin || !proc.stdout || !proc.stderr) {
        report.stderr("Failed to open child pi stdio pipes");
        resolve(1);
        return;
      }

      // A child that dies during startup — a rejected model, an unknown tool
      // name, a refused directory — closes this pipe while the prompt is still
      // being written. Without a listener that EPIPE is an unhandled stream
      // error, which takes down the parent pi, not the child.
      proc.stdin.on("error", (err: Error) => {
        report.stderr(`stdin: ${err.message}\n`);
      });
      // Write the prompt to stdin and close it so pi reads it cleanly.
      proc.stdin.write(task.prompt, "utf-8");
      proc.stdin.end();
      const stdout = createNdjsonBuffer();

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return;
        }

        const event = parsed as Record<string, unknown>;
        if (isValidAgentEndEvent(event)) sawValidAgentEnd = true;
        translatePiJsonEvent(event, report);
      };

      proc.stdout.on("data", (data) => {
        const chunk = data.toString();
        rawStdoutTail = (rawStdoutTail + chunk).slice(-RAW_STDOUT_TAIL_LIMIT);
        for (const line of stdout.push(chunk)) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        report.stderr(data.toString());
      });

      let procClosed = false;
      proc.on("close", (code) => {
        procClosed = true;
        for (const line of stdout.flush()) processLine(line);
        if (stdout.overflowed()) {
          report.stderr(OVERSIZED_STDOUT_LINE_MESSAGE);
        }
        if (code !== 0 && !reportedErrorMessage) {
          closeErrorMessage = `Child pi exited with code ${code ?? "unknown"}`;
          const stdoutTail = rawStdoutTail.trim();
          if (!reportedStderr && stdoutTail) {
            report.stderr(`Last stdout:\n${stdoutTail}`);
          }
        }
        resolve(code ?? undefined);
      });

      proc.on("error", (err) => {
        report.stderr(err.message);
        resolve(1);
      });

      if (signal) {
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          escalation = setTimeout(() => {
            if (!procClosed) proc.kill("SIGKILL");
          }, killEscalationMs);
          // The escalation must never be the reason the parent stays up: if
          // pi is quitting, SIGTERM has been sent and that has to be enough.
          escalation.unref?.();
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
        proc.on("close", () => {
          // Remove the listener once the process has closed so a late abort
          // signal doesn't incorrectly mark a successfully completed run as
          // aborted, and drop the SIGKILL escalation the close made moot.
          signal.removeEventListener("abort", killProc);
          if (escalation !== undefined) clearTimeout(escalation);
        });
      }
    });

    // Cancellation is a resolved outcome, not a rejection — see the executor
    // contract in run.ts. Only this driver knows whether the abort actually
    // killed the child (the listener is removed once it closes), so the abort
    // marker travels in the outcome; the dispatcher normalizes the rest.
    if (wasAborted) {
      return { stopReason: "aborted" };
    }
    if (exitCode === 0 && !sawValidAgentEnd) {
      const stdoutTail = rawStdoutTail.trim();
      report.stderr(
        stdoutTail ? `Last stdout:\n${stdoutTail}` : "No stdout was captured.",
      );
      return {
        exitCode: 1,
        stopReason: "error",
        errorMessage: MISSING_AGENT_END_ERROR,
      };
    }
    return {
      exitCode,
      ...(closeErrorMessage ? { errorMessage: closeErrorMessage } : {}),
    };
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}
