/**
 * The six model tools, registered once per process.
 *
 * Each handler does four things and nothing else: read the Session facts from
 * the live context, decode its input, call the façade through the session
 * handle, and hand back text plus details. There is no lifecycle here, no
 * prose, and no service lookup — a handler that did any of those would be the
 * v1 dispatcher again.
 *
 * Registration happens once because Pi's tool registry is per-process. Every
 * handler therefore closes over the {@link SessionHandle} rather than over a
 * Session, and a call that arrives with no live runtime is answered rather
 * than thrown.
 *
 * `agent_wait` is the one handler with real mechanism in it, and the mechanism
 * is the point: operation semantics section 6 says aborting the calling turn
 * ends *only that wait*, so the host bridges Pi's abort signal to the
 * interruption of the wait fiber and to nothing else. See {@link whenAborted}.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { ToolResponse } from "../application/index.ts";
import { type SessionFacts, Subagents } from "../application/index.ts";
import { type RunId, runId } from "../domain/index.ts";
import {
  formatSessionNotReady,
  renderCollectedResult,
  renderResumeResult,
  renderStartCall,
} from "../presentation/index.ts";
import type { SessionHandle } from "./session-handle.ts";
import {
  CANCEL_COPY,
  RESULT_COPY,
  RESUME_COPY,
  START_COPY,
  STEER_COPY,
  type ToolCopy,
  WAIT_COPY,
} from "./tool-copy.ts";
import {
  CancelInputSchema,
  decodeToolInput,
  ResultInputSchema,
  ResumeInputSchema,
  StartInputSchema,
  SteerInputSchema,
  toolParameters,
  WaitInputSchema,
} from "./tool-schemas.ts";

/** Every tool name this extension registers, in registration order. */
export const SUBAGENT_TOOL_NAMES = [
  START_COPY.name,
  RESUME_COPY.name,
  WAIT_COPY.name,
  RESULT_COPY.name,
  CANCEL_COPY.name,
  STEER_COPY.name,
] as const;

/** What Pi expects a tool's `execute` to return. */
interface HostToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: unknown;
}

function hostResult(response: ToolResponse): HostToolResult {
  return {
    content: [{ type: "text", text: response.text }],
    details: response.details,
  };
}

/**
 * The facts a Run inherits, read from the live Session at execute time.
 *
 * Read now rather than at Session start, because the model and the thinking
 * level change during a Session and a Run should inherit what was true when it
 * was started. The working directory and the trust posture come from the same
 * context for the same reason.
 *
 * Child depth comes from the backend set, because only a backend knows how a
 * child of *its* processes reports its nesting. Until M4 this was a constant
 * zero, which made delegation depth a rule nothing enforced; reading it here
 * is what turns `delegation-depth exceeded` into an outcome admission can
 * actually reach.
 */
function sessionFactsOf(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: ExtensionContext,
  childDepth: () => number,
): SessionFacts {
  return {
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    // A Run this Session starts is one level deeper than the Session itself.
    childDepth: childDepth() + 1,
    ...(ctx.model === undefined
      ? {}
      : {
          parentModel: {
            provider: ctx.model.provider,
            id: ctx.model.id,
            thinkingLevel: pi.getThinkingLevel(),
          },
        }),
  };
}

/**
 * The Run a response summarised, when it summarised exactly one.
 *
 * `Subagents.result` answers `{ text, details: { runs: [summary] } }` only for
 * a Result it actually returned; every rejection answers with text alone. So
 * the handler can recognise success without the application learning that a
 * host surface exists, which is the whole reason consumption is recorded here.
 */
function summarisedRun(response: ToolResponse): RunId | undefined {
  const details = response.details as
    | { readonly runs?: readonly { readonly runId?: string }[] }
    | undefined;
  const runs = details?.runs;
  if (runs?.length !== 1) return undefined;
  const only = runs[0]?.runId;
  return only === undefined ? undefined : runId(only);
}

/**
 * An Effect that succeeds when the host's signal aborts, and never otherwise.
 *
 * This is the only place in v2 that touches an abort signal, and the boundary
 * test says so. It exists because Pi hands a handler a signal and Effect
 * expresses cancellation as interruption: something has to translate, and the
 * host boundary is where a Pi callback crosses into Effect.
 */
function whenAborted(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = (): void => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    // Returned rather than left attached: an interrupted wait must not leave a
    // listener on the host's signal, which is the leak this milestone's probe
    // would not see because it is Pi's object rather than the runtime's.
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Register the six tools against one session handle.
 *
 * Split from the extension factory so a test can drive the handlers with a
 * stand-in host and no process state, which is how every host-level test in
 * this milestone works.
 */
export function registerSubagentTools(
  pi: Pick<ExtensionAPI, "registerTool" | "getThinkingLevel">,
  handle: SessionHandle,
  /**
   * The `agent_start` guidelines, which name the Profiles this Session loaded.
   *
   * A live array rather than a copy, and that is the whole reason it is a
   * parameter. Pi stores the `promptGuidelines` array it is given, and
   * registration happens once per process while the Profile catalog changes
   * with every Session — so the Session module rewrites this array's contents
   * in place and the tool's guidelines follow, with no re-registration.
   */
  agentGuidelines: string[],
  /**
   * How deep this process already is, as the backend set reports it.
   *
   * A function rather than a number, because it is read from the environment
   * and a test changes it between calls.
   */
  childDepth: () => number,
  /**
   * Tell the host that the parent has this Run's Result.
   *
   * One narrow function rather than the push sink itself, exactly as the
   * widget is handed a read model rather than the sink: a handler that could
   * name the sink could push a notification, and then two things would decide
   * what the model is told.
   *
   * It is called from the `agent_result` handler and from nowhere else — not
   * from `Subagents.result`, which would make the application aware that a
   * host surface exists, and not from the store, which delivery and
   * diagnostics also read.
   * [ADR-0035](../../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)
   * is the decision.
   */
  noteResultConsumed: (id: RunId) => void,
): void {
  /** What every handler answers with when there is no live runtime. */
  const notReady = (copy: ToolCopy): ToolResponse => ({
    text: formatSessionNotReady(copy.name),
  });

  const register = (
    copy: ToolCopy,
    parameters: ReturnType<typeof toolParameters>,
    extras: Record<string, unknown>,
  ): void => {
    // `registerTool` is typed against the host's own schema library, which v2
    // does not name. The document is what the host validates against at
    // runtime — it branches on a marker symbol and falls back to JSON Schema
    // when it is absent, which is exactly an Effect-emitted document.
    (pi.registerTool as unknown as (tool: Record<string, unknown>) => void)({
      name: copy.name,
      label: copy.label,
      description: copy.description,
      promptSnippet: copy.promptSnippet,
      ...(copy.promptGuidelines === undefined
        ? {}
        : { promptGuidelines: [...copy.promptGuidelines] }),
      parameters,
      ...extras,
    });
  };

  /* ---------------------------------------------------------------- */
  /* agent_start                                                      */
  /* ---------------------------------------------------------------- */

  const decodeStart = decodeToolInput(START_COPY.name, StartInputSchema);

  register(START_COPY, toolParameters(StartInputSchema), {
    // The array itself, not a copy: see `agentGuidelines` above.
    promptGuidelines: agentGuidelines,
    renderCall: renderStartCall,
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<HostToolResult> {
      const input = decodeStart(params);
      if (!input.decoded) return hostResult({ text: input.text });
      // Deliberately no signal. The turn's cancellation must not reach a
      // detached Run: the point of starting one is that it outlives the turn.
      return hostResult(
        await handle.run(
          Subagents.start(input.value, sessionFactsOf(pi, ctx, childDepth)),
          notReady(START_COPY),
        ),
      );
    },
  });

  /* ---------------------------------------------------------------- */
  /* agent_resume                                                     */
  /* ---------------------------------------------------------------- */

  const decodeResume = decodeToolInput(RESUME_COPY.name, ResumeInputSchema);

  register(RESUME_COPY, toolParameters(ResumeInputSchema), {
    renderResult: renderResumeResult,
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<HostToolResult> {
      const input = decodeResume(params);
      if (!input.decoded) return hostResult({ text: input.text });
      return hostResult(
        await handle.run(Subagents.resume(input.value), notReady(RESUME_COPY)),
      );
    },
  });

  /* ---------------------------------------------------------------- */
  /* agent_wait                                                       */
  /* ---------------------------------------------------------------- */

  const decodeWait = decodeToolInput(WAIT_COPY.name, WaitInputSchema);

  register(WAIT_COPY, toolParameters(WaitInputSchema), {
    renderResult: renderCollectedResult,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ): Promise<HostToolResult> {
      const input = decodeWait(params);
      if (!input.decoded) return hostResult({ text: input.text });
      const waiting = Subagents.wait(input.value);
      // A turn that was aborted still gets an answer, and it is the same
      // answer a timeout gives: the ids that are still running. `raceFirst`
      // interrupts the loser, so the abort ends this wait and nothing else —
      // every Run keeps going, settles once, stores its result, and notifies.
      const work =
        signal === undefined
          ? waiting
          : Effect.raceFirst(
              waiting,
              Effect.flatMap(whenAborted(signal), () =>
                Subagents.wait({ ...input.value, timeoutSeconds: 0 }),
              ),
            );
      return hostResult(await handle.run(work, notReady(WAIT_COPY)));
    },
  });

  /* ---------------------------------------------------------------- */
  /* agent_result                                                     */
  /* ---------------------------------------------------------------- */

  const decodeResult = decodeToolInput(RESULT_COPY.name, ResultInputSchema);

  register(RESULT_COPY, toolParameters(ResultInputSchema), {
    renderResult: renderCollectedResult,
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<HostToolResult> {
      const input = decodeResult(params);
      if (!input.decoded) return hostResult({ text: input.text });
      const response = await handle.run(
        Subagents.result(input.value),
        notReady(RESULT_COPY),
      );
      // The parent now has the answer, so its completion notice has nothing
      // left to tell it. Recognised by the shape the façade answers a
      // *returned Result* with and no other: every rejection — `not yet
      // terminal`, an unknown id, an expired Result — answers with text
      // alone. If that shape ever changes, the tools test for consumption is
      // what fails.
      const consumed = summarisedRun(response);
      if (consumed !== undefined) noteResultConsumed(consumed);
      return hostResult(response);
    },
  });

  /* ---------------------------------------------------------------- */
  /* agent_cancel                                                     */
  /* ---------------------------------------------------------------- */

  const decodeCancel = decodeToolInput(CANCEL_COPY.name, CancelInputSchema);

  register(CANCEL_COPY, toolParameters(CancelInputSchema), {
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<HostToolResult> {
      const input = decodeCancel(params);
      if (!input.decoded) return hostResult({ text: input.text });
      // Cancellation requests do not claim delivery: each Run still stores its
      // terminal result and still sends its own cancellation notification.
      return hostResult(
        await handle.run(Subagents.cancel(input.value), notReady(CANCEL_COPY)),
      );
    },
  });

  /* ---------------------------------------------------------------- */
  /* agent_steer                                                      */
  /* ---------------------------------------------------------------- */

  const decodeSteer = decodeToolInput(STEER_COPY.name, SteerInputSchema);

  register(STEER_COPY, toolParameters(SteerInputSchema), {
    renderResult: renderCollectedResult,
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<HostToolResult> {
      const input = decodeSteer(params);
      if (!input.decoded) return hostResult({ text: input.text });
      return hostResult(
        await handle.run(Subagents.steer(input.value), notReady(STEER_COPY)),
      );
    },
  });
}
