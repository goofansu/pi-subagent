import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  loadSkills,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { getFinalOutput } from "./messages.ts";
import type { AgentConfig, OnUpdateCallback, SingleResult } from "./types.ts";

const DEPTH_ENV_KEY = "PI_SUBAGENT_DEPTH";
const MAX_SUBAGENT_DEPTH = 1;

export interface ParentModel {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

export function getSubagentDepth(): number {
  const depth = parseInt(process.env[DEPTH_ENV_KEY] || "0", 10);
  return Number.isNaN(depth) ? 0 : depth;
}

export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  return { command: "pi", args };
}

export function buildPiArgs(
  config: AgentConfig,
  resolvedModel: string | undefined,
  systemPromptPath: string | undefined,
  skillPaths?: string[],
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (resolvedModel) args.push("--model", resolvedModel);
  if (config.tools) {
    args.push("--tools", config.tools);
  }
  if (systemPromptPath) {
    args.push(
      config.appendSystemPrompt ? "--append-system-prompt" : "--system-prompt",
      systemPromptPath,
    );
  }
  if (skillPaths !== undefined) {
    args.push("--no-skills");
    for (const skillPath of skillPaths) {
      args.push("--skill", skillPath);
    }
  }
  // Prompt is passed via stdin, not as a CLI arg, to avoid process-listing
  // exposure of sensitive content and OS argument-length limits (E2BIG).
  return args;
}

export function resolveSubagentModel(
  config: AgentConfig,
  parentModel: ParentModel | undefined,
): string | undefined {
  if (config.model && config.model !== "inherit") return config.model;
  if (!parentModel) return undefined;

  const model = `${parentModel.provider}/${parentModel.id}`;
  return parentModel.thinkingLevel
    ? `${model}:${parentModel.thinkingLevel}`
    : model;
}

/**
 * Build the ordered list of skill paths matching pi's discovery priority:
 * project .pi > project .agents > user .pi > user .agents.
 */
export function buildSkillPaths(
  cwd: string,
  agentDir = getAgentDir(),
): string[] {
  return [
    path.join(cwd, ".pi", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(agentDir, "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
}

export function resolveSkillPaths(
  skillNames: string[],
  cwd: string,
  agentDir = getAgentDir(),
): { resolved: Array<{ name: string; path: string }>; missing: string[] } {
  const skillPaths = buildSkillPaths(cwd, agentDir);
  const { skills: discovered } = loadSkills({
    cwd,
    agentDir,
    skillPaths,
    includeDefaults: false,
  });
  const skillMap = new Map(discovered.map((s) => [s.name, s.filePath]));

  const resolved: Array<{ name: string; path: string }> = [];
  const missing: string[] = [];

  for (const name of skillNames) {
    const filePath = skillMap.get(name);
    if (filePath) {
      resolved.push({ name, path: filePath });
    } else {
      missing.push(name);
    }
  }

  return { resolved, missing };
}

export function resolveAgentSkillPaths(
  config: AgentConfig,
  configCwd: string,
  agentDir = getAgentDir(),
): string[] | undefined {
  if (!config.skills) return undefined;

  const result = resolveSkillPaths(config.skills, configCwd, agentDir);
  if (result.missing.length > 0) {
    throw new Error(
      `Agent '${config.name}': unknown skills: ${result.missing.join(", ")}`,
    );
  }
  return result.resolved.map((s) => s.path);
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

  if (event.type === "agent_end" && Array.isArray(event.messages)) {
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

export async function writePromptToTempFile(
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

export async function runSingleAgent(
  config: AgentConfig,
  description: string,
  prompt: string,
  signal: AbortSignal | undefined,
  parentModel: ParentModel | undefined,
  onUpdate: OnUpdateCallback | undefined,
  cwd = process.cwd(),
  agentDir = getAgentDir(),
  configCwd = cwd,
): Promise<SingleResult> {
  const currentDepth = getSubagentDepth();
  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `Subagent nesting depth ${currentDepth} reached the limit of ${MAX_SUBAGENT_DEPTH}. ` +
        `Subagents cannot spawn other subagents.`,
    );
  }

  const resolvedModel = resolveSubagentModel(config, parentModel);

  const skillPaths = resolveAgentSkillPaths(config, configCwd, agentDir);

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: config.name,
    description,
    exitCode: -1, // -1 = running
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: resolvedModel,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: "text",
            text: getFinalOutput(currentResult.messages) || "(running...)",
          },
        ],
        details: { results: [currentResult] },
      });
    }
  };

  let wasAborted = false;

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
      skillPaths,
    );

    // Emit initial "running" state
    emitUpdate();

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(
        invocation.command,
        invocation.args,
        getSpawnOptions(cwd, currentDepth),
      );
      if (!proc.stdin || !proc.stdout || !proc.stderr) {
        currentResult.stderr += "Failed to open child pi stdio pipes";
        resolve(1);
        return;
      }

      // Write the prompt to stdin and close it so pi reads it cleanly.
      proc.stdin.write(prompt, "utf-8");
      proc.stdin.end();
      let buffer = "";
      let rawStdoutTail = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (applyPiJsonEvent(event, currentResult)) {
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        const chunk = data.toString();
        rawStdoutTail = (rawStdoutTail + chunk).slice(-2000);
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      let procClosed = false;
      proc.on("close", (code) => {
        procClosed = true;
        if (buffer.trim()) processLine(buffer);
        if (
          (code ?? 0) !== 0 &&
          !currentResult.stderr &&
          !currentResult.errorMessage
        ) {
          currentResult.errorMessage =
            `Child pi exited with code ${code ?? "unknown"} without stderr` +
            (rawStdoutTail.trim()
              ? `. Last stdout: ${rawStdoutTail.trim()}`
              : ".");
        }
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        currentResult.stderr += err.message;
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

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
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
