/**
 * The fixed native policy one retained Pi session is constructed with.
 *
 * Trust forwarding, orchestration-tool exclusion, and Bash depth propagation
 * are retained from v1. Disabling extensions is the newer decision that makes
 * the Profile authoritative:
 *
 * - **Trust is forwarded, never re-derived.** A child runs non-interactively,
 *   so it can neither prompt for trust nor see a session-only decision; the
 *   delegating Session's answer for this working directory is the answer.
 * - **Extensions are disabled.** A Profile is the complete policy for a Pi
 *   child; user extensions must not replace its model, prompt, tools, or other
 *   behaviour during startup. Providers and models supplied by Pi's catalogue
 *   remain available.
 * - **The orchestration tools are excluded.** Belt and braces with disabled
 *   extensions: even a child that somehow reached the registrations cannot
 *   call them.
 * - **Bash carries the depth.** The spawn hook adds the depth variable to each
 *   spawn's own environment. `process.env` is never mutated, because the
 *   parent is a long-lived process and a mutated environment would outlive the
 *   Run that wanted it.
 *
 * Nothing here performs provider I/O. Building the options reads the agent
 * directory's auth and model files and discovers non-extension resources; the
 * model is resolved against Pi's catalogue, and a model that is not there fails
 * the open rather than the first Run.
 */

import {
  createAgentSessionServices,
  createBashToolDefinition,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Profile, SubagentContext } from "../../domain/index.ts";
import { DEPTH_ENV_KEY } from "../depth.ts";
import { parseTools, shouldAppendSystemPrompt } from "../profile-fields.ts";
import { withChildResourceLoad } from "./child-load.ts";
import type { PiSessionOptions } from "./session.ts";

/** The seven delegation tools a child may not have. */
export const PI_ORCHESTRATION_TOOLS = [
  "agent_start",
  "agent_resume",
  "agent_wait",
  "agent_wait_all",
  "agent_result",
  "agent_cancel",
  "agent_steer",
] as const;

/** Pi's native thinking levels, deliberately separate from shared efforts. */
const PI_THINKING_LEVELS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The thinking level, when the resolved effort is one Pi understands.
 *
 * Pi has six native levels. The shared `off` effort deliberately omits the
 * setting, leaving the retained session's own default; every other unknown
 * value is omitted rather than cast through to the SDK.
 */
function thinkingLevel(effort: string | undefined): {
  thinkingLevel?: PiSessionOptions["thinkingLevel"];
} {
  if (effort === undefined || !PI_THINKING_LEVELS.includes(effort)) return {};
  return { thinkingLevel: effort as PiSessionOptions["thinkingLevel"] };
}

/** What a missing pinned model says, before the diagnostic is redacted. */
export function unknownModelMessage(model: string): string {
  return `Pi model '${model}' was not found in the model catalogue`;
}

/** One spawn's environment, as much of it as this module needs. */
export interface SpawnEnvironment {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Add the child depth to one spawn's own environment.
 *
 * A function of the depth rather than a closure inside the options builder, so
 * that "the depth reaches the spawn" is a thing a test can call. What it must
 * *not* do is touch `process.env`: the parent is a long-lived Pi process, and
 * a mutated environment would outlive the Run that wanted it and follow every
 * later spawn out.
 */
export function depthSpawnHook(
  childDepth: number,
): <T extends SpawnEnvironment>(spawn: T) => T {
  return (spawn) => ({
    ...spawn,
    env: { ...spawn.env, [DEPTH_ENV_KEY]: String(childDepth) },
  });
}

/** The catalogue entry for a reference spelled `id` or `provider/id`. */
function modelForReference(
  runtime: ModelRuntime,
  reference: string,
): PiSessionOptions["model"] {
  const separator = reference.indexOf("/");
  if (separator > 0) {
    return runtime.getModel(
      reference.slice(0, separator),
      reference.slice(separator + 1),
    );
  }
  return runtime.getModels().find((model) => model.id === reference);
}

export interface PiSessionOptionsInput {
  readonly profile: Profile;
  readonly subagent: SubagentContext;
  /** The resolved model reference, as validation accepted it. */
  readonly model?: string;
  readonly thinking?: string;
  readonly agentDir?: string;
}

/** Build the options one retained Pi session is created from. */
export async function createPiSessionOptions(
  input: PiSessionOptionsInput,
): Promise<PiSessionOptions> {
  const { profile, subagent } = input;
  const agentDir = input.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(subagent.cwd, agentDir, {
    projectTrusted: subagent.projectTrusted,
  });
  const prompt = profile.systemPrompt;
  // Extensions are disabled by the resource loader. The discriminator remains
  // a backstop around discovery so this package stays inert if Pi ever invokes
  // an explicitly supplied factory despite that policy.
  const services = await withChildResourceLoad(() =>
    createAgentSessionServices({
      cwd: subagent.cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        ...(prompt.trim().length === 0
          ? {}
          : shouldAppendSystemPrompt(profile)
            ? {
                appendSystemPromptOverride: (base: string[]) => [
                  ...base,
                  prompt,
                ],
              }
            : { systemPromptOverride: () => prompt }),
      },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: async () => subagent.projectTrusted,
      },
    }),
  );
  const model = input.model
    ? modelForReference(services.modelRuntime, input.model)
    : undefined;
  if (input.model && !model) throw new Error(unknownModelMessage(input.model));

  const tools = parseTools(profile);
  const bash = createBashToolDefinition(subagent.cwd, {
    commandPrefix: services.settingsManager.getShellCommandPrefix(),
    shellPath: services.settingsManager.getShellPath(),
    spawnHook: depthSpawnHook(subagent.childDepth),
  });

  return {
    cwd: subagent.cwd,
    agentDir,
    modelRuntime: services.modelRuntime,
    settingsManager: services.settingsManager,
    resourceLoader: services.resourceLoader,
    sessionManager: SessionManager.inMemory(subagent.cwd),
    model,
    ...thinkingLevel(input.thinking),
    ...(tools === undefined ? {} : { tools }),
    excludeTools: [...PI_ORCHESTRATION_TOOLS],
    // The same local Bash implementation Pi would have used, plus a per-spawn
    // depth environment.
    customTools: [bash] as unknown as NonNullable<
      PiSessionOptions["customTools"]
    >,
  };
}
