/**
 * A scriptable stand-in for Pi's native session.
 *
 * It implements the slice of the session the adapter uses, and behaves the way
 * the M0 spike and SDK inspection found the real one behaves — including the
 * three things a politer double would get wrong:
 *
 * - **A disposed session still accepts a prompt.** The SDK does not defend
 *   itself, so a stand-in that threw would make the adapter's own closed flag
 *   untestable: the test would pass because the double refused, not because
 *   the adapter did.
 * - **`abort` releases the work.** Aborting a real session ends the prompt and
 *   leaves the session idle and resumable, so a script that is hanging stops
 *   hanging — unless it says `ignore-abort`, which is how the cleanup
 *   escalation path is reached on purpose.
 * - **An idle steer is queued.** Pi polls its steering queue when the next
 *   prompt starts, so guidance delivered after one prompt settles is surfaced
 *   as a user message during the next prompt unless the queue is cleared.
 *
 * Every wait is a gate the test controls, and there is no timer anywhere in
 * this file: a suite that slept would be a suite whose failures depended on
 * the machine it ran on. v1's Pi fixtures are the source for what the scripts
 * need to be able to say.
 *
 * The recorder side is what the conformance rig reads: steers in delivery
 * order and grouped by the Run they were delivered to, live subscriptions,
 * sessions disposed, and the shutdown events a child's extensions were sent.
 */

import type { PiSession, PiSessionEvent } from "../../backend/pi/index.ts";
import type { RunId } from "../../domain/index.ts";

/** A promise a test resolves, standing in for anything that would wait. */
export interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

export function createGate(): Gate {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

/** Usage as Pi reports it, per message. */
export interface PiScriptUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Pi's per-message context occupancy, which is a gauge and never summed. */
  readonly totalTokens?: number;
  readonly cost?: number;
}

/** One native tool call, as an assistant message part. */
export interface PiScriptToolCall {
  readonly name: string;
  readonly callId: string;
}

/** What one scripted prompt does, step by step. */
export type PiScriptStep =
  | {
      readonly step: "assistant";
      readonly text?: string;
      readonly usage?: PiScriptUsage;
      readonly toolCalls?: readonly PiScriptToolCall[];
      readonly model?: { readonly provider: string; readonly id: string };
      /** Make the message carry a provider error, which is confined. */
      readonly errorMessage?: string;
    }
  | { readonly step: "user"; readonly text: string }
  | { readonly step: "tool-result"; readonly text: string }
  | {
      readonly step: "tool-start";
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly step: "tool-end";
      readonly callId: string;
      readonly name: string;
      readonly result?: unknown;
      readonly isError?: boolean;
    }
  /** Rewrite the last message's usage without re-emitting it: streamed drift. */
  | { readonly step: "restate-usage"; readonly usage: PiScriptUsage }
  /** Wait for the test to open a named gate. */
  | { readonly step: "await-gate"; readonly gate: string }
  /**
   * Wait for one native steer, then answer it.
   *
   * `confirm` is what the provider does with it: a confirmed steer becomes a
   * user message the session emits, and an unconfirmed one is consumed
   * silently. `reject` makes the steer call fail, which is the only way an
   * adapter learns delivery did not happen.
   */
  | {
      readonly step: "await-steer";
      readonly confirm: boolean;
      readonly reject?: boolean;
      /** Leave the native `steer` promise pending after consuming it. */
      readonly settle?: boolean;
    }
  /** Emit the terminal frame. `willRetry` means it is not terminal after all. */
  | { readonly step: "terminal"; readonly willRetry?: boolean }
  /** Reject the prompt. */
  | { readonly step: "reject"; readonly message?: string }
  /** Hang until the session is aborted. */
  | { readonly step: "hang" }
  /** Hang and keep hanging, abort or not. Reaches the cleanup escalation. */
  | { readonly step: "ignore-abort" }
  /** Say one more thing while the session is being aborted. */
  | { readonly step: "speak-on-abort"; readonly text: string };

export type PiScript = readonly PiScriptStep[];

/** What the stand-in recorded, for a rig and for a test. */
export interface StandInRecord {
  /** Sessions this stand-in stands for. One. */
  readonly created: number;
  /** Sessions disposed. Equal to `created` once a Session has closed. */
  readonly disposed: number;
  /** Event subscriptions still attached. */
  readonly liveSubscriptions: number;
  /** Subscriptions ever attached. */
  readonly subscriptions: number;
  /** Shutdown events sent to the child's extensions. */
  readonly shutdownEmits: number;
  /** `bindExtensions` calls. */
  readonly binds: number;
  /** Every steer the session received, in delivery order. */
  readonly steers: readonly string[];
  /** The most steers in flight at once. One, for a serial consumer. */
  readonly maxConcurrentSteers: number;
  /** Which Run each steer was delivered during. */
  readonly steersByRun: ReadonlyMap<RunId, readonly string[]>;
  /** Prompts begun. */
  readonly prompts: number;
  /** Prompts begun after the session was disposed, which the SDK allows. */
  readonly promptsAfterDispose: number;
  /** `clearQueue` calls. */
  readonly queueClears: number;
  /** `abort` calls. */
  readonly aborts: number;
}

export interface StandInPiSession {
  readonly session: PiSession;
  readonly record: () => StandInRecord;
  /** Say which Run is running, so steers can be grouped by it. */
  readonly beginRun: (runId: RunId) => void;
  readonly endRun: () => void;
  /** Open a gate a script waits on. Created on first mention. */
  readonly gate: (name: string) => Gate;
}

export interface StandInPiSessionOptions {
  /** One script per prompt, consumed in order. */
  readonly scripts: readonly PiScript[];
  /** Gates shared with the rig, created on first mention when omitted. */
  readonly gates?: Record<string, Gate>;
  /** Test-only observation point for ordering native stop against core stages. */
  readonly onAbort?: () => void;
}

interface StandInMessage {
  role: string;
  content: unknown;
  timestamp: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Record<string, unknown>;
}

/** A steer waiting for the script to consume it. */
interface PendingSteer {
  readonly text: string;
  readonly settle: (rejected: boolean) => void;
}

function usageOf(usage: PiScriptUsage): Record<string, unknown> {
  return {
    ...(usage.input === undefined ? {} : { input: usage.input }),
    ...(usage.output === undefined ? {} : { output: usage.output }),
    ...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
    ...(usage.cost === undefined ? {} : { cost: { total: usage.cost } }),
  };
}

export function createStandInPiSession(
  options: StandInPiSessionOptions,
): StandInPiSession {
  const listeners = new Set<(event: PiSessionEvent) => void>();
  const messages: StandInMessage[] = [];
  const gates: Record<string, Gate> = options.gates ?? {};
  const steers: string[] = [];
  const steersByRun = new Map<RunId, string[]>();
  const pendingSteers: PendingSteer[] = [];
  const steeringQueue: string[] = [];
  const steerWaiters: (() => void)[] = [];
  const abortWaiters: (() => void)[] = [];
  const idleWaiters: (() => void)[] = [];

  let disposed = 0;
  let subscriptions = 0;
  let shutdownEmits = 0;
  let binds = 0;
  let prompts = 0;
  let promptsAfterDispose = 0;
  let queueClears = 0;
  let aborts = 0;
  let concurrentSteers = 0;
  let maxConcurrentSteers = 0;
  let inFlight = 0;
  let scriptIndex = 0;
  let sessionDisposed = false;
  let activeRun: RunId | undefined;
  let abortedRun = false;
  let speakOnAbort: string | undefined;
  let clock = 1;

  const gate = (name: string): Gate => {
    gates[name] ??= createGate();
    return gates[name];
  };

  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event as PiSessionEvent);
  };

  const remember = (message: StandInMessage): StandInMessage => {
    messages.push(message);
    return message;
  };

  const emitMessage = (message: StandInMessage): void => {
    emit({ type: "message_end", message });
  };

  const waitForAbort = (): Promise<void> =>
    new Promise<void>((resolve) => {
      abortWaiters.push(resolve);
    });

  const waitForSteer = (): Promise<void> =>
    new Promise<void>((resolve) => {
      steerWaiters.push(resolve);
    });

  const releaseIdle = (): void => {
    if (inFlight > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  /** Race a wait against the abort, so a hanging script stops when told to. */
  const untilAborted = async (waiting: Promise<void>): Promise<boolean> => {
    let aborted = false;
    await Promise.race([
      waiting,
      waitForAbort().then(() => {
        aborted = true;
      }),
    ]);
    return aborted;
  };

  async function runScript(script: PiScript): Promise<void> {
    for (const step of script) {
      if (abortedRun) return;
      switch (step.step) {
        case "assistant": {
          const parts: unknown[] = [];
          if (step.text !== undefined) {
            parts.push({ type: "text", text: step.text });
          }
          for (const call of step.toolCalls ?? []) {
            parts.push({ type: "toolCall", name: call.name, id: call.callId });
          }
          clock += 1;
          emitMessage(
            remember({
              role: "assistant",
              content: parts,
              timestamp: clock,
              ...(step.model === undefined
                ? {}
                : { provider: step.model.provider, model: step.model.id }),
              ...(step.errorMessage === undefined
                ? {}
                : { errorMessage: step.errorMessage }),
              ...(step.usage === undefined
                ? {}
                : { usage: usageOf(step.usage) }),
            }),
          );
          break;
        }
        case "user": {
          clock += 1;
          emitMessage(
            remember({
              role: "user",
              content: [{ type: "text", text: step.text }],
              timestamp: clock,
            }),
          );
          break;
        }
        case "tool-result": {
          clock += 1;
          emitMessage(
            remember({
              role: "toolResult",
              content: [{ type: "text", text: step.text }],
              timestamp: clock,
            }),
          );
          break;
        }
        case "tool-start": {
          emit({
            type: "tool_execution_start",
            toolCallId: step.callId,
            toolName: step.name,
            args: {},
          });
          break;
        }
        case "tool-end": {
          emit({
            type: "tool_execution_end",
            toolCallId: step.callId,
            toolName: step.name,
            result: step.result,
            isError: step.isError === true,
          });
          break;
        }
        case "restate-usage": {
          const last = messages[messages.length - 1];
          if (last) last.usage = usageOf(step.usage);
          break;
        }
        case "await-gate": {
          if (await untilAborted(gate(step.gate).promise)) return;
          break;
        }
        case "await-steer": {
          while (pendingSteers.length === 0) {
            if (await untilAborted(waitForSteer())) return;
          }
          const pending = pendingSteers.shift() as PendingSteer;
          if (step.confirm) {
            clock += 1;
            emitMessage(
              remember({
                role: "user",
                content: [{ type: "text", text: pending.text }],
                timestamp: clock,
              }),
            );
          }
          if (step.settle !== false) pending.settle(step.reject === true);
          break;
        }
        case "terminal": {
          emit({
            type: "agent_end",
            messages: [...messages],
            willRetry: step.willRetry === true,
          });
          break;
        }
        case "reject": {
          throw new Error(step.message ?? "the stand-in Pi session refused");
        }
        case "hang": {
          await waitForAbort();
          return;
        }
        case "ignore-abort": {
          // Deliberately unreachable by abort: the caller's cleanup budget is
          // what ends this, and the escalation is what the test is about.
          await new Promise<void>(() => {});
          return;
        }
        case "speak-on-abort": {
          speakOnAbort = step.text;
          break;
        }
      }
    }
  }

  const session: PiSession = {
    get messages() {
      return messages as unknown as PiSession["messages"];
    },
    get isIdle() {
      return inFlight === 0;
    },
    async prompt(text: string) {
      prompts += 1;
      if (sessionDisposed) promptsAfterDispose += 1;
      inFlight += 1;
      abortedRun = false;
      const script = options.scripts[scriptIndex] ?? [];
      scriptIndex += 1;
      // Pi echoes the brief back as the Run's first user message, which is the
      // one the adapter must omit.
      clock += 1;
      emitMessage(
        remember({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: clock,
        }),
      );
      // Pi's agent loop polls steering at the start of every prompt. Anything
      // delivered while the session was idle therefore becomes part of this
      // prompt, which is the leak the adapter must prevent.
      for (const queued of steeringQueue.splice(0)) {
        clock += 1;
        emitMessage(
          remember({
            role: "user",
            content: [{ type: "text", text: queued }],
            timestamp: clock,
          }),
        );
      }
      try {
        await runScript(script);
      } finally {
        inFlight -= 1;
        releaseIdle();
      }
    },
    async steer(text: string) {
      steers.push(text);
      if (activeRun !== undefined) {
        const forRun = steersByRun.get(activeRun) ?? [];
        forRun.push(text);
        steersByRun.set(activeRun, forRun);
      }
      concurrentSteers += 1;
      maxConcurrentSteers = Math.max(maxConcurrentSteers, concurrentSteers);
      try {
        if (inFlight === 0) {
          steeringQueue.push(text);
          return;
        }
        const rejected = await new Promise<boolean>((resolve) => {
          pendingSteers.push({ text, settle: resolve });
          for (const wake of steerWaiters.splice(0)) wake();
        });
        if (rejected) {
          throw new Error("the stand-in Pi session refused a steer");
        }
      } finally {
        concurrentSteers -= 1;
      }
    },
    subscribe(listener) {
      subscriptions += 1;
      const typed = listener as (event: PiSessionEvent) => void;
      listeners.add(typed);
      return () => {
        listeners.delete(typed);
      };
    },
    async bindExtensions() {
      binds += 1;
    },
    async abort() {
      options.onAbort?.();
      aborts += 1;
      abortedRun = true;
      if (speakOnAbort !== undefined) {
        // The session's last word, said while it is being torn down. The Run
        // has already decided how it ended, so this is late by construction —
        // which is the point of the step.
        clock += 1;
        emitMessage(
          remember({
            role: "assistant",
            content: [{ type: "text", text: speakOnAbort }],
            timestamp: clock,
          }),
        );
        speakOnAbort = undefined;
      }
      for (const resolve of abortWaiters.splice(0)) resolve();
    },
    async waitForIdle() {
      if (inFlight === 0) return;
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    clearQueue() {
      queueClears += 1;
      return { steering: steeringQueue.splice(0), followUp: [] };
    },
    dispose() {
      // Disposal is not defended by the real SDK, and it is not defended here.
      disposed += 1;
      sessionDisposed = true;
      listeners.clear();
    },
    extensionRunner: {
      async emit(event) {
        if (event.type === "session_shutdown") shutdownEmits += 1;
        return undefined;
      },
    },
  };

  return {
    session,
    beginRun: (runId) => {
      activeRun = runId;
    },
    endRun: () => {
      activeRun = undefined;
    },
    gate,
    record: () => ({
      created: 1,
      disposed,
      liveSubscriptions: listeners.size,
      subscriptions,
      shutdownEmits,
      binds,
      steers: [...steers],
      maxConcurrentSteers,
      steersByRun: new Map(
        [...steersByRun].map(([runId, texts]) => [runId, [...texts]]),
      ),
      prompts,
      promptsAfterDispose,
      queueClears,
      aborts,
    }),
  };
}
