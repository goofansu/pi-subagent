import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text, Box } from "@mariozechner/pi-tui";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  return { command: "pi", args };
}

async function runSingleAgent(
  task: string,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; output: string }> {
  const args: string[] = ["--mode", "json", "-p", "--no-session", task];

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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("subagent", {
    description: "Delegate task to a subagent.",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage("Use subagent tool for the task: greeting!");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn a pi process in JSON mode",
    parameters: Type.Object({
      task: Type.String({ description: "Task to execute" }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // run the agent
      const { exitCode, output } = await runSingleAgent(params.task, signal);

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
