/**
 * What the runtime noticed, and what it is still holding.
 *
 * Two different things live here for one reason: both are numbers a test
 * asserts on rather than behaviour it drives, and both would otherwise be
 * invented separately by each module that needs them.
 *
 * {@link SupervisorCounters} are *diagnostics*: things that happened which
 * nobody had to be told about at the time, but which say whether the runtime
 * is behaving. A duplicate settlement attempt is not an error — it is the
 * normal outcome of two endings racing — but a Session with thousands of them
 * is a Session with a bug.
 *
 * The {@link RuntimeProbe} is a *leak check*: what is still alive. Every race,
 * backpressure, fault, and leak test ends by asserting the probe reads zero
 * after the Session Scope closes, which turns "no stranded fiber, queue, or
 * subscription" from a hope into an assertion.
 */

/** Things that happened and were counted rather than reported. */
export interface SupervisorCounters {
  /** A second terminal candidate arrived for a Run that already had one. */
  readonly duplicateSettlements: number;
  /** An observation was emitted after intake was sealed. */
  readonly lateEvents: number;
  /** A non-blocking bridge could not hand an observation over. */
  readonly queueOverflows: number;
  /** A native finalizer outlived the cleanup budget. */
  readonly cleanupEscalations: number;
  /** A terminal reconciliation changed something that was streamed. */
  readonly reconciliationDifferences: number;
  /** A notification exhausted its retry budget. */
  readonly deliveryFailures: number;
  /** An observation did not decode at the backend seam. */
  readonly seamDecodeFailures: number;
  /** An ending arrived after one had already won. */
  readonly lateEndings: number;
}

export type SupervisorCounter = keyof SupervisorCounters;

const ZERO_COUNTERS: SupervisorCounters = {
  duplicateSettlements: 0,
  lateEvents: 0,
  queueOverflows: 0,
  cleanupEscalations: 0,
  reconciliationDifferences: 0,
  deliveryFailures: 0,
  seamDecodeFailures: 0,
  lateEndings: 0,
};

/** What is still alive. Every field should be zero once a Session has closed. */
export interface RuntimeProbe {
  readonly liveRunFibers: number;
  readonly liveReducerFibers: number;
  readonly openObservationQueues: number;
  readonly openMailboxes: number;
  readonly unresolvedWaiters: number;
  /** Consumers holding a live view of the Run index. */
  readonly repositorySubscriptions: number;
  readonly openBackendAgents: number;
}

export type ProbeResource = keyof RuntimeProbe;

const ZERO_PROBE: RuntimeProbe = {
  liveRunFibers: 0,
  liveReducerFibers: 0,
  openObservationQueues: 0,
  openMailboxes: 0,
  unresolvedWaiters: 0,
  repositorySubscriptions: 0,
  openBackendAgents: 0,
};

export interface RuntimeCounters {
  readonly count: (counter: SupervisorCounter, by?: number) => void;
  readonly acquired: (resource: ProbeResource) => void;
  readonly released: (resource: ProbeResource) => void;
  readonly counters: () => SupervisorCounters;
  readonly probe: () => RuntimeProbe;
}

/**
 * Plain mutable numbers behind a narrow interface.
 *
 * Not a `Ref`, and deliberately: incrementing a counter must not be an
 * interruption point. A counter that could be interrupted between reading and
 * writing would be a counter that undercounts exactly when things are going
 * wrong, which is when it is read.
 */
export function createRuntimeCounters(): RuntimeCounters {
  const counters: Record<string, number> = { ...ZERO_COUNTERS };
  const probe: Record<string, number> = { ...ZERO_PROBE };
  return {
    count: (counter, by = 1) => {
      counters[counter] = (counters[counter] ?? 0) + by;
    },
    acquired: (resource) => {
      probe[resource] = (probe[resource] ?? 0) + 1;
    },
    released: (resource) => {
      probe[resource] = (probe[resource] ?? 0) - 1;
    },
    counters: () => ({ ...ZERO_COUNTERS, ...counters }) as SupervisorCounters,
    probe: () => ({ ...ZERO_PROBE, ...probe }) as RuntimeProbe,
  };
}

/** Whether every probe field is zero, which is what a leak test asks. */
export function probeIsClear(probe: RuntimeProbe): boolean {
  return Object.values(probe).every((live) => live === 0);
}
