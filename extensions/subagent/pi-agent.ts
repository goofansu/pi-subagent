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
import type { Message } from "@earendil-works/pi-ai";
import {
  getPackageDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
  ParentModel,
  RunReporter,
  SubagentOutcome,
  SubagentRun,
} from "./run.ts";
import { DEPTH_ENV_KEY } from "./run.ts";
import type { AgentConfig } from "./types.ts";
import { resolveAppendSystemPrompt } from "./types.ts";

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

/**
 * The thinking level to pass, or `undefined` to leave pi's default alone.
 *
 * A profile's `effort` wins. Failing that, only an omitted model brings the
 * caller's level with it: a pinned model with no `effort` means "this model at
 * whatever pi would normally use", not "this model at the caller's level".
 */
export function resolveSubagentThinking(
  config: AgentConfig,
  parentModel: ParentModel | undefined,
): string | undefined {
  if (config.effort) return config.effort;
  if (config.model) return undefined;
  return parentModel?.thinkingLevel;
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
  if (config.tools) {
    args.push("--tools", config.tools);
  }
  if (systemPromptPath) {
    args.push(
      resolveAppendSystemPrompt(config)
        ? "--append-system-prompt"
        : "--system-prompt",
      systemPromptPath,
    );
  }
  // Prompt is passed via stdin, not as a CLI arg, to avoid process-listing
  // exposure of sensitive content and OS argument-length limits (E2BIG).
  return args;
}

/** Resolve the model id pi's `--model` expects, if any applies. */
export function resolveSubagentModel(
  config: AgentConfig,
  parentModel: ParentModel | undefined,
): string | undefined {
  // Verbatim. Whatever `pi --model` accepts is between the author and pi.
  if (config.model) return config.model;
  if (!parentModel) return undefined;
  return `${parentModel.provider}/${parentModel.id}`;
}

export function getSpawnOptions(
  cwd: string,
  currentDepth: number,
): SpawnOptions {
  return {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      [DEPTH_ENV_KEY]: String(currentDepth + 1),
    },
  };
}

function isValidAgentEndEvent(event: Record<string, unknown>): boolean {
  return event.type === "agent_end" && Array.isArray(event.messages);
}

/**
 * Translate one parsed pi event into a reported fact. This is the whole of
 * the wire-format knowledge: which event types matter, and which fact each
 * one is. What the facts do to the run record is the fold's business.
 */
export function translatePiJsonEvent(
  event: Record<string, unknown>,
  report: RunReporter,
): boolean {
  if (event.type === "message_end" && event.message) {
    report.message(event.message as Message);
    return true;
  }

  if (event.type === "tool_result_end" && event.message) {
    report.message(event.message as Message);
    return true;
  }

  if (isValidAgentEndEvent(event)) {
    report.transcript(event.messages as Message[]);
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
  { killEscalationMs = KILL_ESCALATION_MS }: { killEscalationMs?: number } = {},
): Promise<SubagentOutcome> {
  const { task, signal } = run;
  const { config } = task;

  const resolvedModel = resolveSubagentModel(config, task.parentModel);

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
  const carriesErrorMessage = (msg: Message): boolean =>
    msg.role === "assistant" &&
    Boolean((msg as { errorMessage?: string }).errorMessage);
  const report: RunReporter = {
    message(msg) {
      if (carriesErrorMessage(msg)) reportedErrorMessage = true;
      run.report.message(msg);
    },
    transcript(messages) {
      reportedErrorMessage = messages.some(carriesErrorMessage);
      run.report.transcript(messages);
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
      resolveSubagentThinking(config, task.parentModel),
      task.projectTrusted,
    );

    let closeErrorMessage: string | undefined;
    const exitCode = await new Promise<number | undefined>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(
        invocation.command,
        invocation.args,
        getSpawnOptions(task.cwd, task.depth),
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
        if (code !== 0 && !reportedStderr && !reportedErrorMessage) {
          closeErrorMessage =
            `Child pi exited with code ${code ?? "unknown"} without stderr` +
            (rawStdoutTail.trim()
              ? `. Last stdout: ${rawStdoutTail.trim()}`
              : ".");
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
      return {
        exitCode: 1,
        stopReason: "error",
        errorMessage: stdoutTail
          ? `${MISSING_AGENT_END_ERROR} Last stdout:\n${stdoutTail}`
          : `${MISSING_AGENT_END_ERROR} No stdout was captured.`,
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
