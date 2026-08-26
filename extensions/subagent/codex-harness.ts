import { type ChildProcessSpawn, runChildProcess } from "./child-process.ts";
import {
  effortField,
  type Harness,
  type HarnessDiagnostic,
  type HarnessRun,
  stringField,
} from "./harness.ts";
import {
  ABORTED_STOP_REASON,
  type Fact,
  type FactPart,
  type ParentModel,
  type RunReporter,
  type SubagentTask,
} from "./run.ts";
import { type AgentConfig, EFFORTS } from "./types.ts";

const CODEX_PROFILE_FIELDS = ["model", "effort"] as const;
const MISSING_CODEX_ANSWER =
  "Codex exited without a terminal agent message answer.";

export interface CodexHarnessOptions {
  readonly spawn?: ChildProcessSpawn;
  readonly killEscalationMs?: number;
}

export function codexEffort(effort: string | undefined): string | undefined {
  return effort === "off" ? "none" : effort;
}

/** Build the settled one-shot Codex CLI invocation. */
export function buildCodexArgs(
  cwd: string,
  model: string | undefined,
  effort: string | undefined,
): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    cwd,
  ];
  // Trust posture is parity with the claude harness (ADR-0009): every codex
  // child bypasses approvals and sandbox regardless of the forwarded
  // projectTrusted value, which stays in the request reserved for a future
  // shared policy. A non-interactive child could never answer approvals.
  args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("-m", model);
  const resolvedEffort = codexEffort(effort);
  if (resolvedEffort)
    args.push("-c", `model_reasoning_effort=${resolvedEffort}`);
  args.push("-");
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textPart(text: unknown): FactPart[] {
  return typeof text === "string" ? [{ type: "text", text }] : [];
}

function usageFact(usage: Record<string, unknown>): Fact {
  const number = (key: string): number =>
    typeof usage[key] === "number" ? usage[key] : 0;
  return {
    role: "metadata",
    parts: [],
    usage: {
      input: number("input_tokens"),
      cacheRead: number("cached_input_tokens"),
      cacheWrite: number("cache_write_input_tokens"),
      output: number("output_tokens") + number("reasoning_output_tokens"),
      turns: 1,
    },
  };
}

/** Translate one Codex JSONL event into neutral facts at the adapter edge. */
export function translateCodexJsonEvent(
  event: Record<string, unknown>,
  report: RunReporter,
): { terminal: boolean; errorMessage?: string } {
  if (event.type === "item.started" && isRecord(event.item)) {
    if (
      event.item.type === "command_execution" &&
      typeof event.item.command === "string"
    ) {
      report.message({
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "command_execution",
            arguments: { command: event.item.command },
          },
        ],
        usage: { turns: 0 },
      });
    }
    return { terminal: false };
  }

  if (event.type === "item.completed" && isRecord(event.item)) {
    if (event.item.type === "agent_message") {
      report.message({
        role: "assistant",
        parts: textPart(event.item.text),
        usage: { turns: 0 },
      });
      return { terminal: true };
    }
    return { terminal: false };
  }

  if (event.type === "turn.completed") {
    report.message(usageFact(isRecord(event.usage) ? event.usage : {}));
    return { terminal: false };
  }

  if (event.type === "error") {
    const errorMessage =
      typeof event.message === "string"
        ? event.message
        : "Codex reported an error";
    report.message({
      role: "metadata",
      parts: [],
      errorMessage,
    });
    return { terminal: false, errorMessage };
  }

  if (event.type === "turn.failed") {
    const error = isRecord(event.error) ? event.error.message : undefined;
    const errorMessage =
      typeof error === "string" ? error : "Codex turn failed";
    report.message({
      role: "metadata",
      parts: [],
      errorMessage,
    });
    return { terminal: false, errorMessage };
  }

  return { terminal: false };
}

function validateCodexProfile(
  profile: AgentConfig,
  filePath: string,
): HarnessDiagnostic[] {
  const diagnostics = Object.keys(profile.fields ?? {})
    .filter(
      (field) => !(CODEX_PROFILE_FIELDS as readonly string[]).includes(field),
    )
    .map((field) => ({
      reason: `Codex harness does not recognize field '${field}'`,
    }));
  try {
    stringField(profile, "model", filePath);
    effortField(profile, filePath, EFFORTS);
  } catch (error) {
    diagnostics.push({
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return diagnostics;
}

function codexPrompt(task: SubagentTask): string {
  return task.config.systemPrompt
    ? `${task.config.systemPrompt}\n\n${task.prompt}`
    : task.prompt;
}

/** Create the Codex one-shot harness without loading or invoking Codex itself. */
export function createCodexHarness(options: CodexHarnessOptions = {}): Harness {
  return {
    name: "codex",
    validate: validateCodexProfile,
    prepare(task: SubagentTask, _parentModel?: ParentModel): HarnessRun {
      const model = stringField(task.config, "model", "profile");
      const effort = effortField(task.config, "profile", EFFORTS);
      return {
        model,
        execute: async (run) => {
          let terminalAnswer = false;
          let errorMessage: string | undefined;
          const report: RunReporter = {
            message: (fact) => run.report.message(fact),
            transcript: (facts) => run.report.transcript(facts),
            stderr: (chunk) => run.report.stderr(chunk),
          };
          const child = await runChildProcess({
            command: "codex",
            args: buildCodexArgs(task.cwd, model, effort),
            cwd: task.cwd,
            childDepth: task.childDepth,
            prompt: codexPrompt(task),
            signal: run.signal,
            ...(options.spawn ? { spawn: options.spawn } : {}),
            ...(options.killEscalationMs === undefined
              ? {}
              : { killEscalationMs: options.killEscalationMs }),
            onStderr: (chunk) => run.report.stderr(chunk),
            onLine: (line) => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                return false;
              }
              if (!isRecord(parsed)) return false;
              const translated = translateCodexJsonEvent(parsed, report);
              if (translated.errorMessage)
                errorMessage = translated.errorMessage;
              if (translated.terminal) terminalAnswer = true;
              return translated.terminal;
            },
          });

          if (child.aborted && !child.terminalBeforeAbort) {
            return { stopReason: ABORTED_STOP_REASON };
          }
          if (errorMessage && !terminalAnswer) {
            return {
              exitCode: child.exitCode ?? 1,
              stopReason: "error",
              errorMessage,
            };
          }
          if (child.exitCode !== 0 && !child.terminalBeforeAbort) {
            return {
              exitCode: child.exitCode,
              stopReason: "error",
              errorMessage: `Child codex exited with code ${child.exitCode ?? "unknown"}`,
            };
          }
          if (!terminalAnswer) {
            return {
              exitCode: 1,
              stopReason: "error",
              errorMessage: MISSING_CODEX_ANSWER,
            };
          }
          return {
            exitCode:
              child.aborted && child.terminalBeforeAbort ? 0 : child.exitCode,
          };
        },
      };
    },
  };
}
