import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  DEPTH_ENV_KEY,
  type RunEnding,
  type SubagentContext,
} from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import type {
  Harness,
  HarnessAdapter,
  HarnessDiagnostic,
} from "../contract.ts";
import {
  effortField,
  parseTools,
  shouldAppendSystemPrompt,
  stringField,
  validateCommonProfileFields,
} from "../contract.ts";
import { runClaudeAttempt } from "./attempt.ts";

type ClaudeQuery = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;
type ClaudeQueryLoader = () => Promise<ClaudeQuery>;

/**
 * The SDK documents these family aliases and resolves each to its current
 * default ID itself, so no local alias→ID mapping or full-ID allowlist is
 * kept — both went stale in practice as models shipped. Only aliases are
 * accepted: a full or dated ID would need such an allowlist to validate
 * deterministically at session start, and profiles here always want the
 * current model of a family. Canonical model provenance on the run record
 * comes from the child's streamed facts, which are authoritative over this
 * baseline.
 */
export const CLAUDE_MODEL_ALIASES: readonly string[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
];
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 512,
  low: 1_024,
  medium: 4_096,
  high: 8_192,
  xhigh: 16_384,
  max: 32_768,
};

const loadClaudeQuery: ClaudeQueryLoader = async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query;
};

function isClaudeModel(value: string): boolean {
  return CLAUDE_MODEL_ALIASES.includes(value.toLowerCase());
}

export function claudeThinking(
  effort: string | undefined,
): Options["thinking"] {
  if (!effort || effort === "off")
    return effort === "off" ? { type: "disabled" } : undefined;
  return {
    type: "enabled",
    budgetTokens: THINKING_BUDGETS[effort] ?? THINKING_BUDGETS.high,
  };
}

export function buildClaudeOptions(
  context: SubagentContext,
  model: string | undefined,
  effort: string | undefined,
  abortController: AbortController,
): Options {
  const tools = parseTools(context.config, "profile");
  const append = shouldAppendSystemPrompt(context.config, "profile");
  const options: Options = {
    cwd: context.cwd,
    model,
    abortController,
    thinking: claudeThinking(effort),
    ...(effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)
      ? { effort: effort as NonNullable<Options["effort"]> }
      : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: ["Agent", "Task"],
    // The SDK's `env` replaces the subprocess environment entirely rather
    // than merging, so spread process.env to keep the ADR-0008 inheritance.
    // The depth key closes the other half of the Depth constraint:
    // disallowedTools stops in-SDK spawning, this stops a Bash-launched
    // grandchild pi from starting at depth zero.
    env: { ...process.env, [DEPTH_ENV_KEY]: String(context.childDepth) },
    ...(tools !== undefined ? { tools } : {}),
    systemPrompt: append
      ? {
          type: "preset",
          preset: "claude_code",
          append: context.config.systemPrompt,
        }
      : context.config.systemPrompt,
  };
  return options;
}

export function createClaudeHarness(
  loadQuery: ClaudeQueryLoader = loadClaudeQuery,
): Harness {
  return {
    name: "claude",
    validate(profile: AgentConfig, filePath: string): HarnessDiagnostic[] {
      return validateCommonProfileFields(profile, filePath, {
        displayName: "Claude",
        validateModel: (model) =>
          model && !isClaudeModel(model)
            ? {
                reason: `invalid Claude model '${model}' (expected one of: ${CLAUDE_MODEL_ALIASES.join(", ")})`,
              }
            : undefined,
      });
    },
    prepare(context: SubagentContext): HarnessAdapter {
      // The alias is passed through as-is; the SDK resolves it to the
      // family's current default ID.
      const model = stringField(
        context.config,
        "model",
        "profile",
      )?.toLowerCase();
      const effort = effortField(context.config, "profile", EFFORTS);
      let continuation: string | undefined;
      let active: Promise<RunEnding> | undefined;
      let closed = false;
      let closePromise: Promise<void> | undefined;
      const closeController = new AbortController();
      const prepareRun: HarnessAdapter["prepareRun"] = (task) => ({
        supportedControls: ["steer"],
        async execute(run) {
          if (closed || run.signal?.aborted) return { ending: "cancelled" };
          if (active) {
            return {
              ending: "failed",
              errorMessage: "Claude adapter already has an active Run",
            };
          }
          const execution = runClaudeAttempt({
            run,
            task,
            conversation: {
              continuation,
              closeSignal: closeController.signal,
              loadQuery,
              retainContinuation(identity) {
                if (continuation === undefined) continuation = identity;
              },
            },
            buildOptions: (controller) =>
              buildClaudeOptions(context, model, effort, controller),
          });
          active = execution;
          try {
            return await execution;
          } finally {
            if (active === execution) active = undefined;
          }
        },
      });
      return {
        model,
        prepareRun,
        admitResume: (task) => ({ outcome: "admitted", run: prepareRun(task) }),
        close() {
          closePromise ??= (async () => {
            closed = true;
            closeController.abort();
            await active?.catch(() => undefined);
            continuation = undefined;
          })();
          return closePromise;
        },
      };
    },
  };
}
