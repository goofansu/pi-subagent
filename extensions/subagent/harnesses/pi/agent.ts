/**
 * The pi harness adapter — resolves the pi invocation and translates its
 * NDJSON event stream into neutral facts. Process lifetime belongs to the
 * shared child-process source; this module keeps pi policy and wire knowledge.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getPackageDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  type ChildProcessSpawn,
  processJsonSource,
} from "../../child-process.ts";
import { runOneShot, type Translation } from "../../one-shot.ts";
import type {
  Fact,
  FactPart,
  RunEnding,
  SubagentContext,
  SubagentRun,
  SubagentTask,
} from "../../run.ts";
import type { AgentConfig } from "../../types.ts";
import { parseTools, shouldAppendSystemPrompt } from "../contract.ts";

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
  const tools = parseTools(config, "profile");
  if (tools !== undefined) args.push("--tools", tools.join(","));
  if (systemPromptPath) {
    args.push(
      shouldAppendSystemPrompt(config, "profile")
        ? "--append-system-prompt"
        : "--system-prompt",
      systemPromptPath,
    );
  }
  // Prompt is passed via stdin, not as a CLI arg, to avoid process-listing
  // exposure of sensitive content and OS argument-length limits (E2BIG).
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function factPart(value: unknown): FactPart | undefined {
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

function piFact(value: unknown): Fact | undefined {
  if (!isRecord(value)) return undefined;
  const wireRole = value.role;
  const role = wireRole === "toolResult" ? "tool" : wireRole;
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
    .filter((part): part is FactPart => part !== undefined);
  // Thinking and provider-specific content blocks do not cross the harness
  // seam, but their message metadata still does. An empty parts array is a
  // meaningful fact when it carries usage, a stop reason, or an error.
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
): Translation | undefined {
  if (
    (event.type === "message_end" || event.type === "tool_result_end") &&
    event.message
  ) {
    const fact = piFact(event.message);
    return fact ? { facts: [fact] } : undefined;
  }
  if (isValidAgentEndEvent(event)) {
    return {
      transcript: event.messages
        .map(piFact)
        .filter((fact): fact is Fact => fact !== undefined),
      terminal: true,
    };
  }
  return undefined;
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

export async function runPiAgent(
  run: SubagentRun,
  {
    context,
    task,
    resolvedModel,
    resolvedThinking,
    spawn,
    killEscalationMs,
  }: {
    context: SubagentContext;
    task: SubagentTask;
    resolvedModel?: string;
    resolvedThinking?: string;
    spawn?: ChildProcessSpawn;
    killEscalationMs?: number;
  },
): Promise<RunEnding> {
  const { config } = context;
  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

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
      context.projectTrusted,
    );
    const invocation = getPiInvocation(args);
    return await runOneShot({
      source: processJsonSource({
        command: invocation.command,
        args: invocation.args,
        cwd: context.cwd,
        childDepth: context.childDepth,
        prompt: task.prompt,
        childName: "pi",
        ...(spawn ? { spawn } : {}),
        ...(killEscalationMs === undefined ? {} : { killEscalationMs }),
      }),
      translate: translatePiJsonEvent,
      report: run.report,
      signal: run.signal,
      missingAnswerMessage: MISSING_AGENT_END_ERROR,
    });
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
