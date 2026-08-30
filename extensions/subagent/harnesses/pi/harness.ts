import type { ChildProcessSpawn } from "../../child-process.ts";
import type { SubagentContext } from "../../run.ts";
import { type AgentConfig, EFFORTS } from "../../types.ts";
import type {
  Harness,
  HarnessAdapter,
  HarnessDiagnostic,
  HarnessValidationContext,
} from "../contract.ts";
import {
  effortField,
  stringField,
  validateCommonProfileFields,
} from "../contract.ts";
import { runPiAgent } from "./agent.ts";

const MAX_CATALOGUE_DIAGNOSTIC_CHARS = 512;

function catalogueSummary(values: readonly string[]): string {
  if (values.length === 0) return "none";
  const shown: string[] = [];
  const omitted = `… (${values.length} catalogue models total)`;
  for (const [index, value] of values.entries()) {
    const candidate = [...shown, value].join(", ");
    const suffix = index < values.length - 1 ? `, ${omitted}` : "";
    if (`${candidate}${suffix}`.length > MAX_CATALOGUE_DIAGNOSTIC_CHARS) break;
    shown.push(value);
  }
  if (shown.length === values.length) return shown.join(", ");
  return shown.length > 0 ? `${shown.join(", ")}, ${omitted}` : omitted;
}

export interface PiHarnessOptions {
  readonly spawn?: ChildProcessSpawn;
}

export function createPiHarness(options: PiHarnessOptions = {}): Harness {
  return {
    name: "pi",
    /**
     * Omitting context means the Pi model catalogue is empty. Session profile
     * loading supplies the catalogue through HarnessValidationContext.
     */
    validate(
      profile: AgentConfig,
      filePath: string,
      context?: HarnessValidationContext,
    ): HarnessDiagnostic[] {
      return validateCommonProfileFields(profile, filePath, {
        displayName: "Pi",
        validateModel: (model) => {
          const catalogue = context?.models ?? [];
          if (!model) return undefined;
          const accepted = catalogue.flatMap((entry) => [
            entry.id,
            `${entry.provider}/${entry.id}`,
          ]);
          const known = new Set(accepted);
          const catalogueModels = catalogue.map(
            (entry) => `${entry.provider}/${entry.id}`,
          );
          return known.has(model)
            ? undefined
            : {
                reason: `model '${model}' was not found in Pi's model catalogue (catalogue models include: ${catalogueSummary(catalogueModels)})`,
              };
        },
      });
    },
    prepare(context: SubagentContext): HarnessAdapter {
      const profileModel = stringField(context.config, "model", "profile");
      const effort = effortField(context.config, "profile", EFFORTS);
      // Validation accepts the exact catalogue spelling and execution passes
      // that same spelling through to pi.
      const model =
        profileModel ??
        (context.parentModel
          ? `${context.parentModel.provider}/${context.parentModel.id}`
          : undefined);
      const thinking =
        effort ??
        (profileModel ? undefined : context.parentModel?.thinkingLevel);
      return {
        capabilities: { resume: false },
        model,
        prepareRun: (task) => ({
          supportedControls: [],
          execute: (run) =>
            runPiAgent(run, {
              context,
              task,
              resolvedModel: model,
              resolvedThinking: thinking,
              ...(options.spawn ? { spawn: options.spawn } : {}),
            }),
        }),
        close: async () => {},
      };
    },
  };
}
