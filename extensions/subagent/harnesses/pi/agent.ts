/**
 * The pi harness adapter — resolves the pi invocation and translates its
 * NDJSON event stream into neutral facts. Process lifetime belongs to the
 * shared child-process source; this module keeps pi policy and wire knowledge.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  getPackageDir,
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  type ChildProcessSpawn,
  processJsonSource,
} from "../../child-process.ts";
import { runOneShot, type Translation } from "../../one-shot.ts";
import { withPiChildExtensionLoad } from "../../pi-child-extension-load.ts";
import type {
  Fact,
  FactPart,
  RunControl,
  RunEnding,
  SubagentContext,
  SubagentRun,
  SubagentTask,
} from "../../run.ts";
import type { AgentConfig } from "../../types.ts";
import { parseTools, shouldAppendSystemPrompt } from "../contract.ts";

const PI_ORCHESTRATION_TOOLS = [
  "agent_start",
  "agent_resume",
  "agent_wait",
  "agent_result",
  "agent_cancel",
  "agent_steer",
] as const;
const PI_EXTENSION_SHUTDOWN_TIMEOUT_MS = 1_000;
const PI_STEERING_DIAGNOSTIC_LIMIT = 2_048;

export type PiSession = Pick<
  AgentSession,
  | "prompt"
  | "steer"
  | "subscribe"
  | "bindExtensions"
  | "abort"
  | "waitForIdle"
  | "clearQueue"
  | "dispose"
  | "messages"
  | "isIdle"
> & {
  extensionRunner: {
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
};

export type PiSessionFactory = (
  options: CreateAgentSessionOptions,
) => Promise<{ session: PiSession }>;

export type PiSessionOptionsFactory = (
  context: SubagentContext,
  resolvedModel?: string,
  resolvedThinking?: string,
  agentDir?: string,
  signal?: AbortSignal,
) => Promise<CreateAgentSessionOptions>;

export interface PiManagedAdapter {
  prepareRun(task: SubagentTask): {
    supportedControls: readonly ["steer"];
    execute(run: SubagentRun): Promise<RunEnding>;
  };
  close(): Promise<void>;
}

function defaultPiSessionFactory(
  options: CreateAgentSessionOptions,
): Promise<{ session: PiSession }> {
  return createAgentSession(options);
}

function packageNameForPath(filePath: string): string | undefined {
  let directory = path.dirname(filePath);
  try {
    if (fs.statSync(filePath).isDirectory()) directory = filePath;
  } catch {
    // A loader diagnostic may refer to a path that disappeared after loading.
  }
  while (true) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (typeof manifest.name === "string") return manifest.name;
    } catch {
      // Walk to the filesystem root until a package identity is found.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

const PI_SUBAGENT_PACKAGE_NAME =
  packageNameForPath(fileURLToPath(import.meta.url)) ?? "pi-subagent";

/** Remove this package by package identity before an in-process child binds. */
export function filterPiChildExtensions(
  base: LoadExtensionsResult,
): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter(
      (extension) =>
        packageNameForPath(extension.resolvedPath) !== PI_SUBAGENT_PACKAGE_NAME,
    ),
  };
}

function modelForReference(
  runtime: ModelRuntime,
  reference: string,
): CreateAgentSessionOptions["model"] {
  const separator = reference.indexOf("/");
  if (separator > 0) {
    return runtime.getModel(
      reference.slice(0, separator),
      reference.slice(separator + 1),
    );
  }
  return runtime.getModels().find((model) => model.id === reference);
}

/** Build the fixed SDK policy for one retained Pi Conversation. */
export async function createPiSessionOptions(
  context: SubagentContext,
  resolvedModel?: string,
  resolvedThinking?: string,
  agentDir = getAgentDir(),
  signal?: AbortSignal,
): Promise<CreateAgentSessionOptions> {
  const settingsManager = SettingsManager.create(context.cwd, agentDir, {
    projectTrusted: context.projectTrusted,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    ...(signal ? { signal } : {}),
  });
  const model = resolvedModel
    ? modelForReference(modelRuntime, resolvedModel)
    : undefined;
  if (resolvedModel && !model) {
    throw new Error(
      `Pi model '${resolvedModel}' was not found in the model catalogue`,
    );
  }

  const configuredPrompt = context.config.systemPrompt;
  const resourceLoader = new DefaultResourceLoader({
    cwd: context.cwd,
    agentDir,
    settingsManager,
    extensionsOverride: filterPiChildExtensions,
    ...(configuredPrompt.trim().length === 0
      ? {}
      : shouldAppendSystemPrompt(context.config, "profile")
        ? {
            appendSystemPromptOverride: (base: string[]) => [
              ...base,
              configuredPrompt,
            ],
          }
        : { systemPromptOverride: () => configuredPrompt }),
  });
  // Pi initializes extension factories while reload() discovers resources;
  // extensionsOverride is applied only afterward. Scope the discriminator to
  // this asynchronous child-owned load chain so parent reloads can reattach.
  await withPiChildExtensionLoad(() =>
    resourceLoader.reload({
      resolveProjectTrust: async () => context.projectTrusted,
    }),
  );

  const tools = parseTools(context.config, "profile");
  const bash = createBashToolDefinition(context.cwd, {
    commandPrefix: settingsManager.getShellCommandPrefix(),
    shellPath: settingsManager.getShellPath(),
    spawnHook: (spawn) => ({
      ...spawn,
      env: {
        ...spawn.env,
        PI_SUBAGENT_DEPTH: String(context.childDepth),
      },
    }),
  });

  return {
    cwd: context.cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(context.cwd),
    model,
    thinkingLevel:
      resolvedThinking as CreateAgentSessionOptions["thinkingLevel"],
    ...(tools === undefined ? {} : { tools }),
    excludeTools: [...PI_ORCHESTRATION_TOOLS],
    // Replace the normal Bash definition with the same local implementation
    // plus a per-spawn depth environment. process.env is never mutated.
    customTools: [bash] as unknown as NonNullable<
      CreateAgentSessionOptions["customTools"]
    >,
  };
}

export interface PiInvocationRuntime {
  execPath: string;
  argv: readonly string[];
  packageDir: string;
  isPiCli: boolean;
}

const PI_CLI_SCRIPT_PATHS = [
  ["dist", "cli.js"],
  ["dist", "bun", "cli.js"],
  ["src", "cli.ts"],
  ["src", "bun", "cli.ts"],
] as const;

const MISSING_AGENT_END_ERROR =
  "Child pi exited with code 0 without a valid terminal agent_end event (with a messages array).";

function executableName(executablePath: string): string {
  // Splitting both separators also keeps the resolver testable across platforms.
  return executablePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function isGenericScriptRuntime(executablePath: string): boolean {
  return /^(?:node|nodejs|bun)(?:\.exe)?$/.test(executableName(executablePath));
}

function isNativePiRuntime(executablePath: string): boolean {
  return /^pi(?:\.exe)?$/.test(executableName(executablePath));
}

function resolveExistingPath(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return fs.realpathSync(filePath);
  } catch {
    // A path can disappear or become inaccessible between exists and realpath.
    return undefined;
  }
}

function isPiCliScript(scriptPath: string, packageDir: string): boolean {
  const resolvedScript = resolveExistingPath(scriptPath);
  if (!resolvedScript) return false;

  // The CLI entrypoint must belong to the same Pi package that loaded this
  // extension. This prevents SDK embedding hosts from being mistaken for Pi.
  return PI_CLI_SCRIPT_PATHS.some((segments) => {
    const candidate = resolveExistingPath(path.join(packageDir, ...segments));
    return candidate === resolvedScript;
  });
}

/**
 * Resolve the active Pi installation without constructing a shell command.
 *
 * The CLI's process marker distinguishes it from SDK hosts. Node/Bun script
 * launches are then reused only when argv[1] resolves to a known CLI entrypoint
 * in the Pi package that loaded the extension. Standalone releases are reused
 * only when the active executable is named `pi`; all ambiguous SDK embedding
 * hosts fall back to normal PATH resolution.
 */
export function getPiInvocation(
  args: string[],
  runtime: PiInvocationRuntime = {
    execPath: process.execPath,
    argv: process.argv,
    packageDir: getPackageDir(),
    isPiCli: process.env.PI_CODING_AGENT === "true",
  },
): { command: string; args: string[] } {
  if (!runtime.isPiCli) return { command: "pi", args };

  if (isNativePiRuntime(runtime.execPath)) {
    return { command: runtime.execPath, args };
  }

  const scriptPath = runtime.argv[1];
  if (
    scriptPath &&
    isGenericScriptRuntime(runtime.execPath) &&
    isPiCliScript(scriptPath, runtime.packageDir)
  ) {
    return { command: runtime.execPath, args: [scriptPath, ...args] };
  }

  return { command: "pi", args };
}

export function buildPiArgs(
  config: AgentConfig,
  resolvedModel: string | undefined,
  systemPromptPath: string | undefined,
  thinkingLevel?: string,
  projectTrusted = false,
): string[] {
  // The child runs non-interactively, so it cannot inherit a session-only
  // decision by prompting. Forward the parent's resolved trust explicitly;
  // otherwise saved or default trust could disagree with the parent session,
  // in either direction.
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    projectTrusted ? "--approve" : "--no-approve",
  ];
  if (resolvedModel) args.push("--model", resolvedModel);
  // pi takes the thinking level as its own flag, so nothing has to be spliced
  // into the model string — which is what made a colon ambiguous before.
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  const tools = parseTools(config, "profile");
  if (tools !== undefined) args.push("--tools", tools.join(","));
  if (systemPromptPath) {
    args.push(
      shouldAppendSystemPrompt(config, "profile")
        ? "--append-system-prompt"
        : "--system-prompt",
      systemPromptPath,
    );
  }
  // Prompt is passed via stdin, not as a CLI arg, to avoid process-listing
  // exposure of sensitive content and OS argument-length limits (E2BIG).
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function factPart(value: unknown): FactPart | undefined {
  if (typeof value === "string") return { type: "text", text: value };
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "toolCall" && typeof value.name === "string") {
    return {
      type: "tool_call",
      name: value.name,
      ...(isRecord(value.arguments) ? { arguments: value.arguments } : {}),
    };
  }
  return undefined;
}

function piFact(value: unknown): Fact | undefined {
  if (!isRecord(value)) return undefined;
  const wireRole = value.role;
  const role = wireRole === "toolResult" ? "tool" : wireRole;
  if (role !== "user" && role !== "assistant" && role !== "tool")
    return undefined;
  if (typeof value.content !== "string" && !Array.isArray(value.content)) {
    return undefined;
  }
  const rawParts = Array.isArray(value.content)
    ? value.content
    : [value.content];
  const parts = rawParts
    .map(factPart)
    .filter((part): part is FactPart => part !== undefined);
  // Thinking and provider-specific content blocks do not cross the harness
  // seam, but their message metadata still does. An empty parts array is a
  // meaningful fact when it carries usage, a stop reason, or an error.
  const rawUsage = isRecord(value.usage) ? value.usage : undefined;
  const rawCost =
    rawUsage && isRecord(rawUsage.cost) ? rawUsage.cost : undefined;
  const usage = rawUsage
    ? {
        input: typeof rawUsage.input === "number" ? rawUsage.input : undefined,
        output:
          typeof rawUsage.output === "number" ? rawUsage.output : undefined,
        cacheRead:
          typeof rawUsage.cacheRead === "number"
            ? rawUsage.cacheRead
            : undefined,
        cacheWrite:
          typeof rawUsage.cacheWrite === "number"
            ? rawUsage.cacheWrite
            : undefined,
        contextTokens:
          typeof rawUsage.totalTokens === "number"
            ? rawUsage.totalTokens
            : undefined,
        cost:
          rawCost && typeof rawCost.total === "number"
            ? rawCost.total
            : undefined,
      }
    : undefined;
  return {
    role,
    parts,
    ...(usage ? { usage } : {}),
    ...(typeof value.provider === "string" && typeof value.model === "string"
      ? { model: `${value.provider}/${value.model}` }
      : {}),
    ...(typeof value.stopReason === "string"
      ? { stopReason: value.stopReason }
      : {}),
    ...(typeof value.errorMessage === "string"
      ? { errorMessage: value.errorMessage }
      : {}),
  };
}

function isValidAgentEndEvent(
  event: Record<string, unknown>,
): event is Record<string, unknown> & { messages: unknown[] } {
  return event.type === "agent_end" && Array.isArray(event.messages);
}

/** Translate parsed pi wire events into domain facts at the adapter edge. */
export function translatePiJsonEvent(
  event: Record<string, unknown>,
): Translation | undefined {
  if (
    (event.type === "message_end" || event.type === "tool_result_end") &&
    event.message
  ) {
    const fact = piFact(event.message);
    return fact ? { facts: [fact] } : undefined;
  }
  if (isValidAgentEndEvent(event)) {
    return {
      transcript: event.messages
        .map(piFact)
        .filter((fact): fact is Fact => fact !== undefined),
      terminal: true,
    };
  }
  return undefined;
}

async function writePromptToTempFile(
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

export async function runPiAgent(
  run: SubagentRun,
  {
    context,
    task,
    resolvedModel,
    resolvedThinking,
    spawn,
    killEscalationMs,
  }: {
    context: SubagentContext;
    task: SubagentTask;
    resolvedModel?: string;
    resolvedThinking?: string;
    spawn?: ChildProcessSpawn;
    killEscalationMs?: number;
  },
): Promise<RunEnding> {
  const { config } = context;
  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

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
      resolvedThinking,
      context.projectTrusted,
    );
    const invocation = getPiInvocation(args);
    return await runOneShot({
      source: processJsonSource({
        command: invocation.command,
        args: invocation.args,
        cwd: context.cwd,
        childDepth: context.childDepth,
        prompt: task.prompt,
        childName: "pi",
        ...(spawn ? { spawn } : {}),
        ...(killEscalationMs === undefined ? {} : { killEscalationMs }),
      }),
      translate: translatePiJsonEvent,
      report: run.report,
      signal: run.signal,
      missingAnswerMessage: MISSING_AGENT_END_ERROR,
    });
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

function messageIdentity(message: unknown): string {
  if (!isRecord(message)) return JSON.stringify(message);
  return JSON.stringify({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  });
}

function currentRunMessages(
  messages: readonly unknown[],
  baseline: readonly unknown[],
): unknown[] {
  // Compare a counted semantic snapshot instead of slicing by baseline length:
  // the retained SDK may rebuild message objects while retrying or compacting
  // its Conversation. Counts still preserve genuinely repeated, identical
  // messages added by the current Run.
  const old = new Map<string, number>();
  for (const message of baseline) {
    const key = messageIdentity(message);
    old.set(key, (old.get(key) ?? 0) + 1);
  }
  return messages.filter((message) => {
    const key = messageIdentity(message);
    const remaining = old.get(key) ?? 0;
    if (remaining === 0) return true;
    old.set(key, remaining - 1);
    return false;
  });
}

function isPiUserText(message: unknown, text: string): boolean {
  if (!isRecord(message) || message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return content === text;
  if (!Array.isArray(content)) return false;
  return (
    content
      .filter((part) => isRecord(part) && part.type === "text")
      .map((part) => (part as Record<string, unknown>).text)
      .join("") === text
  );
}

function withoutInitialGoal(messages: unknown[], prompt: string): unknown[] {
  let omitted = false;
  return messages.filter((message) => {
    if (!omitted && isPiUserText(message, prompt)) {
      omitted = true;
      return false;
    }
    return true;
  });
}

function boundedPiDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[redacted]")
    .trim();
  return normalized.slice(0, PI_STEERING_DIAGNOSTIC_LIMIT);
}

async function withBoundedCleanup(
  promise: Promise<unknown>,
  timeoutMs = PI_EXTENSION_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

async function disposePiSession(session: PiSession): Promise<void> {
  await withBoundedCleanup(
    Promise.resolve().then(() =>
      session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      }),
    ),
  );
  try {
    session.dispose();
  } catch {
    // Cleanup cannot alter an already-settled Run.
  }
}

interface PiControlRecord {
  readonly control: RunControl;
  discarded: boolean;
}

/**
 * Create one retained SDK Conversation for a prepared Pi Subagent.
 *
 * Provider objects, subscriptions, and native steering stay inside this
 * adapter. Every execution receives only its Run-local reporter, signal, and
 * neutral Control source.
 */
export function createPiManagedAdapter(
  context: SubagentContext,
  options: {
    resolvedModel?: string;
    resolvedThinking?: string;
    sessionFactory?: PiSessionFactory;
    sessionOptionsFactory?: PiSessionOptionsFactory;
    agentDir?: string;
  } = {},
): PiManagedAdapter {
  const sessionFactory = options.sessionFactory ?? defaultPiSessionFactory;
  const sessionOptionsFactory =
    options.sessionOptionsFactory ?? createPiSessionOptions;
  let session: PiSession | undefined;
  let creating: Promise<PiSession> | undefined;
  let active: Promise<RunEnding> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let disposed = false;
  let cancelActive: (() => Promise<void>) | undefined;

  const initialize = (signal?: AbortSignal): Promise<PiSession> => {
    if (session) return Promise.resolve(session);
    if (creating) return creating;
    creating = (async () => {
      const sdkOptions = await sessionOptionsFactory(
        context,
        options.resolvedModel,
        options.resolvedThinking,
        options.agentDir,
        signal,
      );
      if (closed || signal?.aborted) {
        throw new Error("Pi session initialization was cancelled");
      }
      const created = (await sessionFactory(sdkOptions)).session;
      try {
        if (closed || signal?.aborted) {
          created.clearQueue();
          await created.abort().catch(() => undefined);
          await created.waitForIdle().catch(() => undefined);
          throw new Error("Pi session initialization was cancelled");
        }
        await created.bindExtensions({ mode: "print" });
        if (closed || signal?.aborted) {
          created.clearQueue();
          await created.abort().catch(() => undefined);
          await created.waitForIdle().catch(() => undefined);
          throw new Error("Pi session initialization was cancelled");
        }
        session = created;
        return created;
      } catch (error) {
        await disposePiSession(created);
        throw error;
      }
    })().finally(() => {
      creating = undefined;
    });
    return creating;
  };

  const executeRun = async (
    task: SubagentTask,
    run: SubagentRun,
  ): Promise<RunEnding> => {
    if (closed || run.signal?.aborted) return { ending: "cancelled" };
    let sdk: PiSession;
    try {
      sdk = await initialize(run.signal);
    } catch (error) {
      if (closed || run.signal?.aborted) return { ending: "cancelled" };
      return {
        ending: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    if (closed || run.signal?.aborted) return { ending: "cancelled" };

    const baseline = [...sdk.messages];
    // Pi may surface the same message object through duplicate representations,
    // but equal content is not event identity: two consumed Controls can carry
    // identical text. Reference identity drops only the former.
    const seenEventMessages = new WeakSet<object>();
    let terminalMessages: unknown[] | undefined;
    let accepting = true;
    let cancelled = false;
    let initialGoalOmitted = false;
    const queuedControls: PiControlRecord[] = [];
    let deliveryTail = Promise.resolve();
    let cancellationWork: Promise<void> | undefined;

    const reportEvent = (event: AgentSessionEvent): void => {
      if (!accepting) return;
      const wire = event as unknown as Record<string, unknown>;
      if (wire.type === "message_end" && wire.message) {
        if (!initialGoalOmitted && isPiUserText(wire.message, task.prompt)) {
          initialGoalOmitted = true;
          return;
        }
        if (typeof wire.message === "object" && wire.message !== null) {
          if (seenEventMessages.has(wire.message)) return;
          seenEventMessages.add(wire.message);
        }
        const fact = piFact(wire.message);
        if (fact) run.report.message(fact);
        return;
      }
      if (
        wire.type === "agent_end" &&
        wire.willRetry !== true &&
        Array.isArray(wire.messages)
      ) {
        terminalMessages = withoutInitialGoal(
          currentRunMessages(wire.messages, baseline),
          task.prompt,
        );
      }
    };
    const unsubscribeEvents = sdk.subscribe(reportEvent);

    const discardQueued = (): void => {
      for (const record of queuedControls) record.discarded = true;
      queuedControls.length = 0;
    };
    const clearNativeQueue = (): void => {
      try {
        sdk.clearQueue();
      } catch {
        // Native abort remains authoritative when queue cleanup fails.
      }
    };
    const stopCurrentWork = (): Promise<void> => {
      if (cancellationWork) return cancellationWork;
      cancelled = true;
      accepting = false;
      discardQueued();
      clearNativeQueue();
      const steeringAtCancellation = deliveryTail;
      cancellationWork = (async () => {
        // A Control that entered first may already be inside sdk.steer(). Join
        // it, then clear again so its late native enqueue cannot cross the
        // retained Conversation's cancellation/resume boundary.
        await steeringAtCancellation.catch(() => undefined);
        clearNativeQueue();
        await sdk.abort().catch(() => undefined);
        await sdk.waitForIdle().catch(() => undefined);
      })();
      return cancellationWork;
    };
    const onAbort = (): void => {
      void stopCurrentWork();
    };
    cancelActive = stopCurrentWork;
    run.signal?.addEventListener("abort", onAbort, { once: true });

    const unsubscribeControls = run.controls.subscribe((admission) => {
      // Taking the complete admission releases core's bounded budget. Native
      // delivery and provider consumption remain separate facts.
      admission.acknowledge();
      const record: PiControlRecord = {
        control: admission.control,
        discarded: !accepting || cancelled,
      };
      if (record.discarded) return;
      queuedControls.push(record);
      deliveryTail = deliveryTail.then(async () => {
        const index = queuedControls.indexOf(record);
        if (index >= 0) queuedControls.splice(index, 1);
        if (record.discarded || !accepting || cancelled) return;
        try {
          await sdk.steer(record.control.text);
        } catch (error) {
          // Admission and an otherwise valid answer remain honest even when
          // native steering rejects. Keep only a bounded adapter diagnostic.
          const diagnostic = boundedPiDiagnostic(error);
          if (diagnostic)
            run.report.stderr(`Pi steering was not delivered: ${diagnostic}\n`);
        }
      });
    }, discardQueued);

    try {
      let promptError: unknown;
      try {
        await sdk.prompt(task.prompt);
      } catch (error) {
        promptError = error;
      }

      if (cancelled || run.signal?.aborted || closed) {
        await stopCurrentWork();
      } else {
        // Controls admitted before Pi's idle boundary belong to this Run. Keep
        // draining until no synchronous admission changed the tail around an
        // await; then make completion non-reopenable in the same stack.
        while (true) {
          const draining = deliveryTail;
          await draining;
          await sdk.waitForIdle();
          if (draining === deliveryTail && queuedControls.length === 0) break;
        }
      }
      accepting = false;

      if (terminalMessages) {
        run.report.transcript(
          terminalMessages
            .map(piFact)
            .filter((fact): fact is Fact => fact !== undefined),
        );
        // A non-retrying terminal snapshot observed before cancellation is
        // authoritative even when abort is what releases prompt(). Native
        // cleanup above still completes before the Run settles.
        return { ending: "answered" };
      }
      if (cancelled || run.signal?.aborted || closed) {
        await stopCurrentWork();
        return { ending: "cancelled" };
      }
      if (promptError !== undefined) {
        return {
          ending: "failed",
          errorMessage:
            promptError instanceof Error
              ? promptError.message
              : String(promptError),
        };
      }
      return { ending: "failed", errorMessage: MISSING_AGENT_END_ERROR };
    } catch (error) {
      if (cancelled || run.signal?.aborted || closed) {
        return { ending: "cancelled" };
      }
      return {
        ending: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      accepting = false;
      discardQueued();
      unsubscribeControls();
      run.signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        await stopCurrentWork();
      }
      unsubscribeEvents();
      if (cancelActive === stopCurrentWork) cancelActive = undefined;
    }
  };

  return {
    prepareRun(task) {
      return {
        supportedControls: ["steer"],
        execute(run) {
          if (active) {
            return Promise.resolve({
              ending: "failed",
              errorMessage: "Pi adapter already has an active Run",
            });
          }
          const execution = executeRun(task, run);
          active = execution.finally(() => {
            active = undefined;
          });
          return active;
        },
      };
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        const pendingCreation = creating;
        if (cancelActive) {
          await cancelActive().catch(() => undefined);
        } else if (session) {
          try {
            session.clearQueue();
          } catch {
            // Continue through abort and bounded shutdown.
          }
          await session.abort().catch(() => undefined);
        }
        await active?.catch(() => undefined);
        await pendingCreation?.catch(() => undefined);
        if (session && !disposed) {
          disposed = true;
          await disposePiSession(session);
          session = undefined;
        }
      })();
      return closePromise;
    },
  };
}
