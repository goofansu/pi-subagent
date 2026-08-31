/** The retained Pi SDK Conversation and its neutral Fact translation. */

import * as fs from "node:fs";
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
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
import { parseTools, shouldAppendSystemPrompt } from "../contract.ts";
import { confineProviderDiagnostic } from "../provider-diagnostic.ts";

const PI_ORCHESTRATION_TOOLS = [
  "agent_start",
  "agent_resume",
  "agent_wait",
  "agent_result",
  "agent_cancel",
  "agent_steer",
] as const;
const PI_EXTENSION_SHUTDOWN_TIMEOUT_MS = 1_000;

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

const MISSING_TERMINAL_EVENT_ERROR =
  "Pi managed session completed without a valid terminal agent_end event containing a messages array.";

/** Translate retained Pi SDK messages into neutral Facts. */
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
      ? {
          errorMessage: confineProviderDiagnostic(
            value.errorMessage,
            "Pi provider message failed",
          ),
        }
      : {}),
  };
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

async function withBoundedCleanup(
  promise: Promise<unknown>,
  timeoutMs = PI_EXTENSION_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    promise.catch(() => undefined).then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return completed;
}

interface PendingPiSessionCleanup {
  readonly settled: Promise<void>;
}

async function stopPiSession(
  session: PiSession,
): Promise<PendingPiSessionCleanup | undefined> {
  let abortWork: Promise<unknown>;
  try {
    abortWork = Promise.resolve(session.abort());
  } catch {
    abortWork = Promise.resolve();
  }
  let idleWork: Promise<unknown>;
  try {
    idleWork = Promise.resolve(session.waitForIdle());
  } catch {
    idleWork = Promise.resolve();
  }
  const settled = Promise.allSettled([abortWork, idleWork]).then((outcomes) =>
    outcomes[1]?.status === "fulfilled"
      ? undefined
      : new Promise<void>(() => {}),
  );
  return (await withBoundedCleanup(settled)) ? undefined : { settled };
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
  let pendingSteeringCleanup: Promise<void> | undefined;
  let pendingNativeCleanup: Promise<void> | undefined;

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
          await stopPiSession(created);
          throw new Error("Pi session initialization was cancelled");
        }
        await created.bindExtensions({ mode: "print" });
        if (closed || signal?.aborted) {
          created.clearQueue();
          await stopPiSession(created);
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
    if (pendingSteeringCleanup || pendingNativeCleanup) {
      return {
        ending: "failed",
        errorMessage:
          "Pi session cleanup is still waiting for native steering to finish",
      };
    }
    let sdk: PiSession;
    try {
      sdk = await initialize(run.signal);
    } catch (error) {
      if (closed || run.signal?.aborted) return { ending: "cancelled" };
      return {
        ending: "failed",
        errorMessage: confineProviderDiagnostic(
          error,
          "Pi initialization failed",
        ),
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
    let releaseCancellation = () => {};
    const cancellationFinished = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });

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
      let steeringSettled = false;
      const lateCleanup = steeringAtCancellation.finally(() => {
        steeringSettled = true;
        clearNativeQueue();
        if (pendingSteeringCleanup === lateCleanup) {
          pendingSteeringCleanup = undefined;
        }
      });
      cancellationWork = (async () => {
        // Abort first so uncooperative native work cannot indefinitely
        // prevent cancellation or Session shutdown. A still-pending steer
        // blocks resume until its late completion has been cleared.
        const pendingNative = await stopPiSession(sdk);
        if (pendingNative) {
          const lateNativeCleanup = pendingNative.settled.finally(() => {
            clearNativeQueue();
            if (pendingNativeCleanup === lateNativeCleanup) {
              pendingNativeCleanup = undefined;
            }
          });
          pendingNativeCleanup = lateNativeCleanup;
        }
        clearNativeQueue();
        if (!steeringSettled) pendingSteeringCleanup = lateCleanup;
      })().finally(releaseCancellation);
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
          const diagnostic = confineProviderDiagnostic(
            error,
            "Pi steering was not delivered",
          );
          if (diagnostic) run.report.stderr(`${diagnostic}\n`);
        }
      });
    }, discardQueued);

    try {
      let promptError: unknown;
      const promptOutcome = await Promise.race([
        Promise.resolve()
          .then(() => sdk.prompt(task.prompt))
          .then(
            () => ({ outcome: "settled" as const }),
            (error) => ({ outcome: "failed" as const, error }),
          ),
        cancellationFinished.then(() => ({ outcome: "cancelled" as const })),
      ]);
      if (promptOutcome.outcome === "failed") {
        promptError = promptOutcome.error;
      }

      if (cancelled || run.signal?.aborted || closed) {
        await stopCurrentWork();
      } else {
        // Controls admitted before Pi's idle boundary belong to this Run. Keep
        // draining until no synchronous admission changed the tail around an
        // await; then make completion non-reopenable in the same stack.
        while (true) {
          const draining = deliveryTail;
          const cancelledWhileDraining = await Promise.race([
            draining.then(() => false),
            cancellationFinished.then(() => true),
          ]);
          if (cancelledWhileDraining) break;
          const cancelledWhileWaitingForIdle = await Promise.race([
            Promise.resolve()
              .then(() => sdk.waitForIdle())
              .then(() => false),
            cancellationFinished.then(() => true),
          ]);
          if (cancelledWhileWaitingForIdle) break;
          if (draining === deliveryTail && queuedControls.length === 0) break;
        }
      }
      accepting = false;

      if (terminalMessages) {
        run.report.transcript(
          terminalMessages
            .map((message) => piFact(message))
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
          errorMessage: confineProviderDiagnostic(
            promptError,
            "Pi prompt failed",
          ),
        };
      }
      return { ending: "failed", errorMessage: MISSING_TERMINAL_EVENT_ERROR };
    } catch (error) {
      if (cancelled || run.signal?.aborted || closed) {
        return { ending: "cancelled" };
      }
      return {
        ending: "failed",
        errorMessage: confineProviderDiagnostic(error, "Pi execution failed"),
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
          await withBoundedCleanup(cancelActive());
        } else if (session) {
          try {
            session.clearQueue();
          } catch {
            // Continue through abort and bounded shutdown.
          }
          await stopPiSession(session);
        }
        await withBoundedCleanup(
          Promise.all([
            active?.catch(() => undefined),
            pendingCreation?.catch(() => undefined),
          ]),
        );
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
