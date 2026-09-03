/**
 * The child process, behind the narrowest interface the adapter can work
 * through.
 *
 * `node:child_process` is named in this file and nowhere else in v2, and the
 * boundary test enforces it. That is not tidiness: a `ChildProcess` is a
 * sprawling event emitter with two duplex streams, a signal API, and a dozen
 * ways to be half-open, and an adapter written against all of it would be an
 * adapter no test could drive without a real binary. So the adapter is written
 * against {@link CodexChildProcess} — nine members, every one of them
 * something the transport actually does — and the real `spawn` is one adapter
 * onto it.
 *
 * That is also what makes the stand-in App Server a *drop-in* rather than a
 * mock: it implements this interface, the transport cannot tell the
 * difference, and no production line branches on whether it is under test.
 *
 * Two members exist purely for backpressure. Codex's stdout is process-wide
 * and outlives every Run, and the reader emits into the active Run's intake
 * with backpressure — so when the reducer is behind, the honest thing is to
 * stop reading stdout rather than to buffer without bound. `pauseStdout` and
 * `resumeStdout` are how the transport says so.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { DEPTH_ENV_KEY } from "../depth.ts";

/** The binary, and the one subcommand this adapter drives. */
export const CODEX_COMMAND = "codex";
export const CODEX_ARGUMENTS: readonly string[] = ["app-server"];

/** The two signals the escalation ladder sends. */
export type CodexSignal = "SIGTERM" | "SIGKILL";

/** How a child ended, as much of it as the adapter reports on. */
export interface CodexProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** What the transport needs of a child process, and nothing more. */
export interface CodexChildProcess {
  /** The operating-system id, when there is one. Evidence only. */
  readonly pid: number | undefined;
  /** Write one framed line. `false` means it did not go. */
  readonly write: (line: string) => boolean;
  /** End stdin, which is how a graceful close begins. Idempotent. */
  readonly endStdin: () => void;
  /** Signal the child. Safe against a child that has already exited. */
  readonly kill: (signal: CodexSignal) => void;
  readonly onStdout: (listener: (chunk: string) => void) => void;
  readonly onStderr: (listener: (chunk: string) => void) => void;
  /** Called once, whichever way the child ends. */
  readonly onExit: (listener: (exit: CodexProcessExit) => void) => void;
  /** Stop reading stdout, because the Run's intake is behind. */
  readonly pauseStdout: () => void;
  readonly resumeStdout: () => void;
}

export interface CodexSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * How a child is started. The injection point for the stand-in.
 *
 * It may throw: a missing binary is the ordinary failure, and `open` turns
 * whatever comes out of here into one redacted `backend unavailable`.
 */
export type CodexSpawn = (request: CodexSpawnRequest) => CodexChildProcess;

/**
 * What the child's environment is, without touching the parent's.
 *
 * The operator's environment plus the shared depth key, exactly as the Claude
 * adapter builds its child's. The key lives in `backend/depth.ts` rather than
 * here because a Bash-launched grandchild has to read the same variable
 * whichever backend spawned its parent.
 */
export function codexChildEnvironment(
  childDepth: number,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  env[DEPTH_ENV_KEY] = String(childDepth);
  return env;
}

/** The spawn request for one Subagent's App Server. */
export function codexSpawnRequest(
  cwd: string,
  childDepth: number,
  base?: Readonly<Record<string, string | undefined>>,
): CodexSpawnRequest {
  return {
    command: CODEX_COMMAND,
    args: CODEX_ARGUMENTS,
    cwd,
    env: codexChildEnvironment(childDepth, base),
  };
}

/** What a partially opened child is reported as, before it is killed. */
export const CODEX_STDIO_UNAVAILABLE = "codex app-server stdio is unavailable";

/**
 * Spawn the real binary, as a {@link CodexChildProcess}.
 *
 * `shell: false` deliberately: the command and its one argument are fixed, and
 * a shell would add a parse of a string this adapter never needs to build.
 *
 * A child whose pipes did not open is killed here and reported as unavailable,
 * rather than returned as a handle whose `write` would silently do nothing.
 */
export const spawnCodexAppServer: CodexSpawn = (request) => {
  const child = nodeSpawn(request.command, [...request.args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: request.cwd,
    env: { ...request.env },
  });
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    try {
      child.kill("SIGKILL");
    } catch {
      // A child with no pipes may already be gone.
    }
    throw new Error(CODEX_STDIO_UNAVAILABLE);
  }
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  let stdinEnded = false;
  // A child that dies while a write is in flight raises EPIPE on stdin, and an
  // unhandled 'error' on a stream is a process-level throw. Loss is reported
  // through the exit watch instead, which is the authoritative signal.
  stdin.on("error", () => {});
  return {
    pid: child.pid,
    write: (line) => {
      if (stdinEnded) return false;
      try {
        stdin.write(line, "utf8");
        return true;
      } catch {
        return false;
      }
    },
    endStdin: () => {
      if (stdinEnded) return;
      stdinEnded = true;
      try {
        stdin.end();
      } catch {
        // The child may have closed its own end already.
      }
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between escalation stages.
      }
    },
    onStdout: (listener) => {
      stdout.on("data", (chunk: string | Buffer) => listener(String(chunk)));
    },
    onStderr: (listener) => {
      stderr.on("data", (chunk: string | Buffer) => listener(String(chunk)));
    },
    onExit: (listener) => {
      // Both events can fire, and the interface promises one exit, so the
      // first one wins. A spawn that fails asynchronously — ENOENT for a
      // missing binary — emits 'error' and may emit no 'close' at all, which
      // is why 'error' is an exit here rather than a separate signal.
      let ended = false;
      const end = (exit: CodexProcessExit): void => {
        if (ended) return;
        ended = true;
        listener(exit);
      };
      child.once("close", (code: number | null, signal: string | null) =>
        end({ code, signal }),
      );
      child.once("error", () => end({ code: null, signal: null }));
    },
    pauseStdout: () => stdout.pause(),
    resumeStdout: () => stdout.resume(),
  };
};
