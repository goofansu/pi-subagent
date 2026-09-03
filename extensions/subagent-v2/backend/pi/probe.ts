/**
 * What the Pi adapter is still holding, counted.
 *
 * The runtime's own probe answers "did the core leak a fiber, a queue, or a
 * mailbox". It cannot answer "did the adapter leave a native session open or
 * an event subscription attached", because the core has never heard of either.
 * So the adapter keeps its own, and the exit gate reads both: a Session that
 * closed cleanly reads zero on each.
 *
 * This is deliberately **outside the backend contract**. A probe on the
 * contract would be a field every adapter had to invent something for, and a
 * number the core could start believing. It is reachable only through the
 * handle this adapter's own factory returns, which is what a test and the live
 * lane hold and nothing in the runtime does.
 *
 * Plain mutable numbers, for the same reason the runtime's counters are: a
 * count that could be interrupted between its read and its write would
 * undercount exactly when it is being read.
 */

/** Everything the adapter retains, as numbers. Zero when nothing is held. */
export interface PiNativeProbe {
  /** Native sessions constructed and not yet disposed. */
  readonly openSessions: number;
  /** Event subscriptions attached and not yet released. */
  readonly liveSubscriptions: number;
  /**
   * Native cleanups begun and not yet settled.
   *
   * A cancel or a close asks the session to abort and to go idle. Both are
   * bounded by the caller, so a cleanup that outlives its bound leaves this
   * above zero — which is the honest reading, and the one the live lane's
   * assertion is about.
   */
  readonly pendingCleanups: number;
}

export type PiProbeResource = keyof PiNativeProbe;

const ZERO: PiNativeProbe = {
  openSessions: 0,
  liveSubscriptions: 0,
  pendingCleanups: 0,
};

export interface PiProbeCounters {
  readonly acquired: (resource: PiProbeResource) => void;
  readonly released: (resource: PiProbeResource) => void;
  readonly read: () => PiNativeProbe;
}

export function createPiProbeCounters(): PiProbeCounters {
  const held: Record<string, number> = { ...ZERO };
  return {
    acquired: (resource) => {
      held[resource] = (held[resource] ?? 0) + 1;
    },
    released: (resource) => {
      held[resource] = (held[resource] ?? 0) - 1;
    },
    read: () => ({ ...ZERO, ...held }) as PiNativeProbe,
  };
}

/** Whether the adapter is holding nothing, which is what a leak test asks. */
export function piProbeIsClear(probe: PiNativeProbe): boolean {
  return Object.values(probe).every((held) => held === 0);
}
