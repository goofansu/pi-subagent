/**
 * The seven model tools, registered once per process.
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
 * The two waits are the handlers with real mechanism in them, and the
 * mechanism is the point twice over. Operation semantics section 6 says
 * aborting the calling turn ends *only that wait*, so the host bridges Pi's
 * abort signal to the interruption of the wait fiber and to nothing else; see
 * {@link whenAborted}. And a wait delivers the Result it waited for
 * ([ADR-0036](../../../docs/adr/0036-a-wait-delivers-the-result-it-waited-for.md)),
 * so before it starts waiting it tells the host to hold those Runs' notices,
 * and when it returns it records each delivered Result as consumed and
 * releases the hold; see {@link collected}. The hold is an Effect resource,
 * so runtime disposal finalizes it before the Session is gone.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { SubagentsServices, ToolResponse } from "../application/index.ts";
import { type SessionFacts, Subagents } from "../application/index.ts";
import { type RunId, runId } from "../domain/index.ts";
import {
  formatSessionNotReady,
  isCollectedRuns,
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
  WAIT_ALL_COPY,
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
  WaitAllInputSchema,
  WaitInputSchema,
} from "./tool-schemas.ts";

/** Every tool name this extension registers, in registration order. */
export const SUBAGENT_TOOL_NAMES = [
  START_COPY.name,
  RESUME_COPY.name,
  WAIT_COPY.name,
  WAIT_ALL_COPY.name,
  RESULT_COPY.name,
  CANCEL_COPY.name,
  STEER_COPY.name,
] as const;

/**
 * What the host is told about a Result changing hands.
 *
 * Two narrow functions rather than the push sink itself, exactly as the widget
 * is handed a read model rather than the sink: a handler that could name the
 * sink could push a notification, and then two things would decide what the
 * model is told. `consumed` says the parent now has this Run's Result; `hold`
 * says the parent is about to wait on these Runs and their notices are to be
 * kept back until the returned release is called.
 * [ADR-0035](../../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)
 * decided consumption;
 * [ADR-0036](../../../docs/adr/0036-a-wait-delivers-the-result-it-waited-for.md)
 * decided the hold.
 */
export interface ResultHandoff {
  readonly consumed: (id: RunId) => void;
  readonly hold: (scope: readonly RunId[] | "all") => () => void;
}

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
 * The Runs whose Result a response delivered.
 *
 * `Subagents.result` answers `{ text, details: { runs: [summary] } }` only for
 * a Result it actually returned, and the two waits list in `runs` exactly the
 * Runs whose Result rode back on the outcome; every rejection, every
 * still-running entry, and every evicted output answers outside that list. So
 * the handler can recognise a delivered Result without the application
 * learning that a host surface exists, which is the whole reason consumption
 * is recorded here.
 *
 * Read through `isCollectedRuns`, the presentation guard the collapsed line
 * already uses, rather than through a cast: the shape is `CollectedRuns` and
 * saying so is what makes a change to it a compile error here instead of a
 * silently missing consumption.
 */
function deliveredRuns(response: ToolResponse): readonly RunId[] {
  const { details } = response;
  if (!isCollectedRuns(details)) return [];
  return details.runs.map((run) => runId(run.runId));
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
 * Register the seven tools against one session handle.
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
   * Tell the host that a Result changed hands. See {@link ResultHandoff}.
   *
   * Called from the `agent_result` handler and the two wait handlers, and
   * from nowhere else — not from the façade, which would make the application
   * aware that a host surface exists, and not from the store, which delivery
   * and diagnostics also read.
   */
  handoff: ResultHandoff,
): void {
  /** What every handler answers with when there is no live runtime. */
  const notReady = (copy: ToolCopy): ToolResponse => ({
    text: formatSessionNotReady(copy.name),
  });

  /**
   * Run a wait and hand its delivered Results over.
   *
   * The hold goes on *before* the wait begins, because delivery pushes at the
   * same instant the waiter is woken and a notice already in Pi's queue
   * cannot be taken back. Consumption is recorded *before* the hold is
   * released, so the release finds every delivered Run consumed and drops its
   * notice rather than sending it. The hold is acquired and released inside
   * the runtime as a scoped Effect resource. Its finalizer therefore runs on
   * success, timeout, abort-interruption, and runtime disposal, before disposal
   * resolves and the Session is considered gone.
   *
   * The abort bridge is here too, and it is the same for both waits: a turn
   * that was aborted still gets an answer, and it is the answer a timeout
   * gives — the ids that are still running. `raceFirst` interrupts the loser,
   * so the abort ends this wait and nothing else; every Run keeps going,
   * settles once, stores its result, and its completion is delivered.
   */
  const collected = async (
    copy: ToolCopy,
    scope: readonly RunId[] | "all",
    waiting: Effect.Effect<ToolResponse, never, SubagentsServices>,
    answerNow: Effect.Effect<ToolResponse, never, SubagentsServices>,
    signal: AbortSignal | undefined,
  ): Promise<HostToolResult> => {
    const work =
      signal === undefined
        ? waiting
        : Effect.raceFirst(
            waiting,
            Effect.flatMap(whenAborted(signal), () => answerNow),
          );
    const heldWork = Effect.scoped(
      Effect.flatMap(
        Effect.acquireRelease(
          Effect.sync(() => handoff.hold(scope)),
          (release) => Effect.sync(release),
        ),
        () =>
          Effect.tap(work, (response) =>
            Effect.sync(() => {
              for (const id of deliveredRuns(response)) handoff.consumed(id);
            }),
          ),
      ),
    );
    return hostResult(await handle.run(heldWork, notReady(copy)));
  };

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
      return collected(
        WAIT_COPY,
        input.value.ids,
        Subagents.wait(input.value),
        Subagents.wait({ ...input.value, timeoutSeconds: 0 }),
        signal,
      );
    },
  });

  /* ---------------------------------------------------------------- */
  /* agent_wait_all                                                   */
  /* ---------------------------------------------------------------- */

  const decodeWaitAll = decodeToolInput(WAIT_ALL_COPY.name, WaitAllInputSchema);

  register(WAIT_ALL_COPY, toolParameters(WaitAllInputSchema), {
    renderResult: renderCollectedResult,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ): Promise<HostToolResult> {
      const input = decodeWaitAll(params);
      if (!input.decoded) return hostResult({ text: input.text });
      // The ids this wait covers are read off the index inside the façade, so
      // the hold has to cover every Run: a hold on a list the handler does not
      // yet have would be a hold on nothing.
      return collected(
        WAIT_ALL_COPY,
        "all",
        Subagents.waitAll(input.value),
        Subagents.waitAll({ ...input.value, timeoutSeconds: 0 }),
        signal,
      );
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
      for (const id of deliveredRuns(response)) handoff.consumed(id);
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
