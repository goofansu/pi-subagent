/**
 * The child pi driver — spawns pi in headless JSON mode and folds its NDJSON
 * event stream into the normalized result the tool result and TUI read.
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
import type { ParentModel, SubagentRun } from "./run.ts";
import { appendStderr, DEPTH_ENV_KEY, settleAborted } from "./run.ts";
import type { AgentConfig, SingleResult } from "./types.ts";
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

function recordAssistantUsage(result: SingleResult, msg: Message): void {
  const assistant = msg as Message & {
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
    provider?: string;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  result.usage.turns++;
  const usage = assistant.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }
  if (assistant.provider && assistant.model) {
    result.model = `${assistant.provider}/${assistant.model}`;
  }
  if (assistant.stopReason) result.stopReason = assistant.stopReason;
  if (assistant.errorMessage) result.errorMessage = assistant.errorMessage;
}

function appendMessage(result: SingleResult, msg: Message): void {
  result.messages.push(msg);
  if (msg.role === "assistant") recordAssistantUsage(result, msg);
}

function isValidAgentEndEvent(event: Record<string, unknown>): boolean {
  return event.type === "agent_end" && Array.isArray(event.messages);
}

export function applyPiJsonEvent(
  event: Record<string, unknown>,
  result: SingleResult,
): boolean {
  if (event.type === "message_end" && event.message) {
    appendMessage(result, event.message as Message);
    return true;
  }

  if (event.type === "tool_result_end" && event.message) {
    result.messages.push(event.message as Message);
    return true;
  }

  if (isValidAgentEndEvent(event)) {
    result.messages = [];
    result.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    };
    for (const msg of event.messages as Message[]) {
      appendMessage(result, msg);
    }
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

/**
 * Run one agent in a child pi process. This is the dispatcher's default
 * executor; see `SubagentExecutor` in `run.ts` for the contract it satisfies,
 * cancellation included.
 */
export async function runPiAgent(run: SubagentRun): Promise<SingleResult> {
  const { task, result, emit, signal } = run;
  const { config } = task;

  const resolvedModel = resolveSubagentModel(config, task.parentModel);
  result.model = resolvedModel;

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let wasAborted = false;
  let sawValidAgentEnd = false;
  let rawStdoutTail = "";

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

    // Emit initial "running" state
    emit();

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(
        invocation.command,
        invocation.args,
        getSpawnOptions(task.cwd, task.depth),
      );
      if (!proc.stdin || !proc.stdout || !proc.stderr) {
        result.stderr = appendStderr(
          result.stderr,
          "Failed to open child pi stdio pipes",
        );
        resolve(1);
        return;
      }

      // Write the prompt to stdin and close it so pi reads it cleanly.
      proc.stdin.write(task.prompt, "utf-8");
      proc.stdin.end();
      let buffer = "";

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
        const isValidAgentEnd = isValidAgentEndEvent(event);
        if (applyPiJsonEvent(event, result)) {
          if (isValidAgentEnd) sawValidAgentEnd = true;
          emit();
        }
      };

      proc.stdout.on("data", (data) => {
        const chunk = data.toString();
        rawStdoutTail = (rawStdoutTail + chunk).slice(-RAW_STDOUT_TAIL_LIMIT);
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        result.stderr = appendStderr(result.stderr, data.toString());
      });

      let procClosed = false;
      proc.on("close", (code) => {
        procClosed = true;
        if (buffer.trim()) processLine(buffer);
        if ((code ?? 0) !== 0 && !result.stderr && !result.errorMessage) {
          result.errorMessage =
            `Child pi exited with code ${code ?? "unknown"} without stderr` +
            (rawStdoutTail.trim()
              ? `. Last stdout: ${rawStdoutTail.trim()}`
              : ".");
        }
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        result.stderr = appendStderr(result.stderr, err.message);
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!procClosed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else {
          signal.addEventListener("abort", killProc, { once: true });
          // Remove the listener once the process has closed so a late abort
          // signal doesn't incorrectly mark a successfully completed run as aborted.
          proc.on("close", () => signal.removeEventListener("abort", killProc));
        }
      }
    });

    result.exitCode = exitCode;
    // Cancellation is a resolved result, not a rejection — see the executor
    // contract and {@link settleAborted}. A killed child's exit code says
    // nothing useful, so the abort overrides whatever it reported.
    if (wasAborted) {
      settleAborted(result);
    } else if (exitCode === 0 && !sawValidAgentEnd) {
      result.exitCode = 1;
      result.stopReason = "error";
      const stdoutTail = rawStdoutTail.trim();
      result.errorMessage = stdoutTail
        ? `${MISSING_AGENT_END_ERROR} Last stdout:\n${stdoutTail}`
        : `${MISSING_AGENT_END_ERROR} No stdout was captured.`;
    }
    return result;
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
