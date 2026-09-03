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
import {
  answeredEnding,
  failedEnding,
  type RunObservation,
  type TerminalReconciliation,
} from "../../domain/index.ts";
import type { ExecutionIO, RunInput, TerminalBundle } from "../contract.ts";
import {
  type ClaudeInput,
  claudeInputMessage,
  createClaudeInput,
} from "./input.ts";
import type { ClaudeProbeCounters } from "./probe.ts";
import type { ClaudeQuery, ClaudeQueryStream, Options } from "./query.ts";
import {
  type ClaudeTranslator,
  confined,
  confinedControl,
  createClaudeTranslator,
  isClaudeIdentity,
  readClaudeFrame,
} from "./translate.ts";

/** What a Run says when its BackendAgent was closed under it. */
export const CLOSED_BEFORE_EXECUTION_MESSAGE =
  "the Claude BackendAgent was closed before this Run could start";

/**
 * What a Run says when the conversation identity could not be attached.
 *
 * One fixed message for all four ways it goes wrong — a boundary frame with no
 * identity, a malformed one, one that differs from the retained one, and a
 * Query that could not be started against a retained conversation at all —
 * because they mean the same thing to a reader: this Run could not be tied to
 * the conversation it was supposed to continue. v1 had two messages and the
 * second said nothing the first did not.
 *
 * Fixed rather than provider-authored, because the provider's own text about a
 * failed attachment is exactly the free-form string ADR-0024 keeps local.
 */
export const CLAUDE_ATTACHMENT_FAILED_MESSAGE =
  "the retained Claude conversation could not be attached to this Run";

/** What a Run says when the Query ended without ever reporting a result. */
export const MISSING_CLAUDE_RESULT_MESSAGE =
  "the Claude query ended without a terminal result";

/** What a result frame the provider marked as an error reports. */
export const RESULT_ERROR_CATEGORY = "Claude query reported an error";

/** What a Query that could not be started reports. */
export const QUERY_START_CATEGORY = "Claude query could not be started";

/** What a Query that ended in an exception reports. */
export const QUERY_FAILED_CATEGORY = "Claude query failed";

/** What guidance the input stream would not take reports. */
export const CONTROL_NOT_DELIVERED_CATEGORY =
  "Claude guidance was not delivered";

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

/** One admitted Control, and what the provider has said about it. */
interface PendingControl {
  readonly text: string;
  readonly uuid: string;
  confirmed: boolean;
  discarded: boolean;
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
    /** Input uuids this Run owns, so a correlation can be recognized. */
    const owned = new Set<string>();
    /** Woken when the one provider-visible Control slot frees. */
    const slotWaiters: (() => void)[] = [];

    let identity = resumed;
    let attached = resumed === undefined;
    let visible: PendingControl | undefined;
    let accepting = true;
    let semanticComplete = false;
    let successfulResult = false;
    let sawStderr = false;
    let fatal: TerminalBundle | undefined;

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
    owned.add(promptUuid);
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

    /** The stderr diagnostic, at most one, immediately before the bundle. */
    const withStderr = (
      bundle: TerminalBundle,
    ): Effect.Effect<TerminalBundle> =>
      Effect.gen(function* () {
        if (sawStderr) {
          yield* io.emit({
            kind: "diagnostic",
            diagnostic: confined(SDK_STDERR_CATEGORY),
          });
        }
        return bundle;
      });

    if (started.outcome !== "started") {
      if (resumed !== undefined) conversation.lose();
      const diagnostic = confined(QUERY_START_CATEGORY);
      yield* io.emit({ kind: "diagnostic", diagnostic });
      return yield* withStderr({
        ending: failedEnding(
          resumed === undefined
            ? diagnostic.message
            : CLAUDE_ATTACHMENT_FAILED_MESSAGE,
        ),
      });
    }

    /* ---- steering: one Control provider-visible at a time ---- */

    const notDelivered: RunObservation = {
      kind: "diagnostic",
      diagnostic: confinedControl(CONTROL_NOT_DELIVERED_CATEGORY),
    };

    /** Free the one provider-visible slot and let a waiting consumer try. */
    const freeSlot = (): void => {
      visible = undefined;
      for (const wake of slotWaiters.splice(0)) wake();
    };

    const discardOutstanding = (): void => {
      if (visible !== undefined && !visible.confirmed) {
        visible.discarded = true;
        freeSlot();
      }
    };

    const hasOutstanding = (): boolean =>
      visible !== undefined && !visible.confirmed && !visible.discarded;

    /**
     * Take the provider's word that guidance was seen.
     *
     * The only two kinds of evidence there are: a user frame echoing the uuid
     * the client pushed, and a result frame naming it as the input its turn
     * answered. Neither is inferred from admission or from timing.
     */
    const confirm = (uuid: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        const control = visible;
        if (
          typeof uuid !== "string" ||
          control === undefined ||
          control.uuid !== uuid ||
          control.confirmed ||
          control.discarded
        ) {
          return;
        }
        control.confirmed = true;
        owned.add(control.uuid);
        yield* io.emit({
          kind: "message",
          role: "user",
          parts: [{ kind: "text", text: control.text }],
        });
        freeSlot();
      });

    /**
     * Take one Control at a time, and only when one can actually be pushed.
     *
     * The consumer is deliberately **not eager**. It could drain the Control
     * mailbox into an array of its own and push from there, and that would be
     * worse in a way that matters: ADR-0026's mailbox is where pending
     * guidance is bounded and where a caller learns at once that there is no
     * room, and an adapter that emptied it into an unbounded array would have
     * moved the queue somewhere with no bound and no answer for the caller. So
     * a Control the provider is not ready for stays in the mailbox, which is
     * where the bound is.
     */
    const steerLoop = Effect.gen(function* () {
      for (;;) {
        while (visible !== undefined && accepting && !semanticComplete) {
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                slotWaiters.push(resolve);
              }),
          );
        }
        const control = yield* io.controls.take;
        if (control === undefined) return;
        if (!accepting || semanticComplete || conversation.isClosed()) {
          // The Run is settling. A Control taken now produces nothing at all:
          // no push, no observation, no diagnostic. Admission already told the
          // caller it was accepted, and nothing else about it is true.
          continue;
        }
        const pending: PendingControl = {
          text: control.text,
          uuid: globalThis.crypto.randomUUID(),
          confirmed: false,
          discarded: false,
        };
        visible = pending;
        // `later` rather than `now`: the provider should finish the turn it
        // is on and take this as guidance for the next one, which is what
        // ADR-0018 means by ordered.
        if (
          !stream.push(claudeInputMessage(pending.text, pending.uuid, "later"))
        ) {
          pending.discarded = true;
          freeSlot();
          yield* io.emit(notDelivered);
        }
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

    /** Fail the Run for an identity that cannot be attached. */
    const failAttachment = (): void => {
      conversation.lose();
      fatal = { ending: failedEnding(CLAUDE_ATTACHMENT_FAILED_MESSAGE) };
      accepting = false;
      discardOutstanding();
      freeSlot();
      stream.close();
    };

    const body = Effect.gen(function* () {
      const steering = yield* Effect.forkChild(steerLoop);
      for (;;) {
        const step = yield* nextFrame;
        if (step.step === "done") break;
        if (step.step === "threw") {
          if (!semanticComplete) {
            fatal = {
              ending: failedEnding(
                resumed === undefined
                  ? confined(QUERY_FAILED_CATEGORY).message
                  : CLAUDE_ATTACHMENT_FAILED_MESSAGE,
              ),
            };
            yield* io.emit({
              kind: "diagnostic",
              diagnostic: confined(QUERY_FAILED_CATEGORY),
            });
          }
          break;
        }

        // The Run is semantically over and the input is closed; what is left
        // is letting the Query wind itself down. Reading to the end is how a
        // Query shuts down gracefully rather than being aborted from under a
        // subprocess that was about to finish anyway — and it is what leaves
        // the window in which a terminal answer already observed survives a
        // cancel that arrives afterwards.
        if (semanticComplete) continue;

        const reading = readClaudeFrame(step.frame);
        // Replayed history is not this Run's work, whichever Run it belonged
        // to. The provider says so on the frame; it is taken at its word.
        if (reading.isReplay) continue;
        // A resumed Query may replay user, assistant, and system history
        // before its attachment boundary. None of it is an observation or an
        // accounting input for this Run.
        if (!attached && !reading.isIdentityBoundary) continue;

        if (reading.isIdentityBoundary) {
          if (
            !isClaudeIdentity(reading.identity) ||
            (identity !== undefined && reading.identity !== identity)
          ) {
            failAttachment();
            break;
          }
          identity ??= reading.identity;
          attached = true;
          conversation.retain(reading.identity);
        } else if (reading.identity !== undefined) {
          if (
            !isClaudeIdentity(reading.identity) ||
            (identity !== undefined && reading.identity !== identity)
          ) {
            failAttachment();
            break;
          }
        }

        if (reading.kind === "user") {
          yield* confirm(reading.uuid);
          // A steering echo is confirmation and nothing else: translating it
          // would put the same guidance in the transcript twice.
          if (!reading.isToolResult) continue;
        }
        if (reading.kind === "result") yield* confirm(reading.correlation);

        for (const observation of translator.frame(reading).observations) {
          yield* io.emit(observation);
        }

        if (reading.kind !== "result") continue;

        if (reading.isError) {
          const diagnostic = confined(RESULT_ERROR_CATEGORY);
          yield* io.emit({ kind: "diagnostic", diagnostic });
          fatal = { ending: failedEnding(diagnostic.message) };
          accepting = false;
          discardOutstanding();
          freeSlot();
          stream.close();
          break;
        }

        successfulResult = true;
        const correlated =
          typeof reading.correlation === "string" &&
          owned.has(reading.correlation);
        if (hasOutstanding() && !correlated) {
          // A valid result the provider could not tie to an input this Run
          // owns cannot prove that outstanding guidance belongs to a later
          // turn. Keep the answer, fabricate no user observation, and stop
          // holding a Query open for input that may never be taken.
          discardOutstanding();
        }
        if (hasOutstanding()) {
          // An adapter-local Turn boundary. The Run stays active until the
          // guidance the provider has already been given has been answered.
          continue;
        }
        semanticComplete = true;
        accepting = false;
        freeSlot();
        stream.close();
      }

      accepting = false;
      freeSlot();
      yield* Fiber.interrupt(steering);
      if (fatal !== undefined) return yield* withStderr(fatal);
      if (successfulResult) {
        return yield* withStderr({
          ending: answeredEnding(),
          reconciliation: reconcile(translator),
        });
      }
      return yield* withStderr({
        ending: failedEnding(MISSING_CLAUDE_RESULT_MESSAGE),
      });
    });

    /**
     * What a cancelled Run still has to say before its intake is sealed.
     *
     * A successful result already observed is the Run's answer, and a cancel
     * that arrived afterwards is a request against a Run that was already
     * done. Announcing the reconciliation and the ending it implies is what
     * makes arbitration prefer the answer over the interruption.
     */
    const announceOnInterrupt = Effect.gen(function* () {
      if (sawStderr) {
        yield* io.emit({
          kind: "diagnostic",
          diagnostic: confined(SDK_STDERR_CATEGORY),
        });
      }
      if (!successfulResult) return;
      yield* io.emit({
        kind: "reconciliation",
        reconciliation: reconcile(translator),
      });
      yield* io.emit({ kind: "ending", ending: answeredEnding() });
    });

    return yield* Effect.onInterrupt(body, () => announceOnInterrupt);
  });
}

/**
 * What a Claude Run's terminal snapshot can honestly replace.
 *
 * Turns and the model, and **never a transcript**. There is no authoritative
 * message list to read at the end of a Query — the frames were the transcript,
 * and they have already been reported — so a snapshot claiming one would be a
 * snapshot the adapter had made up. That is why the Claude BackendAgent
 * declares `terminalTranscriptSnapshot: false`, and why the shared suite's
 * transcript-healing scenarios are the only ones it skips.
 */
function reconcile(translator: ClaudeTranslator): TerminalReconciliation {
  const model = translator.primaryModel();
  return {
    turns: translator.turns(),
    ...(model === undefined ? {} : { model }),
  };
}
