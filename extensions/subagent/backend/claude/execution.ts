/**
 * One Run, executed as one streaming Claude Query.
 *
 * Claude is the backend the contract was shaped around and the one that tests
 * it hardest, and four things about this file are consequences of that rather
 * than choices:
 *
 * - **A result frame is a Turn boundary, not settlement.** Steering enters the
 *   Query through its own input stream, and the provider answers each turn
 *   with a `result` frame. So a Run with guidance still outstanding is *not*
 *   over when a result arrives: it stays active, the next Control goes in, and
 *   the Run settles on the result that finds nothing outstanding. That is
 *   ADR-0018 meeting ADR-0025 — the execution decides when the Run is
 *   semantically complete, and the core still performs the terminal
 *   transition.
 * - **Confirmation requires provider evidence.** A Control that was admitted
 *   has been *accepted*, which is what the caller was told. It becomes a `user`
 *   observation only when the provider echoes the client's own uuid, or a
 *   result frame names that uuid as the turn it answered. A transcript showing
 *   guidance the model never saw is the one lie this seam must not tell.
 * - **The conversation identity is acquired here.** A Claude BackendAgent has
 *   no provider-side open: it begins holding nothing and acquires its identity
 *   from the first identity-bearing frame of its first Run. A missing,
 *   malformed, or *different* identity at that boundary fails the Run and
 *   marks the conversation lost — it never falls back to a fresh conversation,
 *   because a resumed Run silently answering from an empty context is worse
 *   than a resumed Run that says it could not attach.
 * - **A cancelled Run can legitimately end with nothing.** The spike aborted a
 *   Query 50 ms in and got no frames at all, not even the init frame. So this
 *   execution has to be able to settle with zero observations and leave the
 *   BackendAgent unopened, and the core has to be able to accept that.
 *
 * What this module never does is settle its own Run. It returns a bundle; the
 * core decides.
 */

import { Effect, Fiber, type Scope } from "effect";
import { failedEnding } from "../../domain/index.ts";
import type { ExecutionIO, RunInput, TerminalBundle } from "../contract.ts";
import {
  type ClaudeInput,
  claudeInputMessage,
  createClaudeInput,
} from "./input.ts";
import type { ClaudeProbeCounters } from "./probe.ts";
import type { ClaudeQuery, ClaudeQueryStream, Options } from "./query.ts";
import {
  CLAUDE_ATTACHMENT_FAILED_MESSAGE,
  type ClaudeRunReport,
  type ClaudeRunStep,
  createClaudeRunEvidence,
} from "./run-evidence.ts";
import {
  confined,
  createClaudeTranslator,
  isClaudeIdentity,
  readClaudeFrame,
} from "./translate.ts";

/** What a Run says when its BackendAgent was closed under it. */
export const CLOSED_BEFORE_EXECUTION_MESSAGE =
  "the Claude BackendAgent was closed before this Run could start";

/** What a fresh Run says when its init frame carries no usable identity. */
export const CLAUDE_FRESH_IDENTITY_FAILED_MESSAGE =
  "the Claude query reported no usable conversation identity";

/** What a Query that could not be started reports. */
export const QUERY_START_CATEGORY = "Claude query could not be started";

/**
 * How long silence may follow a Turn boundary with guidance outstanding.
 *
 * Provider time-to-first-frame is measured in seconds, so 30 seconds leaves
 * ordinary model startup room while still giving ADR-0025 a finite bound.
 */
export const TURN_BOUNDARY_WAIT_MILLIS = 30_000;

/** What the SDK's own stderr reports, without keeping a word of it. */
export const SDK_STDERR_CATEGORY = "the Claude SDK reported diagnostics";

/** The retained conversation, as the execution is allowed to see it. */
export interface ClaudeConversation {
  /** The retained identity, or nothing while the BackendAgent is unopened. */
  readonly retained: () => string | undefined;
  /** Retain the identity this Run's boundary frame carried. */
  readonly retain: (identity: string) => void;
  /** Mark the conversation lost. Monotonic: nothing moves back. */
  readonly lose: () => void;
  /** Whether the BackendAgent has been closed. */
  readonly isClosed: () => boolean;
  /** Register for the BackendAgent's close, and unregister. */
  readonly onClose: (listener: () => void) => () => void;
}

/** What one Run's Query options are built from, beyond the fixed policy. */
export interface ClaudeRunOptions {
  readonly abort: NonNullable<Options["abortController"]>;
  readonly resume?: string;
  readonly stderr: (data: string) => void;
}

export interface ClaudeExecutionContext {
  readonly query: ClaudeQuery;
  readonly conversation: ClaudeConversation;
  readonly buildOptions: (run: ClaudeRunOptions) => Options;
  readonly probe: ClaudeProbeCounters;
}

export function runClaudeExecution(
  context: ClaudeExecutionContext,
  input: RunInput,
  io: ExecutionIO,
): Effect.Effect<TerminalBundle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { conversation, probe } = context;
    if (conversation.isClosed()) {
      return { ending: failedEnding(CLOSED_BEFORE_EXECUTION_MESSAGE) };
    }

    const resumed = conversation.retained();
    const translator = createClaudeTranslator();
    /** Woken when the fold says the one provider-visible Control slot freed. */
    const slotWaiters: (() => void)[] = [];

    let identity = resumed;
    let attached = resumed === undefined;
    let sawStderr = false;

    /* ---- the input stream, and the Query, as scoped resources ---- */

    const stream = yield* Effect.acquireRelease(
      Effect.sync((): ClaudeInput => {
        probe.acquired("openInputs");
        return createClaudeInput();
      }),
      (open) =>
        Effect.sync(() => {
          open.close();
          probe.released("openInputs");
        }),
    );

    const promptUuid = globalThis.crypto.randomUUID();
    const evidence = createClaudeRunEvidence({
      promptUuid,
      resumed: resumed !== undefined,
      translator,
    });
    stream.push(claudeInputMessage(input.prompt, promptUuid));

    // The execution owns the controller, which is what makes "the Query cannot
    // outlive the Run" true: the finalizer aborts it whether the Run answered,
    // failed, or was interrupted. The BackendAgent's close is linked to it so
    // that closing a Subagent stops a Query the core has not interrupted yet.
    const abort = new AbortController();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        conversation.onClose(() => {
          abort.abort();
          stream.close();
        }),
      ),
      (unregister) =>
        Effect.sync(() => {
          abort.abort();
          unregister();
        }),
    );

    const started = yield* Effect.acquireRelease(
      Effect.sync(
        ():
          | { readonly outcome: "started"; readonly query: ClaudeQueryStream }
          | { readonly outcome: "failed" } => {
          try {
            const query = context.query({
              prompt: stream,
              options: context.buildOptions({
                abort,
                ...(resumed === undefined ? {} : { resume: resumed }),
                stderr: (data) => {
                  // Only *whether* the SDK said something is kept. The text is
                  // provider-authored and stays here, unread.
                  sawStderr ||= typeof data === "string" && data.length > 0;
                },
              }),
            });
            probe.acquired("liveQueries");
            return { outcome: "started", query };
          } catch {
            // The provider's own text stops here. See the module comment.
            return { outcome: "failed" };
          }
        },
      ),
      (open) =>
        Effect.sync(() => {
          if (open.outcome !== "started") return;
          try {
            open.query.close();
          } catch {
            // The ordered semantic outcome stays authoritative over cleanup.
          }
          probe.released("liveQueries");
        }),
    );

    /**
     * Report that the SDK wrote to stderr, once, whatever ends the Run.
     *
     * The flag is cleared as it is reported, because both the return path and
     * the interrupt handler call this: an interruption landing between the
     * emit and the return would otherwise put the same diagnostic on the Run
     * twice.
     */
    const emitStderrOnce = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!sawStderr) return;
        sawStderr = false;
        yield* io.emit({
          kind: "diagnostic",
          diagnostic: confined(SDK_STDERR_CATEGORY),
        });
      });

    const withStderr = (
      bundle: TerminalBundle,
    ): Effect.Effect<TerminalBundle> =>
      Effect.gen(function* () {
        yield* emitStderrOnce();
        return bundle;
      });

    /**
     * The one shutdown ritual for the client-owned input. The fold has already
     * stopped acceptance, discarded outstanding guidance, and freed its slot
     * before it reports `inputClosed`; execution only performs the resource
     * effects and wakes the consumer that may be waiting on that slot.
     */
    const shutdownInput = (): void => {
      for (const wake of slotWaiters.splice(0)) wake();
      stream.close();
    };

    /** Publish one synchronous fold report in its declared order. */
    const applyReport = (report: ClaudeRunReport): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const observation of report.observations) {
          yield* io.emit(observation);
        }
        if (evidence.controlSlotFree()) {
          for (const wake of slotWaiters.splice(0)) wake();
        }
        if (!report.inputClosed) return;
        shutdownInput();
        if (report.next.step === "decided") {
          yield* io.recordDecision(report.next.bundle);
        }
      });

    /**
     * Execution feeds terminal facts only at terminal call sites. Keep that
     * fold/driver invariant and its defensive assertion in one place.
     */
    const terminalBundleFrom = (report: ClaudeRunReport): TerminalBundle => {
      if (report.next.step === "decided" || report.next.step === "fatal") {
        return report.next.bundle;
      }
      throw new Error(
        `Claude Run evidence returned '${report.next.step}' for a terminal reading`,
      );
    };

    const applyTerminalReport = (
      report: ClaudeRunReport,
    ): Effect.Effect<TerminalBundle> =>
      Effect.gen(function* () {
        yield* applyReport(report);
        return terminalBundleFrom(report);
      });

    /** Identity remains execution evidence in this ticket's slice. */
    const failIdentity = (): Effect.Effect<TerminalBundle> => {
      conversation.lose();
      return applyTerminalReport(
        evidence.read({
          kind: "external-fatal",
          bundle: {
            ending: failedEnding(
              resumed === undefined
                ? CLAUDE_FRESH_IDENTITY_FAILED_MESSAGE
                : CLAUDE_ATTACHMENT_FAILED_MESSAGE,
            ),
          },
        }),
      );
    };

    if (started.outcome !== "started") {
      if (resumed !== undefined) conversation.lose();
      const diagnostic = confined(QUERY_START_CATEGORY);
      const report = evidence.read({
        kind: "external-fatal",
        observations: [{ kind: "diagnostic", diagnostic }],
        bundle: {
          ending: failedEnding(
            resumed === undefined
              ? diagnostic.message
              : CLAUDE_ATTACHMENT_FAILED_MESSAGE,
          ),
        },
      });
      const bundle = yield* applyTerminalReport(report);
      return yield* withStderr(bundle);
    }

    /* ---- steering: one Control provider-visible at a time ---- */

    /**
     * Take one Control at a time, and only when one can actually be pushed.
     * The mailbox remains the one bounded queue; the fold owns only the single
     * provider-visible slot.
     */
    const steerLoop = Effect.gen(function* () {
      for (;;) {
        while (
          !evidence.controlSlotFree() &&
          evidence.takenControlProducesAnything()
        ) {
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                slotWaiters.push(resolve);
              }),
          );
        }
        const control = yield* io.controls.take;
        if (control === undefined) return;
        if (
          !evidence.takenControlProducesAnything() ||
          conversation.isClosed()
        ) {
          // The Run is settling. A Control taken now produces nothing at all.
          continue;
        }
        const uuid = globalThis.crypto.randomUUID();
        // `later` lets the provider finish its current turn before guidance.
        if (!stream.push(claudeInputMessage(control.text, uuid, "later"))) {
          yield* applyReport(evidence.read({ kind: "control-refused" }));
          continue;
        }
        yield* applyReport(
          evidence.read({
            kind: "control-visible",
            text: control.text,
            uuid,
          }),
        );
      }
    });

    /* ---- the frame loop ---- */

    const frames = started.query[Symbol.asyncIterator]();

    /** One frame, or the end of the stream, or the exception that ended it. */
    const nextFrame = Effect.promise(
      (): Promise<
        | { readonly step: "frame"; readonly frame: unknown }
        | { readonly step: "done" }
        | { readonly step: "threw" }
      > =>
        frames.next().then(
          (result) =>
            result.done === true
              ? ({ step: "done" } as const)
              : ({ step: "frame", frame: result.value } as const),
          () => ({ step: "threw" }) as const,
        ),
    );

    const body = Effect.gen(function* () {
      const steering = yield* Effect.forkChild(steerLoop);
      const drive = Effect.gen(function* () {
        let next: ClaudeRunStep = { step: "continue" };
        for (;;) {
          const frame =
            next.step === "await-turn-boundary"
              ? yield* Effect.timeout(
                  nextFrame,
                  TURN_BOUNDARY_WAIT_MILLIS,
                ).pipe(
                  Effect.match({
                    onFailure: () => ({ step: "timeout" }) as const,
                    onSuccess: (read) => read,
                  }),
                )
              : yield* nextFrame;

          if (frame.step === "timeout") {
            return yield* applyTerminalReport(
              evidence.read({ kind: "turn-boundary-timeout" }),
            );
          }
          if (frame.step === "done") {
            return yield* applyTerminalReport(
              evidence.read({ kind: "query-ended" }),
            );
          }
          if (frame.step === "threw") {
            if (next.step !== "decided" && resumed !== undefined) {
              // A resumed Query that died before deciding is a failed
              // attachment however far it got.
              conversation.lose();
            }
            return yield* applyTerminalReport(
              evidence.read({ kind: "query-threw" }),
            );
          }

          // Once decided, only drain the Query so it can wind down gracefully.
          if (next.step === "decided") continue;

          const reading = readClaudeFrame(frame.frame);
          // Identity attachment and replay dropping remain execution evidence
          // in this slice; the fold receives only frames this Run owns.
          if (reading.isReplay) continue;
          if (!attached && !reading.isIdentityBoundary) continue;

          if (reading.isIdentityBoundary) {
            if (
              !isClaudeIdentity(reading.identity) ||
              (identity !== undefined && reading.identity !== identity)
            ) {
              return yield* failIdentity();
            }
            identity ??= reading.identity;
            attached = true;
            conversation.retain(reading.identity);
          } else if (
            reading.identity !== undefined &&
            (!isClaudeIdentity(reading.identity) ||
              (identity !== undefined && reading.identity !== identity))
          ) {
            return yield* failIdentity();
          }

          const report = evidence.read({ kind: "frame", frame: reading });
          yield* applyReport(report);
          next = report.next;
          if (next.step === "fatal") return next.bundle;
        }
      });

      const bundle = yield* drive;
      yield* Fiber.interrupt(steering);
      return yield* withStderr(bundle);
    });

    // The decision was frozen synchronously at the Turn boundary. Interruption
    // has no terminal ceremony left: it may only preserve the SDK's once-only
    // stderr diagnostic before the core arbitrates the recorded decision and
    // the stop request.
    return yield* Effect.onInterrupt(body, () => emitStderrOnce());
  });
}
