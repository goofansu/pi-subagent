import {
  type ChildProcess,
  spawn as defaultSpawn,
  type SpawnOptions,
} from "node:child_process";
import { DEPTH_ENV_KEY } from "./run.ts";

/** The process creation seam shared by one-shot harness adapters. */
export type ChildProcessSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const RAW_STDOUT_TAIL_LIMIT = 2000;

/** Cap on a single un-terminated stdout line, in characters. */
export const STDOUT_LINE_LIMIT = 32 * 1024 * 1024;

const OVERSIZED_STDOUT_LINE_MESSAGE =
  "[... oversized stdout line dropped; resyncing at the next newline ...]\n";

/**
 * Splits a byte stream into newline-delimited lines, dropping any single line
 * that grows past `limit` and resuming cleanly at the next newline.
 */
export interface NdjsonBuffer {
  push(chunk: string): string[];
  flush(): string[];
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
      if (skipNextLine) {
        skipNextLine = false;
        continue;
      }
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

export interface ChildProcessResult {
  /** Absent when the child exited because of a signal or could not start. */
  readonly exitCode?: number;
  /** True only when this driver's abort handler killed the child. */
  readonly aborted: boolean;
  /** True when the translator reported a terminal answer before abort. */
  readonly terminalBeforeAbort: boolean;
  /** The bounded raw stdout tail, useful for adapter diagnostics. */
  readonly stdoutTail: string;
  /** Process creation/runtime error emitted before a normal close. */
  readonly processError?: string;
}

export interface RunChildProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  childDepth: number;
  prompt: string;
  signal?: AbortSignal;
  /** Return true when a complete line contains the adapter's terminal answer. */
  onLine: (line: string) => boolean | undefined;
  onStderr?: (chunk: string) => void;
  spawn?: ChildProcessSpawn;
  killEscalationMs?: number;
}

/** How long an aborted child gets to obey SIGTERM before SIGKILL. */
const DEFAULT_KILL_ESCALATION_MS = 5_000;

/**
 * Run one prompt-bearing child without knowing its wire format.
 *
 * The adapter owns parsing and translation. This module owns only process
 * lifetime, line framing, inherited depth, stdin safety, and diagnostics.
 */
export async function runChildProcess({
  command,
  args,
  cwd,
  childDepth,
  prompt,
  signal,
  onLine,
  onStderr = () => {},
  spawn = defaultSpawn,
  killEscalationMs = DEFAULT_KILL_ESCALATION_MS,
}: RunChildProcessOptions): Promise<ChildProcessResult> {
  let aborted = false;
  let terminalBeforeAbort = false;
  let rawStdoutTail = "";

  const result = await new Promise<ChildProcessResult>((resolve) => {
    const proc = spawn(command, args, getSpawnOptions(cwd, childDepth));
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      onStderr("Failed to open child stdio pipes\n");
      resolve({
        exitCode: 1,
        aborted: false,
        terminalBeforeAbort: false,
        stdoutTail: "",
      });
      return;
    }

    proc.stdin.on("error", (error: Error) => {
      onStderr(`stdin: ${error.message}\n`);
    });
    proc.stdin.write(prompt, "utf-8");
    proc.stdin.end();

    const stdout = createNdjsonBuffer();
    const processLine = (line: string): void => {
      if (!line.trim()) return;
      if (onLine(line) === true && !aborted) {
        // Once witnessed, a terminal answer remains authoritative. A later
        // terminal-shaped line after cancellation cannot erase its ordering.
        terminalBeforeAbort = true;
      }
    };

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      rawStdoutTail = (rawStdoutTail + chunk).slice(-RAW_STDOUT_TAIL_LIMIT);
      for (const line of stdout.push(chunk)) processLine(line);
    });
    proc.stderr.on("data", (data) => onStderr(data.toString()));

    let procClosed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cleanupAbort = (): void => {
      if (signal) signal.removeEventListener("abort", killProc);
      if (escalation !== undefined) clearTimeout(escalation);
    };
    const killProc = (): void => {
      if (procClosed) return;
      aborted = true;
      proc.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (!procClosed) proc.kill("SIGKILL");
      }, killEscalationMs);
      escalation.unref?.();
    };

    proc.on("close", (code) => {
      procClosed = true;
      cleanupAbort();
      for (const line of stdout.flush()) processLine(line);
      if (stdout.overflowed()) onStderr(OVERSIZED_STDOUT_LINE_MESSAGE);
      resolve({
        exitCode: code ?? undefined,
        aborted,
        terminalBeforeAbort,
        stdoutTail: rawStdoutTail,
      });
    });
    proc.on("error", (error) => {
      procClosed = true;
      cleanupAbort();
      onStderr(`${error.message}\n`);
      resolve({
        exitCode: 1,
        aborted,
        terminalBeforeAbort,
        stdoutTail: rawStdoutTail,
        processError: error.message,
      });
    });

    if (signal?.aborted) killProc();
    else signal?.addEventListener("abort", killProc, { once: true });
  });

  return result;
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
