import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  Fact,
  FactPart,
  RunControl,
  RunEnding,
  SubagentRun,
  SubagentTask,
} from "../../run.ts";
import { confineProviderDiagnostic } from "../provider-diagnostic.ts";
import type { PiSession } from "./agent.ts";

const MISSING_TERMINAL_EVENT_ERROR =
  "Pi managed session completed without a valid terminal agent_end event containing a messages array.";
const PENDING_CLEANUP_ERROR =
  "Pi session cleanup is still waiting for native steering to finish";

interface PendingPiSessionCleanup {
  readonly settled: Promise<void>;
}

interface PiConversationCapability {
  isClosed(): boolean;
  hasPendingCleanup(): boolean;
  acquireSession(signal?: AbortSignal): Promise<PiSession>;
  stopSession(session: PiSession): Promise<PendingPiSessionCleanup | undefined>;
  registerCancellation(cancel: () => Promise<void>): () => void;
  retainSteeringCleanup(cleanup: Promise<void>): void;
  releaseSteeringCleanup(cleanup: Promise<void>): void;
  retainNativeCleanup(cleanup: Promise<void>): void;
  releaseNativeCleanup(cleanup: Promise<void>): void;
}

interface PiAttemptOptions {
  readonly task: SubagentTask;
  readonly run: SubagentRun;
  readonly conversation: PiConversationCapability;
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

interface PiControlRecord {
  readonly control: RunControl;
  discarded: boolean;
}

export async function runPiAttempt({
  task,
  run,
  conversation,
}: PiAttemptOptions): Promise<RunEnding> {
  const {
    isClosed,
    hasPendingCleanup,
    acquireSession,
    stopSession,
    registerCancellation,
    retainSteeringCleanup,
    releaseSteeringCleanup,
    retainNativeCleanup,
    releaseNativeCleanup,
  } = conversation;
  if (isClosed() || run.signal?.aborted) return { ending: "cancelled" };
  if (hasPendingCleanup()) {
    return {
      ending: "failed",
      errorMessage: PENDING_CLEANUP_ERROR,
    };
  }
  let sdk: PiSession;
  try {
    sdk = await acquireSession(run.signal);
  } catch (error) {
    if (isClosed() || run.signal?.aborted) return { ending: "cancelled" };
    return {
      ending: "failed",
      errorMessage: confineProviderDiagnostic(
        error,
        "Pi initialization failed",
      ),
    };
  }
  if (isClosed() || run.signal?.aborted) return { ending: "cancelled" };

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
      releaseSteeringCleanup(lateCleanup);
    });
    cancellationWork = (async () => {
      // Abort first so uncooperative native work cannot indefinitely prevent
      // cancellation or Session shutdown. A still-pending steer blocks Resume
      // until the Conversation owner observes its late cleanup completion.
      const pendingNative = await stopSession(sdk);
      if (pendingNative) {
        const lateNativeCleanup = pendingNative.settled.finally(() => {
          clearNativeQueue();
          releaseNativeCleanup(lateNativeCleanup);
        });
        retainNativeCleanup(lateNativeCleanup);
      }
      clearNativeQueue();
      if (!steeringSettled) retainSteeringCleanup(lateCleanup);
    })().finally(releaseCancellation);
    return cancellationWork;
  };
  const onAbort = (): void => {
    void stopCurrentWork();
  };
  const unregisterCancellation = registerCancellation(stopCurrentWork);
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

    if (cancelled || run.signal?.aborted || isClosed()) {
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
    if (cancelled || run.signal?.aborted || isClosed()) {
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
    if (cancelled || run.signal?.aborted || isClosed()) {
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
    unregisterCancellation();
  }
}
