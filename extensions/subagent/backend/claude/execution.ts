/**
 * One Run's streaming Claude Query resources and I/O.
 *
 * This module owns only the client input stream, Query and abort lifetimes,
 * Control-feed waiting and pushing, bounded frame reads, and publication
 * through ExecutionIO. Claude Run evidence owns what every translated frame or
 * execution-witnessed fact means: identity and replay, confirmation and the
 * Control slot, Turn boundaries, terminal classification, and stderr
 * diagnostics. Execution follows the fold's next step and never settles the
 * Run; it reports a Terminal bundle for the core to arbitrate.
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
  type ClaudeRunReport,
  type ClaudeRunStep,
  createClaudeRunEvidence,
} from "./run-evidence.ts";
import { createClaudeTranslator, readClaudeFrame } from "./translate.ts";

/** What a Run says when its BackendAgent was closed under it. */
export const CLOSED_BEFORE_EXECUTION_MESSAGE =
  "the Claude BackendAgent was closed before this Run could start";

/**
 * How long silence may follow a Turn boundary with guidance outstanding.
 *
 * Provider time-to-first-frame is measured in seconds, so 30 seconds leaves
 * ordinary model startup room while still giving ADR-0025 a finite bound.
 */
export const TURN_BOUNDARY_WAIT_MILLIS = 30_000;

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
      ...(resumed === undefined ? {} : { retainedIdentity: resumed }),
      conversation,
      translator,
    });
    /** Fold output produced by the SDK's synchronous stderr callback. */
    const pendingSdkReports: ClaudeRunReport[] = [];
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
    const publishReport = (report: ClaudeRunReport): Effect.Effect<void> =>
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
     * Publish a report, then any stderr report produced while publication
     * yielded to ExecutionIO. No callback can interleave after the final empty
     * check without another yield, so a fatal return cannot strand evidence.
     */
    const applyReport = (report: ClaudeRunReport): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* publishReport(report);
        for (;;) {
          const pending = pendingSdkReports.shift();
          if (pending === undefined) return;
          yield* publishReport(pending);
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

    type QueryStart =
      | { readonly outcome: "started"; readonly query: ClaudeQueryStream }
      | { readonly outcome: "failed" };

    const acquireQuery = Effect.sync((): QueryStart => {
      try {
        const query = context.query({
          prompt: stream,
          options: context.buildOptions({
            abort,
            ...(resumed === undefined ? {} : { resume: resumed }),
            stderr: (data) => {
              // Provider-authored text stays unread. The fold retains only
              // the fact that the SDK wrote a non-empty diagnostic.
              if (typeof data === "string" && data.length > 0) {
                const report = evidence.read({ kind: "sdk-stderr" });
                if (report.observations.length > 0) {
                  pendingSdkReports.push(report);
                }
              }
            },
          }),
        });
        probe.acquired("liveQueries");
        return { outcome: "started", query };
      } catch {
        // The provider's own text stops here. See the module comment.
        return { outcome: "failed" };
      }
    });

    const releaseQuery = (open: QueryStart): Effect.Effect<void> =>
      Effect.sync(() => {
        if (open.outcome !== "started") return;
        try {
          open.query.close();
        } catch {
          // The ordered semantic outcome stays authoritative over cleanup.
        } finally {
          // Close can synchronously write stderr, so Query release precedes
          // the final fold drain. Keep abort beside close as the other half of
          // this execution-owned Query's cleanup.
          abort.abort();
        }
        probe.released("liveQueries");
      });

    const useQuery = (started: QueryStart): Effect.Effect<TerminalBundle> =>
      Effect.gen(function* () {
        if (started.outcome !== "started") {
          return yield* applyTerminalReport(
            evidence.read({ kind: "query-start-failed" }),
          );
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
          const drive = (next: ClaudeRunStep): Effect.Effect<TerminalBundle> =>
            Effect.gen(function* () {
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
                return yield* applyTerminalReport(
                  evidence.read({ kind: "query-threw" }),
                );
              }

              // Once decided, only drain the Query so it can wind down gracefully.
              if (next.step === "decided") {
                return yield* Effect.suspend(() => drive(next));
              }

              const report = evidence.read({
                kind: "frame",
                frame: readClaudeFrame(frame.frame),
              });
              yield* applyReport(report);
              if (report.next.step === "fatal") return report.next.bundle;
              return yield* Effect.suspend(() => drive(report.next));
            });

          const bundle = yield* drive({ step: "continue" });
          yield* Fiber.interrupt(steering);
          return bundle;
        });

        return yield* body;
      });

    const execution = Effect.acquireUseRelease(
      acquireQuery,
      useQuery,
      releaseQuery,
    );
    const drainFoldOutput = (): Effect.Effect<void> =>
      applyReport(evidence.read({ kind: "interrupted" }));

    // Query.close() is the last execution-owned opportunity for the SDK to
    // synchronously write to stderr. acquireUseRelease runs it before this
    // final fold drain on both return and interruption, so no callback can
    // leave once-only diagnostic output stranded in execution.
    return yield* Effect.onInterrupt(
      Effect.gen(function* () {
        const bundle = yield* execution;
        yield* drainFoldOutput();
        return bundle;
      }),
      drainFoldOutput,
    );
  });
}
