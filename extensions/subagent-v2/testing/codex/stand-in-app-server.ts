/**
 * A scriptable stand-in App Server, as a child process the adapter cannot
 * tell from the real one.
 *
 * The Codex adapter is written against `CodexChildProcess` — nine members, no
 * `node:child_process` — precisely so this can exist. It implements that
 * interface, is injected through the same `spawn` option the production
 * default fills, and is therefore a *drop-in*: no line of the adapter branches
 * on whether it is under test, and every test in this lane exercises the real
 * framing, the real bounded requests, the real routing, and the real
 * translation.
 *
 * It speaks the wire. Requests arrive as JSON-RPC lines on stdin and answers
 * go back as JSON-RPC lines on stdout, so a test that gets the shape wrong
 * fails in the adapter rather than in a mock's expectations.
 *
 * **Every wait is a gate.** Nothing here uses a timer or lets real time pass.
 * A Turn's frames are written the moment its `turn/start` is answered, and a
 * script that needs the test to do something in the middle says `hold` and
 * waits for `resume()`. That is what makes a race in this adapter reproducible
 * rather than a flake: the interleaving is written down.
 *
 * Everything it is asked to do is recorded — every line written to it with its
 * method and id, every signal, whether stdin was ended, and how it exited — so
 * assertions are about what the adapter actually did and not about what it was
 * expected to do.
 */

import type {
  CodexChildProcess,
  CodexProcessExit,
  CodexSignal,
  CodexSpawn,
  CodexSpawnRequest,
  CodexTokenBreakdown,
  CodexTurnStatus,
} from "../../backend/codex/index.ts";
import type { RunId } from "../../domain/index.ts";

/** The model the stand-in claims to be running, where one is reported. */
export const CODEX_STAND_IN_MODEL = "stand-in-codex";

/** The root thread id every stand-in hands out, unless told otherwise. */
export const CODEX_STAND_IN_ROOT = "root-thread";

/** An item, in as few words as a fixture needs to say it. */
export type CodexScriptItem =
  | {
      readonly kind: "agentMessage";
      readonly id: string;
      readonly text: string;
      /** Omitted means an older server, which reads as the final answer. */
      readonly phase?: "commentary" | "final_answer";
    }
  | {
      readonly kind: "command";
      readonly id: string;
      readonly command: string;
      readonly status?: "inProgress" | "completed" | "failed" | "declined";
      readonly output?: string;
    }
  | { readonly kind: "fileChange"; readonly id: string; readonly path: string }
  | {
      readonly kind: "mcp";
      readonly id: string;
      readonly server: string;
      readonly tool: string;
    }
  | { readonly kind: "webSearch"; readonly id: string; readonly query: string }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly summary?: readonly string[];
    }
  | { readonly kind: "plan"; readonly id: string; readonly text: string }
  | {
      readonly kind: "userMessage";
      readonly id: string;
      readonly clientId?: string;
      readonly text?: string;
    }
  /** A variant this adapter does not read, so a frame about it is ignored. */
  | { readonly kind: "unread"; readonly id: string };

/** One thing the stand-in does, in order, once a Turn has been named. */
export type CodexScriptFrame =
  | { readonly frame: "item-started"; readonly item: CodexScriptItem }
  | { readonly frame: "item-completed"; readonly item: CodexScriptItem }
  | {
      readonly frame: "message-delta";
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly frame: "output-delta";
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly frame: "reasoning-delta";
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly frame: "usage";
      /** The conversation-cumulative total, as the server reports it. */
      readonly total: Partial<CodexTokenBreakdown>;
      /** The last request's figures. Defaults to `total`. */
      readonly last?: Partial<CodexTokenBreakdown>;
      readonly window?: number;
    }
  | {
      readonly frame: "error";
      readonly message: string;
      readonly willRetry?: boolean;
    }
  | {
      readonly frame: "completed";
      readonly status?: CodexTurnStatus;
      readonly errorMessage?: string;
    }
  /** A client-bound request, which stalls the server if left unanswered. */
  | { readonly frame: "server-request"; readonly method: string }
  | { readonly frame: "stderr"; readonly text: string }
  /** A raw line, for a frame no builder here produces. */
  | { readonly frame: "raw"; readonly line: string }
  /** A raw line with no newline, as a child that died mid-write leaves one. */
  | { readonly frame: "partial-line"; readonly text: string }
  /** One line past the framing bound, with no newline to end it. */
  | { readonly frame: "oversized"; readonly length: number }
  | {
      readonly frame: "exit";
      readonly code?: number | null;
      readonly signal?: string | null;
    }
  /** Stop here. The test calls `resume()` when it is ready. */
  | { readonly frame: "hold" }
  /**
   * Stop here until a steer arrives, which is a gate rather than a wait.
   *
   * A scenario about steering order has to know that the guidance reached the
   * server *before* the Turn moved on, and the only honest way to say that is
   * to make the Turn's next frame depend on it.
   */
  | { readonly frame: "await-steer" }
  /** A frame carrying a turn id no Run is listening to. */
  | {
      readonly frame: "for-turn";
      readonly turnId: string;
      readonly item: CodexScriptItem;
    };

/** What one Turn does. */
export interface CodexTurnScript {
  /** The id this Turn is given. Defaults to `turn-1`, `turn-2`, and so on. */
  readonly turnId?: string;
  readonly frames?: readonly CodexScriptFrame[];
  /** Answer `turn/start` with a JSON-RPC error. */
  readonly refuseStart?: boolean;
  /** Never answer `turn/start`, so its bound decides. */
  readonly hangStart?: boolean;
  /** Answer `turn/start` with a result the adapter cannot read. */
  readonly malformedStart?: boolean;
}

/** One line the adapter wrote, parsed as far as an assertion needs. */
export interface CodexStandInWrite {
  readonly method?: string;
  readonly id?: number;
  readonly params?: Record<string, unknown>;
  /** Present on a response to a client-bound request. */
  readonly error?: Record<string, unknown>;
  readonly raw: string;
}

export interface CodexStandInRecord {
  readonly spawns: number;
  readonly requests: readonly CodexSpawnRequest[];
  readonly writes: readonly CodexStandInWrite[];
  /** The methods the adapter wrote, in order. */
  readonly methods: readonly string[];
  readonly signals: readonly CodexSignal[];
  readonly stdinEnded: boolean;
  readonly exit: CodexProcessExit | undefined;
  /** Turns started, which is how many turn ids were handed out. */
  readonly turns: number;
  /** `turn/start` requests that arrived, answered or not. */
  readonly turnStarts: number;
  /** The turn ids handed out, in order. */
  readonly turnIds: readonly string[];
  /** Every steer text the server was asked to apply, in order. */
  readonly steers: readonly string[];
  /** The `expectedTurnId` each steer named, in order. */
  readonly steerTurnIds: readonly string[];
  /** Which Run each steer belonged to, so a leak between Runs is visible. */
  readonly steersByRun: ReadonlyMap<RunId, readonly string[]>;
  /** The most steers the server ever had unanswered at once. */
  readonly maxConcurrentSteers: number;
  /** Client-bound requests issued, and how many were answered. */
  readonly serverRequests: number;
  readonly serverRequestAnswers: number;
  /** Whether the thread was started with the fixed posture. */
  readonly threadParameters: Record<string, unknown> | undefined;
}

/**
 * How the stand-in answers a `turn/steer`.
 *
 * `accept-silently` is the one worth naming: the server took the guidance and
 * never echoed a user-message item for it. That is the shape a Run must not
 * turn into a `user` observation, because nothing proved the model read it.
 */
export type CodexSteerPolicy = "accept" | "accept-silently" | "refuse" | "hang";

export interface CodexStandInOptions {
  /** One script per Turn, consumed in order. A Turn past the end holds. */
  readonly scripts?: readonly CodexTurnScript[];
  /** Make the spawn itself throw, which is how a missing binary looks. */
  readonly spawnFails?: boolean;
  /** Answer `initialize` with a result the adapter cannot read. */
  readonly malformedInitialize?: boolean;
  /** Never answer `initialize`. */
  readonly hangInitialize?: boolean;
  /** Never answer `thread/start`. */
  readonly hangThreadStart?: boolean;
  /** Answer `thread/start` with a JSON-RPC error. */
  readonly refuseThreadStart?: boolean;
  readonly rootId?: string;
  /** One policy per steer, consumed in order. The last one repeats. */
  readonly steerPolicies?: readonly CodexSteerPolicy[];
  /** Echo an accepted steer back as a user-message item carrying its id. */
  readonly echoSteer?: boolean;
  /** What `turn/interrupt` does, for every Turn. */
  readonly onInterrupt?: "complete" | "ignore";
  /**
   * What `turn/interrupt` does, one Turn at a time, consumed in order.
   *
   * Overrides {@link CodexStandInOptions.onInterrupt} while it lasts, and the
   * last entry repeats. A server that honours one interrupt and ignores the
   * next is the shape that catches an escalation armed once and never re-armed.
   */
  readonly interruptPolicies?: readonly ("complete" | "ignore")[];
  /** Stay alive through SIGTERM, so only SIGKILL ends it. */
  readonly ignoreSigterm?: boolean;
  /** Stay alive when stdin ends, so close has to escalate. */
  readonly ignoreStdinEnd?: boolean;
}

export interface CodexStandInAppServer {
  /** Inject this through the adapter's `spawn` option. */
  readonly spawn: CodexSpawn;
  readonly record: () => CodexStandInRecord;
  /** Continue a script that is holding. */
  readonly resume: () => void;
  /** Write one frame now, outside any script. */
  readonly write: (frame: CodexScriptFrame) => void;
  /** End the process now, as a spontaneous exit does. */
  readonly exitNow: (exit?: CodexProcessExit) => void;
  /** Whether the child is still running. */
  readonly alive: () => boolean;
  /** Told which Run is executing, so steers can be attributed. */
  readonly beginRun: (runId: RunId) => void;
  readonly endRun: () => void;
}

interface StandInState {
  turnIndex: number;
  activeTurnId?: string;
  pendingFrames: CodexScriptFrame[];
  holding: boolean;
  /** The script is waiting for guidance rather than for the test. */
  awaitingSteer: boolean;
}

function breakdown(partial: Partial<CodexTokenBreakdown>): CodexTokenBreakdown {
  return {
    totalTokens: partial.totalTokens ?? 0,
    inputTokens: partial.inputTokens ?? 0,
    cachedInputTokens: partial.cachedInputTokens ?? 0,
    cacheWriteInputTokens: partial.cacheWriteInputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    reasoningOutputTokens: partial.reasoningOutputTokens ?? 0,
  };
}

/** The wire shape of one scripted item. */
function itemPayload(item: CodexScriptItem): Record<string, unknown> {
  switch (item.kind) {
    case "agentMessage":
      return {
        type: "agentMessage",
        id: item.id,
        text: item.text,
        ...(item.phase === undefined ? {} : { phase: item.phase }),
      };
    case "command":
      return {
        type: "commandExecution",
        id: item.id,
        command: item.command,
        cwd: "/work",
        status: item.status ?? "inProgress",
        aggregatedOutput: item.output ?? null,
        exitCode: null,
        durationMs: null,
        commandActions: [],
      };
    case "fileChange":
      return {
        type: "fileChange",
        id: item.id,
        status: "completed",
        changes: [{ path: item.path, diff: "@@", kind: { type: "update" } }],
      };
    case "mcp":
      return {
        type: "mcpToolCall",
        id: item.id,
        server: item.server,
        tool: item.tool,
        status: "completed",
      };
    case "webSearch":
      return { type: "webSearch", id: item.id, query: item.query };
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        summary: [...(item.summary ?? [])],
        content: [],
      };
    case "plan":
      return { type: "plan", id: item.id, text: item.text };
    case "userMessage":
      return {
        type: "userMessage",
        id: item.id,
        ...(item.clientId === undefined ? {} : { clientId: item.clientId }),
        content:
          item.text === undefined ? [] : [{ type: "text", text: item.text }],
      };
    case "unread":
      // A real variant this adapter does not consume, so the frame about it is
      // ignored rather than reported as malformed.
      return { type: "todoList", id: item.id, items: [] };
  }
}

export function createStandInAppServer(
  options: CodexStandInOptions = {},
): CodexStandInAppServer {
  const scripts = options.scripts ?? [];
  const steerPolicies = options.steerPolicies ?? [];
  const echoSteer = options.echoSteer !== false;

  let spawns = 0;
  const requests: CodexSpawnRequest[] = [];
  const writes: CodexStandInWrite[] = [];
  const signals: CodexSignal[] = [];
  const turnIds: string[] = [];
  const steers: string[] = [];
  const steerTurnIds: string[] = [];
  const steersByRun = new Map<RunId, string[]>();
  let concurrentSteers = 0;
  let maxConcurrentSteers = 0;
  let serverRequests = 0;
  let serverRequestAnswers = 0;
  let threadParameters: Record<string, unknown> | undefined;
  let stdinEnded = false;
  let exit: CodexProcessExit | undefined;
  let activeRun: RunId | undefined;
  let steerIndex = 0;
  let interruptIndex = 0;
  let nextServerRequestId = 9000;

  let turnStarts = 0;
  const state: StandInState = {
    turnIndex: 0,
    pendingFrames: [],
    holding: false,
    awaitingSteer: false,
  };

  let onStdout: ((chunk: string) => void) | undefined;
  let onStderr: ((chunk: string) => void) | undefined;
  let onExit: ((exit: CodexProcessExit) => void) | undefined;
  let inbound = "";
  let paused = false;
  const held: string[] = [];

  const emitLine = (line: string): void => {
    if (exit !== undefined) return;
    if (paused) {
      held.push(line);
      return;
    }
    onStdout?.(line);
  };

  const emit = (value: Record<string, unknown>): void => {
    emitLine(`${JSON.stringify(value)}\n`);
  };

  const notify = (method: string, params: Record<string, unknown>): void => {
    emit({ method, params });
  };

  const finish = (next: CodexProcessExit): void => {
    if (exit !== undefined) return;
    exit = next;
    state.pendingFrames = [];
    onExit?.(next);
  };

  const respond = (id: number, result: unknown): void => {
    emit({ jsonrpc: "2.0", id, result });
  };

  const refuse = (id: number, message: string): void => {
    emit({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  };

  const writeFrame = (frame: CodexScriptFrame): void => {
    const turnId = state.activeTurnId ?? "turn-unnamed";
    switch (frame.frame) {
      case "item-started":
        notify("item/started", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId,
          item: itemPayload(frame.item),
          startedAtMs: 1,
        });
        return;
      case "item-completed":
        notify("item/completed", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId,
          item: itemPayload(frame.item),
          completedAtMs: 2,
        });
        return;
      case "for-turn":
        notify("item/completed", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId: frame.turnId,
          item: itemPayload(frame.item),
          completedAtMs: 2,
        });
        return;
      case "message-delta":
        notify("item/agentMessage/delta", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId,
          itemId: frame.itemId,
          delta: frame.delta,
        });
        return;
      case "output-delta":
        notify("item/commandExecution/outputDelta", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId,
          itemId: frame.itemId,
          delta: frame.delta,
        });
        return;
      case "reasoning-delta":
        notify("item/reasoning/summaryTextDelta", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId,
          itemId: frame.itemId,
          delta: frame.delta,
          summaryIndex: 0,
        });
        return;
      case "usage":
        notify("thread/tokenUsage/updated", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId,
          tokenUsage: {
            total: breakdown(frame.total),
            last: breakdown(frame.last ?? frame.total),
            modelContextWindow: frame.window ?? null,
          },
        });
        return;
      case "error":
        notify("error", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turnId,
          willRetry: frame.willRetry === true,
          error: { message: frame.message },
        });
        return;
      case "completed":
        notify("turn/completed", {
          threadId: options.rootId ?? CODEX_STAND_IN_ROOT,
          turn: {
            id: turnId,
            status: frame.status ?? "completed",
            items: [],
            error:
              frame.errorMessage === undefined
                ? null
                : { message: frame.errorMessage },
          },
        });
        return;
      case "server-request": {
        serverRequests += 1;
        const id = nextServerRequestId;
        nextServerRequestId += 1;
        emit({ jsonrpc: "2.0", id, method: frame.method, params: {} });
        return;
      }
      case "stderr":
        if (exit === undefined) onStderr?.(frame.text);
        return;
      case "raw":
        emitLine(`${frame.line}\n`);
        return;
      case "partial-line":
        emitLine(frame.text);
        return;
      case "oversized":
        // No newline: the adapter's framing bound is what has to end it.
        emitLine("x".repeat(frame.length));
        return;
      case "exit":
        finish({ code: frame.code ?? null, signal: frame.signal ?? null });
        return;
      case "hold":
        state.holding = true;
        return;
      case "await-steer":
        state.awaitingSteer = true;
        return;
    }
  };

  const drainScript = (): void => {
    while (
      !state.holding &&
      !state.awaitingSteer &&
      state.pendingFrames.length > 0
    ) {
      const next = state.pendingFrames.shift();
      if (next === undefined) return;
      writeFrame(next);
      if (exit !== undefined) return;
    }
  };

  const resume = (): void => {
    state.holding = false;
    drainScript();
  };

  /** Let a script waiting on guidance carry on, now that it has arrived. */
  const releaseSteerGate = (): void => {
    if (!state.awaitingSteer) return;
    state.awaitingSteer = false;
    drainScript();
  };

  const nextInterruptPolicy = (): "complete" | "ignore" => {
    const scripted = options.interruptPolicies;
    if (scripted === undefined || scripted.length === 0) {
      return options.onInterrupt ?? "complete";
    }
    const chosen =
      scripted[Math.min(interruptIndex, scripted.length - 1)] ?? "complete";
    interruptIndex += 1;
    return chosen;
  };

  const nextSteerPolicy = (): CodexSteerPolicy => {
    if (steerPolicies.length === 0) return "accept";
    const chosen =
      steerPolicies[Math.min(steerIndex, steerPolicies.length - 1)] ?? "accept";
    steerIndex += 1;
    return chosen;
  };

  const handleTurnStart = (id: number): void => {
    turnStarts += 1;
    const script = scripts[state.turnIndex];
    state.turnIndex += 1;
    if (script?.hangStart === true) return;
    if (script?.refuseStart === true) {
      refuse(id, "turn/start refused by the stand-in");
      return;
    }
    const turnId = script?.turnId ?? `turn-${state.turnIndex}`;
    state.activeTurnId = turnId;
    turnIds.push(turnId);
    if (script?.malformedStart === true) {
      respond(id, { turn: {} });
      return;
    }
    respond(id, { turn: { id: turnId } });
    state.pendingFrames = [...(script?.frames ?? [])];
    state.holding = false;
    state.awaitingSteer = false;
    drainScript();
  };

  const handleSteer = (id: number, params: Record<string, unknown>): void => {
    const input = Array.isArray(params.input) ? params.input : [];
    const first = input[0];
    const text =
      typeof first === "object" &&
      first !== null &&
      typeof (first as Record<string, unknown>).text === "string"
        ? ((first as Record<string, unknown>).text as string)
        : "";
    const clientId = params.clientUserMessageId;
    steers.push(text);
    steerTurnIds.push(
      typeof params.expectedTurnId === "string" ? params.expectedTurnId : "",
    );
    if (activeRun !== undefined) {
      const forRun = steersByRun.get(activeRun) ?? [];
      forRun.push(text);
      steersByRun.set(activeRun, forRun);
    }
    concurrentSteers += 1;
    maxConcurrentSteers = Math.max(maxConcurrentSteers, concurrentSteers);
    const policy = nextSteerPolicy();
    if (policy === "hang") return;
    concurrentSteers -= 1;
    if (policy === "refuse") {
      refuse(id, "turn/steer refused by the stand-in");
      releaseSteerGate();
      return;
    }
    respond(id, { turnId: state.activeTurnId ?? null });
    if (
      echoSteer &&
      policy !== "accept-silently" &&
      typeof clientId === "string"
    ) {
      writeFrame({
        frame: "item-completed",
        item: {
          kind: "userMessage",
          id: `user-${clientId}`,
          clientId,
          text,
        },
      });
    }
    releaseSteerGate();
  };

  const handleLine = (line: string): void => {
    if (line.trim() === "") return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      writes.push({ raw: line });
      return;
    }
    const method = typeof value.method === "string" ? value.method : undefined;
    const id = typeof value.id === "number" ? value.id : undefined;
    const params =
      typeof value.params === "object" &&
      value.params !== null &&
      !Array.isArray(value.params)
        ? (value.params as Record<string, unknown>)
        : undefined;
    const error =
      typeof value.error === "object" &&
      value.error !== null &&
      !Array.isArray(value.error)
        ? (value.error as Record<string, unknown>)
        : undefined;
    writes.push({
      raw: line,
      ...(method === undefined ? {} : { method }),
      ...(id === undefined ? {} : { id }),
      ...(params === undefined ? {} : { params }),
      ...(error === undefined ? {} : { error }),
    });
    // A response to a client-bound request, which is the one thing the
    // adapter writes with an id and no method.
    if (method === undefined) {
      if (error !== undefined) serverRequestAnswers += 1;
      return;
    }
    if (id === undefined) return;
    switch (method) {
      case "initialize":
        if (options.hangInitialize === true) return;
        respond(
          id,
          options.malformedInitialize === true
            ? { userAgent: "stand-in" }
            : {
                userAgent: "stand-in",
                codexHome: "/codex",
                platformFamily: "unix",
                platformOs: "darwin",
              },
        );
        return;
      case "thread/start":
        if (options.hangThreadStart === true) return;
        threadParameters = params;
        if (options.refuseThreadStart === true) {
          refuse(id, "thread/start refused by the stand-in");
          return;
        }
        respond(id, {
          thread: { id: options.rootId ?? CODEX_STAND_IN_ROOT },
        });
        return;
      case "turn/start":
        handleTurnStart(id);
        return;
      case "turn/steer":
        handleSteer(id, params ?? {});
        return;
      case "turn/interrupt":
        respond(id, {});
        if (nextInterruptPolicy() === "ignore") return;
        writeFrame({ frame: "completed", status: "interrupted" });
        return;
      default:
        refuse(id, `the stand-in does not implement ${method}`);
    }
  };

  const readStdin = (chunk: string): void => {
    if (exit !== undefined) return;
    inbound += chunk;
    for (;;) {
      const newline = inbound.indexOf("\n");
      if (newline < 0) return;
      const line = inbound.slice(0, newline);
      inbound = inbound.slice(newline + 1);
      handleLine(line);
      if (exit !== undefined) return;
    }
  };

  const child: CodexChildProcess = {
    pid: 4242,
    write: (line) => {
      if (exit !== undefined || stdinEnded) return false;
      readStdin(line);
      return true;
    },
    endStdin: () => {
      if (stdinEnded) return;
      stdinEnded = true;
      // A real App Server exits when its stdin closes; the spike measured it
      // at 13 ms with exit code 0. A stand-in that is asked to ignore that is
      // how the close escalation gets exercised.
      if (options.ignoreStdinEnd !== true) finish({ code: 0, signal: null });
    },
    kill: (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL" || options.ignoreSigterm !== true) {
        finish({ code: null, signal });
      }
    },
    onStdout: (listener) => {
      onStdout = listener;
    },
    onStderr: (listener) => {
      onStderr = listener;
    },
    onExit: (listener) => {
      onExit = listener;
      if (exit !== undefined) listener(exit);
    },
    pauseStdout: () => {
      paused = true;
    },
    resumeStdout: () => {
      paused = false;
      for (const line of held.splice(0)) onStdout?.(line);
    },
  };

  return {
    spawn: (request) => {
      spawns += 1;
      requests.push(request);
      if (options.spawnFails === true) {
        throw new Error("the stand-in App Server refused to start");
      }
      return child;
    },
    record: () => ({
      spawns,
      requests: [...requests],
      writes: [...writes],
      methods: writes
        .map((entry) => entry.method)
        .filter((method): method is string => method !== undefined),
      signals: [...signals],
      stdinEnded,
      exit,
      turns: turnIds.length,
      turnStarts,
      turnIds: [...turnIds],
      steers: [...steers],
      steerTurnIds: [...steerTurnIds],
      steersByRun: new Map(
        [...steersByRun].map(([runId, texts]) => [runId, [...texts]]),
      ),
      maxConcurrentSteers,
      serverRequests,
      serverRequestAnswers,
      threadParameters,
    }),
    resume,
    write: writeFrame,
    exitNow: (next) => finish(next ?? { code: null, signal: "SIGKILL" }),
    alive: () => exit === undefined,
    beginRun: (runId) => {
      activeRun = runId;
    },
    endRun: () => {
      activeRun = undefined;
    },
  };
}
