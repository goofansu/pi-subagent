/**
 * The test-only scenario driver.
 *
 * M2 builds the real supervisor. This is the smallest thing that can run one
 * Run end to end so the M1 lifecycle rules are demonstrable *before* that
 * supervisor exists: it opens nothing, owns no registry, has no capacity, no
 * mailbox bounds, and no result store. It does exactly five things, in the
 * order ADR-0025 fixes:
 *
 * 1. Run one execution in a scope nested inside the caller's.
 * 2. Reduce every observation the moment it is emitted, in emission order.
 * 3. Close the execution scope and wait for its finalizers.
 * 4. Apply the terminal bundle — reconciliation, then the ending.
 * 5. Produce the immutable `RunResult`.
 *
 * It is deliberately small and deliberately test-only, so that M2 *replaces*
 * it rather than inheriting it. The parts of it that are real product
 * knowledge — classifying a defect as a failure, first-ending-wins, the
 * running → finalizing → terminal transition — are pure domain calls, so the
 * supervisor will reuse the knowledge without reusing this code.
 *
 * Ending arbitration here is the simple rule: the first ending to be reduced
 * wins, and a later one is reported late. Full arbitration under concurrency
 * is M2's problem.
 */

import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import type {
  BackendAgent,
  ControlFeed,
  RunControl,
  RunInput,
  TerminalBundle,
} from "../backend/contract.ts";
import {
  type AppliedReport,
  cancelledEnding,
  createRunProjection,
  DEFAULT_PROJECTION_BOUNDS,
  failedEnding,
  ILLEGAL_TRANSITION,
  type ProjectionBounds,
  type RunEnding,
  type RunIdentity,
  type RunObservation,
  type RunPhase,
  type RunProjection,
  type RunResult,
  redactedDiagnostic,
  reduceRun,
  settlementEventForEnding,
  toRunResult,
  transitionRun,
} from "../domain/index.ts";

/** Who the Run belongs to. The driver supplies the Run id from the input. */
export interface DriverIdentity extends Omit<RunIdentity, "runId"> {}

export interface DriveOptions {
  readonly input: RunInput;
  /** Controls offered to this Run, in admission order. A test list. */
  readonly controls?: readonly RunControl[];
  readonly bounds?: ProjectionBounds;
  /**
   * Completing this interrupts the execution, which is how cancellation
   * reaches a backend. There is no signal and no timeout: the test decides
   * when, and nothing waits on a clock.
   */
  readonly cancelWhen?: Deferred.Deferred<void>;
  /**
   * Make the observation sink fail on the nth observation, counting from one.
   * Proves a reporter failure cannot strand the execution.
   */
  readonly sinkFailsAt?: number;
  /** A shared ordering log. The driver appends its own stages. */
  readonly trace?: string[];
  /** Fixed timestamps: no M1 test lets real time pass. */
  readonly startedAt?: number;
  readonly settledAt?: number;
}

export interface DriveOutcome {
  readonly result: RunResult;
  /** Every observation the backend emitted, in emission order. */
  readonly observations: readonly RunObservation[];
  /** One report per reduced observation, including the bundle's own. */
  readonly reports: readonly AppliedReport[];
  /** The projection at settlement, for assertions the result does not carry. */
  readonly projection: RunProjection;
  /** The phases this Run passed through, proving it took the legal route. */
  readonly phases: readonly RunPhase[];
  /** The ordering log: scope closure before result production. */
  readonly trace: readonly string[];
  /** What the bundle's ending did — applied, or late because one already won. */
  readonly bundleReport: AppliedReport;
  /** How the execution resolved, before the core classified it. */
  readonly resolution: "completed" | "interrupted" | "defect";
}

/** The stage names the driver records, so ordering is assertable. */
export const DRIVER_STAGES = {
  executionResolved: "driver:execution-resolved",
  executionScopeClosed: "driver:execution-scope-closed",
  resultProduced: "driver:result-produced",
} as const;

/**
 * What the core makes of an execution that did not return a bundle.
 *
 * An adapter must not fail its Effect for a backend failure, so a failure or
 * defect here is an adapter defect. The Run still settles: `failed`, with a
 * redacted `backend-failure` diagnostic and every observation it managed to
 * emit retained. This is the rule M2's supervisor takes over.
 */
function classify(exit: Exit.Exit<TerminalBundle, never>): {
  readonly bundle: TerminalBundle;
  readonly resolution: DriveOutcome["resolution"];
  readonly diagnostic?: RunObservation;
} {
  if (Exit.isSuccess(exit)) {
    return { bundle: exit.value, resolution: "completed" };
  }
  if (Cause.hasInterrupts(exit.cause)) {
    // Cancellation reaches a backend as interruption. An adapter that returns
    // a cancelled ending on its way out is preferred; one that cannot is
    // classified here, which is why a cancelled Run needs no cooperation.
    return {
      bundle: { ending: cancelledEnding("requested") },
      resolution: "interrupted",
    };
  }
  return {
    bundle: { ending: failedEnding("the backend execution failed") },
    resolution: "defect",
    diagnostic: {
      kind: "diagnostic",
      // The defect is provider-authored text; only the category crosses.
      diagnostic: redactedDiagnostic("backend-failure"),
    },
  };
}

/** Run one Run on an already-open BackendAgent. */
export function driveRun(
  agent: BackendAgent,
  identity: DriverIdentity,
  options: DriveOptions,
): Effect.Effect<DriveOutcome> {
  return Effect.gen(function* () {
    const bounds = options.bounds ?? DEFAULT_PROJECTION_BOUNDS;
    const trace = options.trace ?? [];
    const observations: RunObservation[] = [];
    const reports: AppliedReport[] = [];
    let projection = createRunProjection();
    let emitted = 0;

    const reduce = (observation: RunObservation): AppliedReport => {
      const step = reduceRun(projection, observation, bounds);
      projection = step.projection;
      reports.push(step.report);
      return step.report;
    };

    const emit = (observation: RunObservation): Effect.Effect<void> =>
      Effect.suspend(() => {
        emitted += 1;
        if (options.sinkFailsAt === emitted) {
          // A reporter failure is a defect, not a failure the backend can
          // handle: the whole point is that the backend cannot be left holding
          // an execution nobody is reading.
          return Effect.die(new Error("the observation sink failed"));
        }
        observations.push(observation);
        reduce(observation);
        return Effect.void;
      });

    const pending = [...(options.controls ?? [])];
    // A fresh feed per Run, which is why a Control admitted to one Run can
    // never reach the next: there is no shared queue to leak through.
    const controls: ControlFeed = {
      take: Effect.sync(() => pending.shift()),
    };

    const executionScope = yield* Scope.make();
    const fiber = yield* Effect.forkChild(
      agent
        .execute(options.input, { emit, controls })
        .pipe(Scope.provide(executionScope)),
    );
    if (options.cancelWhen) {
      const cancelWhen = options.cancelWhen;
      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(cancelWhen);
          yield* Fiber.interrupt(fiber);
        }),
      );
    }

    const [exit] = yield* Fiber.awaitAll([fiber]);
    trace.push(DRIVER_STAGES.executionResolved);
    yield* Scope.close(executionScope, Exit.void);
    trace.push(DRIVER_STAGES.executionScopeClosed);

    const classified = classify(exit);
    if (classified.diagnostic) reduce(classified.diagnostic);
    if (classified.bundle.reconciliation) {
      reduce({
        kind: "reconciliation",
        reconciliation: classified.bundle.reconciliation,
      });
    }
    const bundleReport = reduce({
      kind: "ending",
      ending: classified.bundle.ending,
    });

    // First ending wins. A backend that announced its ending in-stream already
    // settled the projection, and the bundle's ending is reported late.
    const ending: RunEnding = projection.ending ?? classified.bundle.ending;

    const phases: RunPhase[] = ["running"];
    for (const event of [
      "execution-ended",
      settlementEventForEnding(ending),
    ] as const) {
      const next = transitionRun(phases[phases.length - 1], event);
      if (next === ILLEGAL_TRANSITION) {
        throw new Error(
          `the driver attempted an illegal transition: ${phases[phases.length - 1]} + ${event}`,
        );
      }
      phases.push(next);
    }

    const result = toRunResult({
      identity: { ...identity, runId: options.input.runId },
      projection,
      ending,
      startedAt: options.startedAt ?? 0,
      settledAt: options.settledAt ?? 1,
    });
    trace.push(DRIVER_STAGES.resultProduced);

    return {
      result,
      observations,
      reports,
      projection,
      phases,
      trace,
      bundleReport,
      resolution: classified.resolution,
    };
  });
}
