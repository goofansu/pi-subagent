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
        try {
          sink.stderr("Failed to open child stdio pipes\n");
          resolve({ status: "failed" });
        } catch (error) {
          reject(error);
        }
        return;
      }

      const stdout = createNdjsonBuffer();
      let rawStdoutTail = "";
      let sawTranslatedEvent = false;
      let sawTerminalTranslation = false;
      let sawStderr = false;
      let processError = false;
      let settled = false;
      let childClosed = false;
      let aborted = signal.aborted;
      let escalation: ReturnType<typeof setTimeout> | undefined;

      const cleanupAbort = (): void => {
        signal.removeEventListener("abort", abort);
        if (escalation !== undefined) clearTimeout(escalation);
      };
      const detachStreams = (): void => {
        proc.stdin?.removeListener("error", onStdinError);
        proc.stdout?.removeListener("data", onStdoutData);
        proc.stderr?.removeListener("data", onStderrData);
      };
      const detachProcess = (): void => {
        proc.removeListener("error", onProcessError);
        proc.removeListener("close", onClose);
      };
      const terminate = (): void => {
        if (childClosed) return;
        try {
          proc.kill("SIGTERM");
        } catch {
          // The process may have exited between the event and this cleanup.
        }
        if (escalation === undefined) {
          escalation = setTimeout(() => {
            if (!childClosed) {
              try {
                proc.kill("SIGKILL");
              } catch {
                // The process may have exited between the two signals.
              }
            }
          }, killEscalationMs);
          escalation.unref?.();
        }
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        detachStreams();
        if (childClosed) detachProcess();
        else {
          if (processError) detachProcess();
          terminate();
        }
        reject(error);
      };
      const finish = (
        conclusion:
          | { status: "clean" }
          | { status: "failed"; errorMessage?: string },
      ): void => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        detachStreams();
        if (childClosed) detachProcess();
        else if (processError) {
          // A process error normally has a follow-up close event, but the
          // source must also clean up children that emit only error.
          detachProcess();
          terminate();
        }
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
        const acknowledgement = sink.event(parsed as Record<string, unknown>);
        if (acknowledgement?.translated) sawTranslatedEvent = true;
        if (acknowledgement?.terminal) sawTerminalTranslation = true;
      };
      const abort = (): void => {
        if (settled) return;
        aborted = true;
        terminate();
      };
      function onStdinError(error: Error): void {
        sawStderr = true;
        try {
          sink.stderr(`stdin: ${error.message}\n`);
        } catch (sinkError) {
          fail(sinkError);
        }
      }
      function onStdoutData(data: Buffer | string): void {
        const chunk = data.toString();
        rawStdoutTail = (rawStdoutTail + chunk).slice(-RAW_STDOUT_TAIL_LIMIT);
        try {
          for (const line of stdout.push(chunk)) processLine(line);
        } catch (error) {
          fail(error);
        }
      }
      function onStderrData(data: Buffer | string): void {
        sawStderr = true;
        try {
          sink.stderr(data.toString());
        } catch (error) {
          fail(error);
        }
      }
      function onProcessError(error: Error): void {
        if (settled) return;
        processError = true;
        sawStderr = true;
        try {
          sink.stderr(`${error.message}\n`);
          // An error is terminal even on child implementations that do not
          // emit the usual follow-up close event.
          finish({ status: "failed" });
        } catch (sinkError) {
          fail(sinkError);
        }
      }
      function onClose(code: number | null): void {
        if (settled) {
          childClosed = true;
          cleanupAbort();
          detachProcess();
          return;
        }
        childClosed = true;
        try {
          // Flush is part of the source's framing contract: a final NDJSON
          // record need not have a trailing newline.
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
            if (!aborted && !sawTerminalTranslation) {
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
          // child. Translated output and stderr are already better diagnostics.
          if (
            !aborted &&
            !sawStderr &&
            !sawTranslatedEvent &&
            rawStdoutTail.trim()
          ) {
            sink.stderr(`Last stdout:\n${rawStdoutTail.trim()}`);
          }
          finish({
            status: "failed",
            errorMessage: `Child ${childName} exited with code ${code ?? "unknown"}`,
          });
        } catch (error) {
          fail(error);
        }
      }

      proc.stdin.on("error", onStdinError);
      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);
      proc.on("error", onProcessError);
      proc.on("close", onClose);
      if (!signal.aborted) {
        try {
          proc.stdin.write(prompt, "utf-8");
          proc.stdin.end();
        } catch (error) {
          fail(error);
          return;
        }
      }
      if (aborted || signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
}
