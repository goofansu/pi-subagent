import type {
  Harness,
  HarnessDiagnostic,
  HarnessRun,
  HarnessValidationContext,
} from "./harness.ts";
import {
  booleanField,
  effortField,
  stringField,
  unknownFields,
} from "./harness.ts";
import { type PiSpawn, runPiAgent } from "./pi-agent.ts";
import type { ParentModel, SubagentTask } from "./run.ts";
import { type AgentConfig, EFFORTS } from "./types.ts";

export interface PiHarnessOptions {
  readonly spawn?: PiSpawn;
}

export function createPiHarness(
  models: readonly { provider: string; id: string }[] = [],
  options: PiHarnessOptions = {},
): Harness {
  return {
    name: "pi",
    validate(
      profile: AgentConfig,
      filePath: string,
      context?: HarnessValidationContext,
    ): HarnessDiagnostic[] {
      const diagnostics: HarnessDiagnostic[] = [];
      for (const field of unknownFields(profile, [
        "model",
        "effort",
        "tools",
        "appendSystemPrompt",
      ])) {
        diagnostics.push({
          reason: `Pi harness does not recognize field '${field}'`,
        });
      }
      try {
        const model = stringField(profile, "model", filePath);
        effortField(profile, filePath, EFFORTS);
        stringField(profile, "tools", filePath);
        booleanField(profile, "appendSystemPrompt", filePath);
        const catalogue = context?.models ?? models;
        if (model) {
          const known = new Set(
            catalogue.flatMap((entry) => [
              entry.id.toLowerCase(),
              `${entry.provider}/${entry.id}`.toLowerCase(),
            ]),
          );
          if (!known.has(model.toLowerCase())) {
            diagnostics.push({
              reason: `model '${model}' was not found in Pi's model catalogue`,
            });
          }
        }
      } catch (error) {
        diagnostics.push({
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return diagnostics;
    },
    prepare(task: SubagentTask, parentModel?: ParentModel): HarnessRun {
      const profileModel = stringField(task.config, "model", "profile");
      const effort = effortField(task.config, "profile", EFFORTS);
      const model =
        profileModel ??
        (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined);
      const thinking =
        effort ?? (profileModel ? undefined : parentModel?.thinkingLevel);
      return {
        model,
        effort,
        execute: (run) =>
          runPiAgent(run, {
            resolvedModel: model,
            resolvedThinking: thinking,
            ...(options.spawn ? { spawn: options.spawn } : {}),
          }),
      };
    },
  };
}
