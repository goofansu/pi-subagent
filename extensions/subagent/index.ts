import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ── Agent config ─────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  systemPrompt: string;
}

function parseAgentConfig(filePath: string): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<{
    description?: string;
    model?: string;
  }>(content);
  return {
    name: path.basename(filePath, path.extname(filePath)),
    description: frontmatter.description ?? "",
    model: frontmatter.model,
    systemPrompt: body.trim(),
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  return { command: "pi", args };
}

async function runSingleAgent(
  config: AgentConfig,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; output: string }> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (config.model) args.push("--model", config.model);
  if (config.systemPrompt)
    args.push("--append-system-prompt", config.systemPrompt);
  args.push(prompt);

  let wasAborted = false;
  let output = "";

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);

    const proc = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.on("close", (code) => {
      resolve(code ?? 0);
    });

    proc.on("error", () => {
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });

  if (wasAborted) throw new Error("Subagent was aborted");
  return { exitCode, output };
}

const agentConfigs = new Map<string, AgentConfig>();
let agentConfigsInit: Promise<void> | undefined;

function loadAgentConfigs(): void {
  const agentsDir = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../../agents",
  );
  agentConfigs.clear();
  if (!fs.existsSync(agentsDir)) return;
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const config = parseAgentConfig(path.join(agentsDir, file));
    agentConfigs.set(config.name, config);
  }
}

function ensureAgentConfigs(): Promise<void> {
  if (!agentConfigsInit) {
    agentConfigsInit = Promise.resolve().then(loadAgentConfigs);
  }
  return agentConfigsInit;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("subagent", {
    description: "Delegate a task to a subagent.",
    handler: async (args, ctx) => {
      let task = args?.trim() || "";

      if (!task) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /subagent <task>", "error");
          return;
        }

        const input = await ctx.ui.editor(
          "What task should the subagent handle?",
        );

        if (!input?.trim()) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        task = input.trim();
      }

      await ctx.waitForIdle();
      pi.sendUserMessage(`Use the subagent tool for the task: ${task}`);
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn a pi process in JSON mode",
    parameters: Type.Object({
      agent: Type.String({ description: "The agent to run the task" }),
      description: Type.String({ description: "Label for this specific call" }),
      prompt: Type.String({ description: "The full task brief" }),
    }),

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const header =
        theme.fg("toolTitle", theme.bold(args.agent)) +
        " " +
        theme.fg("muted", args.description);
      text.setText(`${header}\n${theme.fg("toolOutput", args.prompt)}`);
      return text;
    },

    renderResult(result, _options, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const resultText = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text)
        .join("\n");
      text.setText(`\n${theme.fg("toolOutput", resultText)}`);
      return text;
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await ensureAgentConfigs();
      const config = agentConfigs.get(params.agent);
      if (!config) {
        throw new Error(
          `Unknown agent: "${params.agent}". Available: ${[...agentConfigs.keys()].join(", ") || "none"}`,
        );
      }
      const { exitCode, output } = await runSingleAgent(
        config,
        params.prompt,
        signal,
      );

      // parse JSON output lines and extract final assistant text
      let result = "";
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (
            event.type === "message_end" &&
            event.message?.role === "assistant"
          ) {
            for (const part of event.message.content ?? []) {
              if (part.type === "text") result = part.text;
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      }

      return {
        content: [{ type: "text", text: result || `(exit code ${exitCode})` }],
        details: {},
      };
    },
  });
}
