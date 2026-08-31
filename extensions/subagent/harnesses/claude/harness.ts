import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  DEPTH_ENV_KEY,
  type Fact,
  type FactPart,
  type RunEnding,
  type SubagentContext,
  type SubagentRun,
  type SubagentTask,
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
import {
  confineProviderDiagnostic,
  createProviderDiagnosticCollector,
} from "../provider-diagnostic.ts";
import { createClaudeTurnCounter } from "./turns.ts";

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
const MISSING_CLAUDE_ANSWER =
  "Claude stream ended without a terminal result answer.";
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 512,
  low: 1_024,
  medium: 4_096,
  high: 8_192,
  xhigh: 16_384,
  max: 32_768,
};

interface ClaudeTranslation {
  facts?: Fact[];
  transcript?: Fact[];
  /** Live UI activity: absent leaves it unchanged, null clears it. */
  activity?: string | null;
  terminal?: boolean;
  errorMessage?: string;
}

export type ClaudeQuery = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;
export type ClaudeQueryLoader = () => Promise<ClaudeQuery>;

const loadClaudeQuery: ClaudeQueryLoader = async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentParts(content: unknown): FactPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: FactPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      parts.push({
        type: "tool_call",
        name: block.name,
        ...(isRecord(block.input) ? { arguments: block.input } : {}),
      });
    } else if (block.type === "tool_result") {
      const text = typeof block.content === "string" ? block.content : "";
      if (text) parts.push({ type: "text", text });
    }
  }
  return parts;
}

/** Translate one SDK wire object into domain facts; SDK objects stop here. */
function translateClaudeMessage(
  message: SDKMessage,
): ClaudeTranslation | undefined {
  const wire = message as unknown as Record<string, unknown>;
  if (wire.type === "assistant" && isRecord(wire.message)) {
    const parts = contentParts(wire.message.content);
    const model =
      typeof wire.message.model === "string" ? wire.message.model : undefined;
    // Thinking-only and empty assistant messages still carry model
    // provenance. Keep those metadata-bearing facts even when no content
    // block can cross the harness seam.
    if (parts.length === 0 && !model) return undefined;
    return {
      facts: [
        {
          role: "assistant",
          parts,
          ...(model ? { model } : {}),
        },
      ],
    };
  }
  if (wire.type === "user" && isRecord(wire.message)) {
    const content = wire.message.content;
    const isToolResult =
      Array.isArray(content) &&
      content.some((block) => isRecord(block) && block.type === "tool_result");
    const parts = contentParts(content);
    return parts.length > 0
      ? { facts: [{ role: isToolResult ? "tool" : "user", parts }] }
      : undefined;
  }
  if (
    wire.type === "system" &&
    wire.subtype === "init" &&
    typeof wire.model === "string"
  ) {
    // The SDK init message identifies the resolved main-loop model before the
    // first assistant response, including on runs that fail before answering.
    return {
      facts: [
        {
          role: "metadata",
          parts: [],
          model: wire.model,
        },
      ],
    };
  }
  if (wire.type !== "result") return undefined;

  const isError = wire.is_error === true;
  const resultParts =
    !isError && typeof wire.result === "string"
      ? contentParts(wire.result)
      : [];
  const modelUsage = isRecord(wire.modelUsage) ? wire.modelUsage : undefined;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const reportedCost =
    typeof wire.total_cost_usd === "number" ? wire.total_cost_usd : undefined;
  let cost = reportedCost ?? 0;
  // modelUsage is accounting, not provenance: it includes main-loop,
  // subagent, sidechain, and internal model calls. Even its sole entry may be
  // an auxiliary model when the configured model fails before responding.
  // Tolerate an explicit terminal model for wire compatibility even though
  // the installed SDK's result type does not currently declare the field.
  const model = typeof wire.model === "string" ? wire.model : undefined;
  if (modelUsage) {
    for (const value of Object.values(modelUsage)) {
      if (!isRecord(value)) continue;
      input += typeof value.inputTokens === "number" ? value.inputTokens : 0;
      output += typeof value.outputTokens === "number" ? value.outputTokens : 0;
      cacheRead +=
        typeof value.cacheReadInputTokens === "number"
          ? value.cacheReadInputTokens
          : 0;
      cacheWrite +=
        typeof value.cacheCreationInputTokens === "number"
          ? value.cacheCreationInputTokens
          : 0;
      if (reportedCost === undefined && typeof value.costUSD === "number")
        cost += value.costUSD;
    }
  }
  const resultErrorText =
    isError && typeof wire.result === "string" && wire.result.trim()
      ? wire.result
      : undefined;
  const listedErrorText =
    isError && Array.isArray(wire.errors) && typeof wire.errors[0] === "string"
      ? wire.errors[0]
      : undefined;
  const rawErrorMessage =
    resultErrorText ??
    listedErrorText ??
    (isError && typeof wire.subtype === "string"
      ? `Claude query reported an error (${wire.subtype})`
      : isError
        ? "Claude query reported an error"
        : undefined);
  const errorMessage =
    rawErrorMessage === undefined
      ? undefined
      : confineProviderDiagnostic(rawErrorMessage, "Claude query failed");
  return {
    facts: [
      {
        role: "assistant",
        parts: resultParts,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          cost,
        },
        ...(model ? { model } : {}),
        ...(typeof wire.stop_reason === "string"
          ? { stopReason: wire.stop_reason }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
    ],
    terminal: true,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

/**
 * Add live turn deltas to Claude's block-level stream and reconcile terminal
 * totals only when they raise the count already emitted.
 *
 * The SDK can emit several assistant events for one Messages API response —
 * one per completed content block — and sidechain responses use the same wire
 * type. A provider turn is therefore one unique root assistant message id,
 * not one assistant event.
 */
export function createClaudeTranslator(): (
  message: SDKMessage,
) => ClaudeTranslation | undefined {
  const turnCounter = createClaudeTurnCounter();
  let previousUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  return (message) => {
    const translation = translateClaudeMessage(message);
    const turnDelta = turnCounter.countFor(message);
    if (!translation) return undefined;

    const wire = message as unknown as Record<string, unknown>;
    if (wire.type === "result") {
      const accountingFact = translation.facts?.find(
        (fact) => fact.role === "assistant",
      );
      const current = accountingFact?.usage;
      if (current) {
        const reset =
          (current.input ?? 0) < previousUsage.input ||
          (current.output ?? 0) < previousUsage.output ||
          (current.cacheRead ?? 0) < previousUsage.cacheRead ||
          (current.cacheWrite ?? 0) < previousUsage.cacheWrite ||
          (current.cost ?? 0) < previousUsage.cost;
        const delta = (value: number, previous: number): number =>
          reset ? value : Math.max(0, value - previous);
        accountingFact.usage = {
          ...current,
          input: delta(current.input ?? 0, previousUsage.input),
          output: delta(current.output ?? 0, previousUsage.output),
          cacheRead: delta(current.cacheRead ?? 0, previousUsage.cacheRead),
          cacheWrite: delta(current.cacheWrite ?? 0, previousUsage.cacheWrite),
          cost: delta(current.cost ?? 0, previousUsage.cost),
        };
        previousUsage = {
          input: current.input ?? 0,
          output: current.output ?? 0,
          cacheRead: current.cacheRead ?? 0,
          cacheWrite: current.cacheWrite ?? 0,
          cost: current.cost ?? 0,
        };
      }
    }
    if (wire.type === "assistant" || wire.type === "result") {
      const accountingFact = translation.facts?.find(
        (fact) => fact.role === "assistant",
      );
      if (accountingFact) {
        accountingFact.usage = {
          ...accountingFact.usage,
          turns: turnDelta,
        };
      }
    }

    return translation;
  };
}

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

const CLAUDE_IDENTITY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAUDE_CONTINUATION_ATTACHMENT_FAILED =
  "Claude continuation attachment failed";

function claudeInputMessage(
  text: string,
  uuid: NonNullable<SDKUserMessage["uuid"]>,
  priority?: SDKUserMessage["priority"],
): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    uuid,
    ...(priority ? { priority } : {}),
  };
}

class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiter:
    | ((result: IteratorResult<SDKUserMessage>) => void)
    | undefined;
  private closed = false;

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ done: false, value: message });
    } else {
      this.queue.push(message);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.queue.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.closed)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

interface ClaudeControlRecord {
  readonly text: string;
  readonly uuid: NonNullable<SDKUserMessage["uuid"]>;
  confirmed: boolean;
  discarded: boolean;
}

function isClaudeToolResult(wire: Record<string, unknown>): boolean {
  if (wire.type !== "user" || !isRecord(wire.message)) return false;
  return (
    Array.isArray(wire.message.content) &&
    wire.message.content.some(
      (block) => isRecord(block) && block.type === "tool_result",
    )
  );
}

async function runClaudeAttempt(
  run: SubagentRun,
  task: SubagentTask,
  context: SubagentContext,
  model: string | undefined,
  effort: string | undefined,
  loadQuery: ClaudeQueryLoader,
  continuation: string | undefined,
  retainContinuation: (identity: string) => void,
  closeSignal?: AbortSignal,
): Promise<RunEnding> {
  const isAborted = (): boolean =>
    Boolean(run.signal?.aborted || closeSignal?.aborted);
  if (isAborted()) return { ending: "cancelled" };

  const input = new ClaudeInput();
  const initialUuid = globalThis.crypto.randomUUID();
  const knownInputUuids = new Set<string>([initialUuid]);
  input.push(claudeInputMessage(task.prompt, initialUuid));
  const controls: ClaudeControlRecord[] = [];
  let providerControl: ClaudeControlRecord | undefined;
  let accepting = true;
  let cancelled = false;
  let semanticComplete = false;
  let successfulResult = false;
  let stopped = false;
  let fatalEnding: RunEnding | undefined;
  let queryStream: Query | undefined;
  let attemptIdentity = continuation;
  let attachedToCurrentAttempt = continuation === undefined;
  const controller = new AbortController();
  const providerStderr = createProviderDiagnosticCollector();

  const discardControls = (): void => {
    for (const control of controls) control.discarded = true;
    controls.length = 0;
    if (providerControl && !providerControl.confirmed)
      providerControl.discarded = true;
  };
  const deliverNext = (): void => {
    if (!accepting || cancelled || semanticComplete || providerControl) return;
    const next = controls.shift();
    if (!next) return;
    providerControl = next;
    if (!input.push(claudeInputMessage(next.text, next.uuid, "later"))) {
      next.discarded = true;
      providerControl = undefined;
    }
  };
  const confirmControl = (uuid: unknown): void => {
    if (
      typeof uuid !== "string" ||
      !providerControl ||
      providerControl.uuid !== uuid ||
      providerControl.confirmed ||
      providerControl.discarded
    ) {
      return;
    }
    const confirmed = providerControl;
    confirmed.confirmed = true;
    knownInputUuids.add(confirmed.uuid);
    run.report.message({
      role: "user",
      parts: [{ type: "text", text: confirmed.text }],
    });
    providerControl = undefined;
    deliverNext();
  };
  const hasOutstandingControl = (): boolean =>
    Boolean(
      (providerControl &&
        !providerControl.confirmed &&
        !providerControl.discarded) ||
        controls.some((control) => !control.confirmed && !control.discarded),
    );

  const unsubscribeControls = run.controls.subscribe((admission) => {
    admission.acknowledge();
    if (!accepting || cancelled || semanticComplete) return;
    controls.push({
      text: admission.control.text,
      uuid: globalThis.crypto.randomUUID(),
      confirmed: false,
      discarded: false,
    });
    deliverNext();
  }, discardControls);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    accepting = false;
    input.close();
    discardControls();
    controller.abort();
    try {
      queryStream?.close();
    } catch {
      // The ordered semantic outcome remains authoritative over cleanup.
    }
  };
  const onAbort = (): void => {
    if (!semanticComplete) cancelled = true;
    stop();
  };
  run.signal?.addEventListener("abort", onAbort, { once: true });
  closeSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    let releaseLoaderAbort = (): void => {};
    const loaderAborted = new Promise<void>((resolve) => {
      releaseLoaderAbort = resolve;
    });
    const loaderAbort = (): void => releaseLoaderAbort();
    run.signal?.addEventListener("abort", loaderAbort, { once: true });
    closeSignal?.addEventListener("abort", loaderAbort, { once: true });
    const loaded = await Promise.race([
      loadQuery().then(
        (query) => ({ outcome: "loaded" as const, query }),
        (error) => ({ outcome: "failed" as const, error }),
      ),
      loaderAborted.then(() => ({ outcome: "cancelled" as const })),
    ]);
    run.signal?.removeEventListener("abort", loaderAbort);
    closeSignal?.removeEventListener("abort", loaderAbort);
    if (loaded.outcome === "cancelled") return { ending: "cancelled" };
    if (loaded.outcome === "failed") {
      return {
        ending: "failed",
        errorMessage: continuation
          ? CLAUDE_CONTINUATION_ATTACHMENT_FAILED
          : confineProviderDiagnostic(
              loaded.error,
              "Claude SDK loading failed",
            ),
      };
    }
    if (cancelled || isAborted()) return { ending: "cancelled" };

    const options = buildClaudeOptions(context, model, effort, controller);
    options.stderr = (data) => providerStderr.append(data);
    if (continuation) options.resume = continuation;
    try {
      queryStream = loaded.query({ prompt: input, options });
    } catch (error) {
      return {
        ending: "failed",
        errorMessage: continuation
          ? CLAUDE_CONTINUATION_ATTACHMENT_FAILED
          : confineProviderDiagnostic(error, "Claude query start failed"),
      };
    }

    const translate = createClaudeTranslator();
    try {
      for await (const message of queryStream) {
        if (semanticComplete) continue;
        if (cancelled) break;
        const wire = message as unknown as Record<string, unknown>;
        if (wire.isReplay === true) continue;

        const eventIdentity = wire.session_id;
        const isIdentityBoundary =
          wire.type === "result" ||
          (wire.type === "system" && wire.subtype === "init");
        if (continuation && !attachedToCurrentAttempt && !isIdentityBoundary) {
          // A resumed Query can replay prior user, assistant, and system
          // history before its current attachment boundary. None of it is a
          // Fact or accounting input for this new managed Run.
          continue;
        }
        if (isIdentityBoundary && eventIdentity === undefined) {
          fatalEnding = {
            ending: "failed",
            errorMessage: continuation
              ? CLAUDE_CONTINUATION_ATTACHMENT_FAILED
              : "Claude query returned an invalid conversation identity",
          };
          stop();
          break;
        }
        if (eventIdentity !== undefined) {
          if (
            typeof eventIdentity !== "string" ||
            !CLAUDE_IDENTITY.test(eventIdentity) ||
            (attemptIdentity !== undefined && eventIdentity !== attemptIdentity)
          ) {
            fatalEnding = {
              ending: "failed",
              errorMessage: continuation
                ? CLAUDE_CONTINUATION_ATTACHMENT_FAILED
                : "Claude query returned an invalid conversation identity",
            };
            stop();
            break;
          }
        }
        if (isIdentityBoundary && typeof eventIdentity === "string") {
          attemptIdentity ??= eventIdentity;
          attachedToCurrentAttempt = true;
          retainContinuation(eventIdentity);
        }

        if (wire.type === "user") {
          confirmControl(wire.uuid);
          if (!isClaudeToolResult(wire)) continue;
        }
        if (wire.type === "result") confirmControl(wire.user_message_uuid);

        const translation = translate(message);
        for (const fact of translation?.facts ?? []) run.report.message(fact);

        if (wire.type !== "result") continue;
        if (wire.is_error === true || translation?.errorMessage) {
          fatalEnding = {
            ending: "failed",
            errorMessage:
              translation?.errorMessage ?? "Claude query reported an error",
          };
          stop();
          break;
        }
        successfulResult = true;
        if (hasOutstandingControl()) {
          if (
            typeof wire.user_message_uuid !== "string" ||
            !knownInputUuids.has(wire.user_message_uuid)
          ) {
            // Without a correlation to an input this Attempt owns, the valid
            // Result cannot prove that an outstanding Control belongs to a
            // later provider Turn. Preserve the answer without fabricating a
            // user Fact or waiting forever on a Query kept open for input.
            discardControls();
          }
        }
        if (hasOutstandingControl()) {
          // This provider Result is an adapter-local Turn boundary. The
          // managed Run stays active until earlier guidance is consumed.
          deliverNext();
          continue;
        }
        semanticComplete = true;
        accepting = false;
        input.close();
      }
    } catch (error) {
      if (!semanticComplete && !cancelled) {
        fatalEnding = {
          ending: "failed",
          errorMessage: continuation
            ? CLAUDE_CONTINUATION_ATTACHMENT_FAILED
            : confineProviderDiagnostic(error, "Claude query failed"),
        };
      }
    }

    if (fatalEnding) return fatalEnding;
    if (cancelled || (isAborted() && !semanticComplete)) {
      return { ending: "cancelled" };
    }
    if (successfulResult) {
      // Normal stream completion after admission without authoritative
      // consumption keeps the valid answer and fabricates no user Fact.
      return { ending: "answered" };
    }
    return { ending: "failed", errorMessage: MISSING_CLAUDE_ANSWER };
  } finally {
    const diagnostic = providerStderr.confined(
      "Claude SDK reported diagnostics",
    );
    if (diagnostic) run.report.stderr(diagnostic);
    accepting = false;
    unsubscribeControls();
    run.signal?.removeEventListener("abort", onAbort);
    closeSignal?.removeEventListener("abort", onAbort);
    stop();
  }
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
      return {
        capabilities: { resume: true },
        model,
        prepareRun: (task) => ({
          supportedControls: ["steer"],
          async execute(run) {
            if (closed || run.signal?.aborted) return { ending: "cancelled" };
            if (active) {
              return {
                ending: "failed",
                errorMessage: "Claude adapter already has an active Run",
              };
            }
            const execution = runClaudeAttempt(
              run,
              task,
              context,
              model,
              effort,
              loadQuery,
              continuation,
              (identity) => {
                if (continuation === undefined) continuation = identity;
              },
              closeController.signal,
            );
            active = execution;
            try {
              return await execution;
            } finally {
              if (active === execution) active = undefined;
            }
          },
        }),
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
