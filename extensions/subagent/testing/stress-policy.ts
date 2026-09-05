/**
 * What the stress and bounds lanes share.
 *
 * Two test files drive the same policy and ask the same question of the same
 * counters — `stress.test.ts` repeats the lifecycle hundreds of times, and
 * `bounds.test.ts` walks past one bound at a time — and a second copy of the
 * lowered policy would be a second thing to keep in step with the defaults.
 *
 * A plain module rather than a test file: it declares no tests. It lives here
 * rather than beside the lanes in `runtime/` because it names the Session rig,
 * and the boundary test is right to reject a runtime module that reaches into
 * the testing tree — a production module able to name a rig is a production
 * module one edit away from depending on one.
 */

import { Effect } from "effect";
import type { SupervisorCounters } from "../runtime/counters.ts";
import {
  DEFAULT_RUNTIME_POLICY,
  MINIMUM_USEFUL_RESULT_BYTES,
  type RuntimePolicy,
} from "../runtime/policy.ts";
import { type SessionRig, until } from "./session-rig.ts";

/**
 * The smallest legal policy.
 *
 * `maxResultBytes` sits at the floor below which a result could not carry even
 * one diagnostic explaining why it is empty, and the store budget is exactly a
 * full house of reservations — so a stored result has to be evicted before the
 * next Run can reserve, on nearly every cycle.
 */
export const STRESS_POLICY: RuntimePolicy = {
  ...DEFAULT_RUNTIME_POLICY,
  maxActiveRuns: 2,
  controls: { maxPending: 1, maxMessageBytes: 64, maxPendingBytes: 64 },
  projection: {
    maxTranscriptItems: 2,
    maxToolEntries: 1,
    maxDiagnostics: 1,
    maxLinks: 1,
    maxTextPartBytes: 32,
    maxFinalOutputBytes: 32,
  },
  maxResultBytes: MINIMUM_USEFUL_RESULT_BYTES,
  resultStoreBytes: 2 * MINIMUM_USEFUL_RESULT_BYTES,
  observationQueueBound: 1,
  // One attempt, no delay: the retry budget is the one thing in the runtime
  // that sleeps, and these lanes must not reach it.
  deliveryRetryBudget: { attempts: 1, delayMillis: 0 },
};

/** A steer short enough to fit the lowered mailbox. */
export const STEER = "also look left";

/**
 * The counters a healthy Session must never register at all.
 *
 * Each of these is a *defect* rather than a bound being reached: a Run settled
 * twice, a result committed twice or committed differently, a stored result
 * that would not read back, an observation that did not decode at the seam, an
 * observation dropped because a non-blocking bridge could not hand it over, or
 * a late observation that reached the reducer after the projection was already
 * terminal.
 *
 * `lateObservations` is here and `lateEvents` is not, and the difference is the
 * point: an emit the *sealed intake* dropped is normal — an adapter emitting
 * from its own finalizer does it on every Run — while one that got as far as
 * the reducer means sealing did not happen when it should have.
 *
 * `reconciliationDifferences` is deliberately **not** here — but not because a
 * busy Session is expected to raise it. It counts the Runs whose terminal
 * snapshot *disagreed* with what they streamed, one per Run, and a Session of
 * identical answered Runs whose snapshots restate their streams reads zero. It
 * is exempt because a genuine disagreement is reconciliation doing its job
 * rather than a defect: a backend whose streaming and terminal figures differ
 * is telling the truth about itself, and the honest thing to watch is the rate
 * at which it does so rather than a zero to assert.
 */
const MUST_STAY_ZERO = [
  "duplicateSettlements",
  "duplicateCommits",
  "conflictingCommits",
  "unreadableResults",
  "seamDecodeFailures",
  "queueOverflows",
  "lateObservations",
] as const satisfies readonly (keyof SupervisorCounters)[];

export function assertNothingWentWrong(counters: SupervisorCounters): void {
  const wrong = MUST_STAY_ZERO.filter((counter) => counters[counter] !== 0).map(
    (counter) => `${counter}=${counters[counter]}`,
  );
  if (wrong.length > 0) {
    throw new Error(`counters that must stay zero rose: ${wrong.join(", ")}`);
  }
}

/**
 * Wait until the backend has begun its nth execution, counted from the start
 * of the Session.
 *
 * `untilUnderWay` in the Session rig takes an *index* into the same cumulative
 * count, which reads naturally for a test with two or three Runs and not at
 * all for one with nine hundred. This takes the total, so a caller keeps its
 * own tally — and it spins with the rig's own bounded `until`, so there is one
 * place that decides how long a wait may go on and what it says when it gives
 * up.
 */
export function untilExecutions(
  rig: SessionRig,
  total: number,
): Effect.Effect<void> {
  return until(
    `execution ${total} to begin`,
    Effect.sync(() => rig.backend.counters().executionsStarted >= total),
  );
}
