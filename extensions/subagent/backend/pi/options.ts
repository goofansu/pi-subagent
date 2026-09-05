/**
 * The fixed native policy one retained Pi session is constructed with.
 *
 * Ported from v1, decision for decision, because every one of them was
 * arrived at by running children for real:
 *
 * - **Trust is forwarded, never re-derived.** A child runs non-interactively,
 *   so it can neither prompt for trust nor see a session-only decision; the
 *   delegating Session's answer for this working directory is the answer.
 * - **This package is removed from the child's extension list.** A child that
 *   loaded this extension would register the delegation tools and try to
 *   delegate again, and the depth guard would be the only thing standing in
 *   the way. Filtering by *package identity* rather than by directory is what
 *   makes that cover both the v1 and the v2 entry points at once — they ship
 *   from one package — and what keeps it true if either directory is renamed.
 * - **The reload runs inside the child-load discriminator.** Pi initializes
 *   extension factories while the loader discovers resources and applies the
 *   override only afterwards, so the flag is what keeps the entry point inert
 *   during that window.
 * - **The orchestration tools are excluded.** Belt and braces with the
 *   extension filter: even a child that somehow reached the registrations
 *   cannot call them.
 * - **Bash carries the depth.** The spawn hook adds the depth variable to each
 *   spawn's own environment. `process.env` is never mutated, because the
 *   parent is a long-lived process and a mutated environment would outlive the
 *   Run that wanted it.
 *
 * Nothing here performs provider I/O. Building the options reads the agent
 * directory's auth and model files and discovers resources; the model is
 * resolved against the catalogue those files describe, and a model that is not
 * there fails the open rather than the first Run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  type LoadExtensionsResult,
  ModelRuntime,
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

/**
 * The package identity a file belongs to, by walking up to its manifest.
 *
 * Identity rather than path, because the two extension directories this
 * package ships are one package and a filter written against either path
 * alone would miss the other.
 */
export function packageNameForPath(filePath: string): string | undefined {
  let directory = path.dirname(filePath);
  try {
    if (fs.statSync(filePath).isDirectory()) directory = filePath;
  } catch {
    // A loader entry may name a path that disappeared after it was loaded.
  }
  for (;;) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (typeof manifest.name === "string") return manifest.name;
    } catch {
      // Keep walking to the filesystem root until an identity is found.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** This package's own name, read from its manifest rather than hard-coded. */
export const OWN_PACKAGE_NAME =
  packageNameForPath(fileURLToPath(import.meta.url)) ?? "pi-subagent";

/**
 * Drop every extension this package ships before a child binds.
 *
 * Both directories go, because both belong to this package: a child that
 * loaded the v2 entry would register its own delegation tools, and a child
 * that loaded the v1 entry would register the other set.
 */
export function filterChildExtensions(
  base: LoadExtensionsResult,
  ownPackage: string = OWN_PACKAGE_NAME,
): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter(
      (extension) => packageNameForPath(extension.resolvedPath) !== ownPackage,
    ),
  };
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
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const model = input.model
    ? modelForReference(modelRuntime, input.model)
    : undefined;
  if (input.model && !model) throw new Error(unknownModelMessage(input.model));

  const prompt = profile.systemPrompt;
  const resourceLoader = new DefaultResourceLoader({
    cwd: subagent.cwd,
    agentDir,
    settingsManager,
    extensionsOverride: (base: LoadExtensionsResult) =>
      filterChildExtensions(base),
    ...(prompt.trim().length === 0
      ? {}
      : shouldAppendSystemPrompt(profile)
        ? {
            appendSystemPromptOverride: (base: string[]) => [...base, prompt],
          }
        : { systemPromptOverride: () => prompt }),
  });
  // See `child-load.ts`: the override is applied only after the factories have
  // already been initialized, so the discriminator is what covers the gap.
  await withChildResourceLoad(() =>
    resourceLoader.reload({
      resolveProjectTrust: async () => subagent.projectTrusted,
    }),
  );

  const tools = parseTools(profile);
  const bash = createBashToolDefinition(subagent.cwd, {
    commandPrefix: settingsManager.getShellCommandPrefix(),
    shellPath: settingsManager.getShellPath(),
    spawnHook: depthSpawnHook(subagent.childDepth),
  });

  return {
    cwd: subagent.cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
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
