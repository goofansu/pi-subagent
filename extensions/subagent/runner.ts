import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  loadSkills,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { getFinalOutput } from "./messages.js";
import type { AgentConfig, OnUpdateCallback, SingleResult } from "./types.js";

const DEPTH_ENV_KEY = "PI_SUBAGENT_DEPTH";
const MAX_SUBAGENT_DEPTH = 1;

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

/**
 * Build the ordered list of skill paths matching pi's discovery priority:
 * project .pi > project .agents > user .pi > user .agents.
 */
export function buildSkillPaths(cwd: string): string[] {
  const agentDir = getAgentDir();
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
): { resolved: Array<{ name: string; path: string }>; missing: string[] } {
  const skillPaths = buildSkillPaths(cwd);
  const { skills: discovered } = loadSkills({
    cwd,
    agentDir: getAgentDir(),
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
  parentModel: { provider: string; id: string } | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
  const currentDepth = getSubagentDepth();
  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `Subagent nesting depth ${currentDepth} reached the limit of ${MAX_SUBAGENT_DEPTH}. ` +
        `Subagents cannot spawn other subagents.`,
    );
  }

  const resolvedModel =
    !config.model || config.model === "inherit"
      ? parentModel
        ? `${parentModel.provider}/${parentModel.id}`
        : undefined
      : config.model;

  // Resolve skill paths if skills are configured
  let skillPaths: string[] | undefined;
  if (config.skills) {
    const cwd = process.cwd();
    const result = resolveSkillPaths(config.skills, cwd);
    if (result.missing.length > 0) {
      throw new Error(
        `Agent '${config.name}': unknown skills: ${result.missing.join(", ")}`,
      );
    }
    skillPaths = result.resolved.map((s) => s.path);
  }

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
      const proc = spawn(invocation.command, invocation.args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [DEPTH_ENV_KEY]: String(currentDepth + 1),
        },
      });

      // Write the prompt to stdin and close it so pi reads it cleanly.
      proc.stdin.write(prompt, "utf-8");
      proc.stdin.end();
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            currentResult.model = `${msg.provider}/${msg.model}`;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
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
