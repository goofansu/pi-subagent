/**
 * A scriptable stand-in for the Claude SDK's `query` function.
 *
 * It implements the slice of a Query the adapter drives — iterate, and close —
 * and behaves the way the M0 spike found the real one behaves, including the
 * three things a politer double would get wrong:
 *
 * - **A Query aborted early produces no frames at all.** The spike aborted one
 *   50 ms in and got nothing, not even the init frame, so no conversation
 *   identity was ever seen. A stand-in that always emitted an init frame would
 *   make the adapter's zero-observation path untestable.
 * - **Steering is confirmed by a frame, not by the push returning.** Pushing a
 *   message into the input stream says nothing about whether the model saw it.
 *   So `await-input` and `echo-input` are separate steps: a script can take
 *   guidance and never acknowledge it, which is the case the adapter must not
 *   fabricate a user observation for.
 * - **A result frame is one turn, not the end of the Query.** A script can
 *   emit several, which is what makes the Turn-boundary rule testable.
 *
 * Every wait is a gate the test controls, and there is no timer anywhere in
 * this file: a suite that slept would be a suite whose failures depended on
 * the machine it ran on.
 *
 * The SDK's own types are **not imported here**. They come through the aliases
 * the adapter re-exports, which is what keeps `@anthropic-ai/*` confined to
 * one directory even for the adapter's test doubles — the boundary test checks
 * it, and there is a fixture for a stand-in that reached for the SDK directly.
 */

import type {
  ClaudeFrame,
  ClaudeInputMessage,
  ClaudeOptions,
  ClaudeQuery,
  ClaudeQueryStream,
} from "../../backend/claude/index.ts";
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

/** A valid conversation identity, for scripts that do not name their own. */
export const STAND_IN_IDENTITY = "ba5a6f16-1b4e-4c8a-9f3d-2b7c1e5a9d40";

/** A second one, for proving that a changed identity fails the attachment. */
export const OTHER_STAND_IN_IDENTITY = "c17d9e02-8a35-4f61-b0c4-7e2d5a8f3b91";

/** The model a script's frames name unless they say otherwise. */
export const STAND_IN_MODEL = "claude-sonnet-4-6";

/** Per-model usage as the result frame reports it. */
export interface StandInModelUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
  /** The denominator of the context gauge. */
  readonly window?: number;
}

/** One native tool call, as an assistant frame's `tool_use` block. */
export interface StandInToolCall {
  readonly name: string;
  readonly callId: string;
}

/**
 * Which input a result frame says its turn answered.
 *
 * `prompt` is the ordinary case. `awaited` is a steered turn. `unowned` is the
 * shape the adapter must treat as uncorrelatable — a valid result the provider
 * could not tie to any input this Run pushed — and `none` omits the field
 * entirely, which older CLIs do.
 */
export type StandInCorrelation = "prompt" | "awaited" | "unowned" | "none";

/** What one scripted Query does, step by step. */
export type ClaudeScriptStep =
  /** The `system`/`init` frame, which is the identity boundary of a fresh Query. */
  | {
      readonly step: "init";
      readonly identity?: string;
      readonly model?: string;
      readonly replay?: boolean;
    }
  | {
      readonly step: "assistant";
      readonly text?: string;
      readonly toolCalls?: readonly StandInToolCall[];
      /** Several frames sharing one id are one provider turn. */
      readonly messageId?: string;
      readonly model?: string;
      /** A tool-parented frame is a sidechain reply, not a turn. */
      readonly parentToolUseId?: string;
      readonly subagentType?: string;
      readonly replay?: boolean;
      readonly identity?: string;
      /** Emit a thinking block, which does not cross the boundary. */
      readonly thinking?: string;
    }
  /** A `user` frame carrying a tool result, which is not a steering echo. */
  | {
      readonly step: "tool-result";
      readonly callId: string;
      readonly text?: string;
      readonly isError?: boolean;
      readonly replay?: boolean;
    }
  /**
   * A frame of replayed conversation history, before the attachment boundary.
   *
   * Unflagged on purpose: this is the shape a resumed Query replays that the
   * `isReplay` check does *not* catch, and the pre-boundary drop is what has
   * to.
   */
  | {
      readonly step: "history";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly identity?: string;
    }
  /**
   * Wait until the client pushes one more Control.
   *
   * The Run's own prompt is not something a script waits for: every Query
   * starts by being pushed one, so counting it would make every script that
   * cares about guidance start with a step that says nothing.
   */
  | { readonly step: "await-input"; readonly echo?: boolean }
  /** Echo the last awaited input's uuid back, which confirms it. */
  | { readonly step: "echo-input" }
  | {
      readonly step: "result";
      readonly text?: string;
      readonly isError?: boolean;
      readonly numTurns?: number;
      readonly models?: Readonly<Record<string, StandInModelUsage>>;
      readonly cost?: number;
      readonly correlate?: StandInCorrelation;
      readonly identity?: string;
      readonly replay?: boolean;
    }
  /** Write to the SDK's stderr callback. */
  | { readonly step: "stderr"; readonly text?: string }
  /** Wait for the test to open a named gate. */
  | { readonly step: "await-gate"; readonly gate: string }
  /**
   * Stop reading the client's input stream, as a dying subprocess does.
   *
   * The one way an input push can be *refused* rather than merely unanswered,
   * which is what the adapter's bounded `control` diagnostic is for.
   */
  | { readonly step: "abandon-input" }
  /** Hang until the Query is aborted or closed. */
  | { readonly step: "hang" }
  /** Throw from the iterator, which is how a transport dies mid-stream. */
  | { readonly step: "throw" }
  /** Make `query()` itself throw, so no Query is ever returned. */
  | { readonly step: "throw-on-start" };

export type ClaudeScript = readonly ClaudeScriptStep[];

/** One message the client pushed into a Query's input stream. */
export interface StandInInput {
  readonly text: string;
  readonly uuid: string;
  readonly priority?: string;
  /** Which Run's execution pushed it, when the rig said. */
  readonly runId?: RunId;
}

/** What the stand-in recorded, for a rig and for a test. */
export interface StandInRecord {
  /** Queries started. One per Run that got as far as starting one. */
  readonly queries: number;
  /** Queries whose iteration has finished or been closed. */
  readonly closedQueries: number;
  /** Queries still iterating. Zero once every Run has settled. */
  readonly liveQueries: number;
  /** Input streams the stand-in is still reading. Zero after closure. */
  readonly openInputs: number;
  /** Every input message pushed, in push order, with uuid and priority. */
  readonly inputs: readonly StandInInput[];
  /** The guidance pushed with `later` priority, in push order. */
  readonly controls: readonly string[];
  /** The most pushed-but-unacknowledged Controls at once. One, when serial. */
  readonly maxConcurrentControls: number;
  /** Which Run each Control was pushed during. */
  readonly controlsByRun: ReadonlyMap<RunId, readonly string[]>;
  /** `close()` calls on a Query. */
  readonly closes: number;
  /** Abort controllers the adapter aborted. */
  readonly aborts: number;
  /** The options each Query was started with, in order. */
  readonly options: readonly ClaudeOptions[];
  /** The conversation identity each Query was asked to resume, in order. */
  readonly resumes: readonly (string | undefined)[];
}

export interface StandInClaudeQuery {
  readonly query: ClaudeQuery;
  readonly record: () => StandInRecord;
  /** Say which Run is running, so pushed Controls can be grouped by it. */
  readonly beginRun: (runId: RunId) => void;
  readonly endRun: () => void;
  /** Open a gate a script waits on. Created on first mention. */
  readonly gate: (name: string) => Gate;
}

export interface StandInClaudeQueryOptions {
  /** One script per Query, consumed in order. An absent script ends at once. */
  readonly scripts: readonly ClaudeScript[];
  /** Gates shared with the rig, created on first mention when omitted. */
  readonly gates?: Record<string, Gate>;
}

function usageOf(
  models: Readonly<Record<string, StandInModelUsage>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(models).map(([model, usage]) => [
      model,
      {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        cacheReadInputTokens: usage.cacheRead ?? 0,
        cacheCreationInputTokens: usage.cacheWrite ?? 0,
        webSearchRequests: 0,
        costUSD: usage.cost ?? 0,
        contextWindow: usage.window ?? 200_000,
        maxOutputTokens: 64_000,
      },
    ]),
  );
}

/** The text of one pushed input message, however its content was shaped. */
function textOf(message: ClaudeInputMessage): string {
  const content = (message.message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

export function createStandInClaudeQuery(
  options: StandInClaudeQueryOptions,
): StandInClaudeQuery {
  const gates: Record<string, Gate> = options.gates ?? {};
  const inputs: StandInInput[] = [];
  const controls: string[] = [];
  const controlsByRun = new Map<RunId, string[]>();
  const startedOptions: ClaudeOptions[] = [];
  const resumes: (string | undefined)[] = [];
  /** Awaiters for "one more input has been pushed". */
  const inputWaiters: (() => void)[] = [];
  /** Controls pushed and not yet acknowledged by an echo or a correlation. */
  const unacknowledged = new Set<string>();

  let scriptIndex = 0;
  let queries = 0;
  let closedQueries = 0;
  let liveQueries = 0;
  let openInputs = 0;
  let closes = 0;
  let aborts = 0;
  let maxConcurrentControls = 0;
  let activeRun: RunId | undefined;

  const gate = (name: string): Gate => {
    gates[name] ??= createGate();
    return gates[name];
  };

  const wakeInputWaiters = (): void => {
    for (const wake of inputWaiters.splice(0)) wake();
  };

  /**
   * Read the client's input stream in the background, recording every push.
   *
   * The real SDK reads the stream continuously, so the stand-in does too:
   * a double that only read when its script asked would let the adapter's
   * pushes pile up unobserved, and "one Control provider-visible at a time"
   * would stop being a thing a test could see.
   */
  const consumeInput = (
    prompt: string | AsyncIterable<ClaudeInputMessage>,
  ): (() => void) => {
    if (typeof prompt === "string") return () => {};
    const reader = prompt[Symbol.asyncIterator]();
    openInputs += 1;
    void (async () => {
      try {
        for (;;) {
          const next = await reader.next();
          if (next.done === true) break;
          const message = next.value;
          const priority = message.priority;
          const entry: StandInInput = {
            text: textOf(message),
            uuid: String(message.uuid ?? ""),
            ...(priority === undefined ? {} : { priority }),
            ...(activeRun === undefined ? {} : { runId: activeRun }),
          };
          inputs.push(entry);
          if (priority !== undefined) {
            controls.push(entry.text);
            unacknowledged.add(entry.uuid);
            maxConcurrentControls = Math.max(
              maxConcurrentControls,
              unacknowledged.size,
            );
            if (activeRun !== undefined) {
              const forRun = controlsByRun.get(activeRun) ?? [];
              forRun.push(entry.text);
              controlsByRun.set(activeRun, forRun);
            }
          }
          wakeInputWaiters();
        }
      } finally {
        openInputs -= 1;
        wakeInputWaiters();
      }
    })();
    return () => {
      void reader.return?.(undefined);
    };
  };

  const query: ClaudeQuery = ({ prompt, options: queryOptions }) => {
    const script = options.scripts[scriptIndex] ?? [];
    scriptIndex += 1;
    if (script[0]?.step === "throw-on-start") {
      throw new Error("the stand-in Claude query refused to start");
    }
    queries += 1;
    liveQueries += 1;
    startedOptions.push(queryOptions ?? {});
    resumes.push(queryOptions?.resume);
    const abandonInput = consumeInput(prompt);

    let stopped = false;
    const stopWaiters: (() => void)[] = [];
    const releaseStop = (): void => {
      stopped = true;
      for (const wake of stopWaiters.splice(0)) wake();
    };
    const signal = queryOptions?.abortController?.signal;
    if (signal?.aborted) {
      aborts += 1;
      releaseStop();
    } else {
      signal?.addEventListener(
        "abort",
        () => {
          aborts += 1;
          releaseStop();
        },
        { once: true },
      );
    }

    const untilStopped = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (stopped) {
          resolve();
          return;
        }
        stopWaiters.push(resolve);
      });

    /** Race a wait against the stop, so a hanging script stops when told to. */
    const orStopped = async (waiting: Promise<void>): Promise<boolean> => {
      await Promise.race([waiting, untilStopped()]);
      return stopped;
    };

    /**
     * Wait until one more input has been pushed than has been awaited.
     *
     * Starts at one, because the first input is the Run's prompt and no script
     * waits for that.
     */
    let awaitedInputs = 1;
    let awaited: StandInInput | undefined;
    const awaitInput = async (): Promise<boolean> => {
      for (;;) {
        if (inputs.length > awaitedInputs) {
          awaited = inputs[awaitedInputs];
          awaitedInputs += 1;
          return false;
        }
        if (
          await orStopped(
            new Promise<void>((resolve) => {
              inputWaiters.push(resolve);
            }),
          )
        ) {
          return true;
        }
      }
    };

    const acknowledge = (uuid: string | undefined): void => {
      if (uuid !== undefined) unacknowledged.delete(uuid);
    };

    /**
     * Wait until the prompt has actually been read.
     *
     * A real Query cannot report which input its turn answered before it has
     * read one, and a result frame is the first thing most scripts emit. So a
     * result correlating to the prompt waits for the prompt rather than
     * racing the background reader for it.
     */
    const awaitPrompt = async (): Promise<void> => {
      while (inputs.length === 0) {
        if (
          await orStopped(
            new Promise<void>((resolve) => {
              inputWaiters.push(resolve);
            }),
          )
        ) {
          return;
        }
      }
    };

    const correlationUuid = (which: StandInCorrelation): string | undefined => {
      switch (which) {
        case "prompt":
          return inputs[0]?.uuid;
        case "awaited":
          return awaited?.uuid;
        case "unowned":
          return globalThis.crypto.randomUUID();
        case "none":
          return undefined;
      }
    };

    async function* frames(): AsyncGenerator<ClaudeFrame, void> {
      try {
        for (const step of script) {
          if (stopped) return;
          switch (step.step) {
            case "throw-on-start":
              return;
            case "init":
              yield {
                type: "system",
                subtype: "init",
                model: step.model ?? STAND_IN_MODEL,
                cwd: queryOptions?.cwd ?? "/work",
                session_id: step.identity ?? STAND_IN_IDENTITY,
                uuid: globalThis.crypto.randomUUID(),
                ...(step.replay === true ? { isReplay: true } : {}),
              } as unknown as ClaudeFrame;
              break;
            case "assistant": {
              const content: unknown[] = [];
              if (step.thinking !== undefined) {
                content.push({ type: "thinking", thinking: step.thinking });
              }
              if (step.text !== undefined) {
                content.push({ type: "text", text: step.text });
              }
              for (const call of step.toolCalls ?? []) {
                content.push({
                  type: "tool_use",
                  id: call.callId,
                  name: call.name,
                  input: {},
                });
              }
              yield {
                type: "assistant",
                message: {
                  id: step.messageId ?? `msg_${globalThis.crypto.randomUUID()}`,
                  role: "assistant",
                  model: step.model ?? STAND_IN_MODEL,
                  content,
                },
                parent_tool_use_id: step.parentToolUseId ?? null,
                ...(step.subagentType === undefined
                  ? {}
                  : { subagent_type: step.subagentType }),
                session_id: step.identity ?? STAND_IN_IDENTITY,
                uuid: globalThis.crypto.randomUUID(),
                ...(step.replay === true ? { isReplay: true } : {}),
              } as unknown as ClaudeFrame;
              break;
            }
            case "tool-result":
              yield {
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: step.callId,
                      content: step.text ?? "",
                      ...(step.isError === true ? { is_error: true } : {}),
                    },
                  ],
                },
                parent_tool_use_id: null,
                session_id: STAND_IN_IDENTITY,
                uuid: globalThis.crypto.randomUUID(),
                ...(step.replay === true ? { isReplay: true } : {}),
              } as unknown as ClaudeFrame;
              break;
            case "history":
              yield (step.role === "user"
                ? {
                    type: "user",
                    message: {
                      role: "user",
                      content: [{ type: "text", text: step.text }],
                    },
                    parent_tool_use_id: null,
                    session_id: step.identity ?? STAND_IN_IDENTITY,
                    uuid: globalThis.crypto.randomUUID(),
                  }
                : {
                    type: "assistant",
                    message: {
                      id: `msg_history_${globalThis.crypto.randomUUID()}`,
                      role: "assistant",
                      model: STAND_IN_MODEL,
                      content: [{ type: "text", text: step.text }],
                    },
                    parent_tool_use_id: null,
                    session_id: step.identity ?? STAND_IN_IDENTITY,
                    uuid: globalThis.crypto.randomUUID(),
                  }) as unknown as ClaudeFrame;
              break;
            case "await-input": {
              if (await awaitInput()) return;
              if (step.echo !== true) break;
              acknowledge(awaited?.uuid);
              yield echoFrame(awaited);
              break;
            }
            case "echo-input":
              acknowledge(awaited?.uuid);
              yield echoFrame(awaited);
              break;
            case "result": {
              const which = step.correlate ?? "prompt";
              if (which === "prompt") await awaitPrompt();
              if (stopped) return;
              const correlation = correlationUuid(which);
              acknowledge(correlation);
              yield {
                type: "result",
                subtype:
                  step.isError === true
                    ? "error_during_execution"
                    : ("success" as const),
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: step.isError === true,
                num_turns: step.numTurns ?? 1,
                result: step.text ?? "",
                stop_reason: "end_turn",
                total_cost_usd: step.cost ?? 0,
                usage: {},
                modelUsage: usageOf(step.models ?? { [STAND_IN_MODEL]: {} }),
                permission_denials: [],
                errors: [],
                session_id: step.identity ?? STAND_IN_IDENTITY,
                uuid: globalThis.crypto.randomUUID(),
                ...(correlation === undefined
                  ? {}
                  : { user_message_uuid: correlation }),
                ...(step.replay === true ? { isReplay: true } : {}),
              } as unknown as ClaudeFrame;
              break;
            }
            case "stderr":
              queryOptions?.stderr?.(
                step.text ?? "the stand-in Claude SDK wrote to stderr",
              );
              break;
            case "await-gate":
              if (await orStopped(gate(step.gate).promise)) return;
              break;
            case "abandon-input":
              abandonInput();
              break;
            case "hang":
              await untilStopped();
              return;
            case "throw":
              throw new Error("the stand-in Claude query broke mid-stream");
          }
        }
      } finally {
        liveQueries -= 1;
        closedQueries += 1;
      }
    }

    const stream = frames();
    const handle: ClaudeQueryStream = {
      [Symbol.asyncIterator]: () => stream,
      close: () => {
        closes += 1;
        releaseStop();
        void stream.return(undefined);
      },
    };
    return handle;
  };

  function echoFrame(input: StandInInput | undefined): ClaudeFrame {
    return {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: input?.text ?? "" }],
      },
      parent_tool_use_id: null,
      session_id: STAND_IN_IDENTITY,
      uuid: input?.uuid ?? globalThis.crypto.randomUUID(),
    } as unknown as ClaudeFrame;
  }

  return {
    query,
    beginRun: (runId) => {
      activeRun = runId;
    },
    endRun: () => {
      activeRun = undefined;
    },
    gate,
    record: () => ({
      queries,
      closedQueries,
      liveQueries,
      openInputs,
      inputs: [...inputs],
      controls: [...controls],
      maxConcurrentControls,
      controlsByRun: new Map(
        [...controlsByRun].map(([runId, texts]) => [runId, [...texts]]),
      ),
      closes,
      aborts,
      options: [...startedOptions],
      resumes: [...resumes],
    }),
  };
}
