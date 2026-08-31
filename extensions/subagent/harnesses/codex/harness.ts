import type { RunEnding, SubagentContext, SubagentTask } from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import {
  effortField,
  type Harness,
  type HarnessAdapter,
  type HarnessDiagnostic,
  stringField,
} from "../contract.ts";
import type { CodexAppServerSessionOptions } from "./app-server.ts";
import { createCodexAppServerSession } from "./app-server.ts";

const CODEX_PROFILE_FIELDS = ["model", "effort"] as const;
const MISSING_CODEX_ANSWER =
  "Codex exited without a terminal agent message answer.";

export interface CodexHarnessOptions {
  readonly spawn?: CodexAppServerSessionOptions["spawn"];
  readonly killEscalationMs?: number;
}

export function codexEffort(effort: string | undefined): string | undefined {
  return effort === "off" ? "none" : effort;
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

function codexPrompt(context: SubagentContext, task: SubagentTask): string {
  return context.config.systemPrompt
    ? `${context.config.systemPrompt}\n\n${task.prompt}`
    : task.prompt;
}

/** Create the Codex harness using one retained App Server session per adapter. */
export function createCodexHarness(options: CodexHarnessOptions = {}): Harness {
  return {
    name: "codex",
    validate: validateCodexProfile,
    prepare(context: SubagentContext): HarnessAdapter {
      const model = stringField(context.config, "model", "profile");
      const effort = codexEffort(
        effortField(context.config, "profile", EFFORTS),
      );
      let session: ReturnType<typeof createCodexAppServerSession> | undefined;
      let activeRun: Promise<RunEnding> | undefined;
      let closed = false;
      const prepareRun: HarnessAdapter["prepareRun"] = (task) => ({
        supportedControls: ["steer"],
        execute: async (run) => {
          if (closed) {
            return {
              ending: "failed",
              errorMessage: "Codex adapter is closed",
            };
          }
          if (activeRun) {
            return {
              ending: "failed",
              errorMessage: "Codex adapter already has an active Run",
            };
          }
          if (!session)
            session = createCodexAppServerSession({
              cwd: context.cwd,
              childDepth: context.childDepth,
              model,
              effort,
              ...(options.spawn ? { spawn: options.spawn } : {}),
              ...(options.killEscalationMs === undefined
                ? {}
                : { killEscalationMs: options.killEscalationMs }),
            });
          const retainedSession = session;
          const firstProviderTurn = !retainedSession.hasIssuedTurn;
          // Yield once so activeRun is installed before spawning. Close
          // can then own cancellation even when provider callbacks re-enter
          // Session shutdown during synchronous fixture I/O.
          const promise = (async (): Promise<RunEnding> => {
            await Promise.resolve();
            if (closed) return { ending: "cancelled" };
            return await retainedSession.runNextTurn({
              prompt: firstProviderTurn
                ? codexPrompt(context, task)
                : task.prompt,
              report: run.report,
              signal: run.signal,
              controls: run.controls,
              missingAnswerMessage: MISSING_CODEX_ANSWER,
            });
          })();
          activeRun = promise;
          try {
            return await promise;
          } finally {
            if (activeRun === promise) activeRun = undefined;
          }
        },
      });
      return {
        model,
        prepareRun,
        admitResume: (task) =>
          closed || (session !== undefined && !session.continuationAvailable)
            ? { outcome: "conversation lost" }
            : { outcome: "admitted", run: prepareRun(task) },
        close: async () => {
          closed = true;
          const current = activeRun;
          await session?.close();
          await current?.catch(() => {});
        },
      };
    },
  };
}
