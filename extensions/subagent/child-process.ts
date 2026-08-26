import {
  type ChildProcess,
  spawn as defaultSpawn,
  type SpawnOptions,
} from "node:child_process";
import type { OneShotSource } from "./one-shot.ts";
import { DEPTH_ENV_KEY } from "./run.ts";

const RAW_STDOUT_TAIL_LIMIT = 2000;
const STDOUT_LINE_LIMIT = 32 * 1024 * 1024;
const OVERSIZED_STDOUT_LINE_MESSAGE =
  "[... oversized stdout line dropped; resyncing at the next newline ...]\n";
const DEFAULT_KILL_ESCALATION_MS = 5_000;

export type ChildProcessSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface NdjsonBuffer {
  push(chunk: string): string[];
  flush(): string[];
  overflowed(): boolean;
}

function createNdjsonBuffer(limit = STDOUT_LINE_LIMIT): NdjsonBuffer {
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
    push(chunk) {
      buffer += chunk;
      const lines = takeLines();
      if (buffer.length > limit) {
        if (!skipNextLine) sawOverflow = true;
        buffer = "";
        skipNextLine = true;
      }
      return lines;
    },
    flush() {
      const trailing = buffer;
      buffer = "";
      if (skipNextLine || !trailing.trim()) return [];
      return [trailing];
    },
    overflowed: () => sawOverflow,
  };
}

function spawnOptions(cwd: string, childDepth: number): SpawnOptions {
  return {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, [DEPTH_ENV_KEY]: String(childDepth) },
  };
}

/**
 * Build the process-backed one-shot source. Process details, framing, and
 * diagnostics stop here; adapters receive parsed JSON records only.
 */
export function processJsonSource(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  childDepth: number;
  prompt: string;
  childName: string;
  spawn?: ChildProcessSpawn;
  killEscalationMs?: number;
}): OneShotSource<Record<string, unknown>> {
  const {
    command,
    args,
    cwd,
    childDepth,
    prompt,
    childName,
    spawn = defaultSpawn,
    killEscalationMs = DEFAULT_KILL_ESCALATION_MS,
  } = options;

  return async (sink, signal) => {
    if (signal.aborted) return { status: "clean" };
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(command, args, spawnOptions(cwd, childDepth));
      } catch (error) {
        reject(error);
        return;
      }
      if (!proc.stdin || !proc.stdout || !proc.stderr) {
        sink.stderr("Failed to open child stdio pipes\n");
        resolve({ status: "failed" });
        return;
      }

      const stdout = createNdjsonBuffer();
      let rawStdoutTail = "";
      let sawEvent = false;
      let sawStderr = false;
      let processError = false;
      let closed = false;
      let aborted = signal.aborted;
      let escalation: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        signal.removeEventListener("abort", abort);
        if (escalation !== undefined) clearTimeout(escalation);
      };
      const finish = (
        conclusion:
          | { status: "clean" }
          | { status: "failed"; errorMessage?: string },
      ): void => {
        if (closed) return;
        closed = true;
        cleanup();
        resolve(conclusion);
      };
      const processLine = (line: string): void => {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return;
        sawEvent = true;
        sink.event(parsed as Record<string, unknown>);
      };
      const close = (code: number | null): void => {
        if (closed) return;
        for (const line of stdout.flush()) processLine(line);
        if (stdout.overflowed()) {
          sawStderr = true;
          sink.stderr(OVERSIZED_STDOUT_LINE_MESSAGE);
        }
        if (processError) {
          finish({ status: "failed" });
          return;
        }
        if (code === 0) {
          if (!aborted && !sawStderr && !sawEvent) {
            sink.stderr(
              rawStdoutTail.trim()
                ? `Last stdout:\n${rawStdoutTail.trim()}`
                : "No stdout was captured.",
            );
          }
          finish({ status: "clean" });
          return;
        }
        // A raw stdout tail is useful only for a silent, actually failing
        // child. Parsed output and stderr are already better diagnostics.
        if (!aborted && !sawStderr && !sawEvent && rawStdoutTail.trim()) {
          sink.stderr(`Last stdout:\n${rawStdoutTail.trim()}`);
        }
        finish({
          status: "failed",
          errorMessage: `Child ${childName} exited with code ${code ?? "unknown"}`,
        });
      };
      const abort = (): void => {
        if (closed) return;
        aborted = true;
        proc.kill("SIGTERM");
        escalation = setTimeout(() => {
          if (!closed) proc.kill("SIGKILL");
        }, killEscalationMs);
        escalation.unref?.();
      };

      proc.stdin.on("error", (error: Error) => {
        sawStderr = true;
        sink.stderr(`stdin: ${error.message}\n`);
      });
      if (!signal.aborted) {
        proc.stdin.write(prompt, "utf-8");
        proc.stdin.end();
      }
      proc.stdout.on("data", (data) => {
        const chunk = data.toString();
        rawStdoutTail = (rawStdoutTail + chunk).slice(-RAW_STDOUT_TAIL_LIMIT);
        try {
          for (const line of stdout.push(chunk)) processLine(line);
        } catch (error) {
          reject(error);
        }
      });
      proc.stderr.on("data", (data) => {
        sawStderr = true;
        sink.stderr(data.toString());
      });
      proc.on("error", (error) => {
        if (closed) return;
        processError = true;
        sawStderr = true;
        sink.stderr(`${error.message}\n`);
        // An error is terminal even on child implementations that do not emit
        // the usual follow-up close event.
        finish({ status: "failed" });
      });
      proc.on("close", close);
      if (aborted || signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
}
