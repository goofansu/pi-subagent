/**
 * What the Codex adapter is still holding, counted — and what it has seen.
 *
 * Two values, because they answer two different questions and only one of them
 * can ever read zero.
 *
 * {@link CodexNativeProbe} is what is **still held**: an App Server process
 * that has not exited, a reader fiber still owning stdout, a JSON-RPC request
 * still waiting for its answer, a retained root thread, a steer the server has
 * not settled. Every one of these must be zero once a Session has closed, and
 * the exit gate reads it beside the runtime's own probe — which cannot answer
 * any of them, because the core has never heard of a process or a thread.
 *
 * {@link CodexAdapterTally} is what **happened**: opens, effective closes, and
 * the counts that make a routing bug visible rather than silent — frames that
 * reached no Run, declared methods whose payload did not fit, and lines past
 * the framing bound. A probe carrying any of them could never read clear,
 * which is why they are not on it.
 *
 * The late-frame count is the load-bearing one. Codex's stdout outlives every
 * Run, so "late events cannot mutate a terminal Run" is enforced by the
 * adapter's own routing rather than by an event source that disappears with
 * the Run Scope. A routing bug is therefore not a crash; it is a frame applied
 * to the wrong Run, or a current frame quietly dropped. The counter is how a
 * test can insist on the difference in both directions.
 *
 * Deliberately **outside the backend contract**, for the reason the Pi and
 * Claude probes are: a probe on the contract would be a field every adapter
 * had to invent something for, and a number the core could start believing.
 */

/** Everything the adapter retains, as numbers. Zero when nothing is held. */
export interface CodexNativeProbe {
  /** App Server children spawned and not yet exited. */
  readonly liveProcesses: number;
  /** Subagent-scoped reader fibers owning a stdout stream. */
  readonly readerFibers: number;
  /** JSON-RPC requests written and not yet settled. */
  readonly pendingRequests: number;
  /** Root threads retained by a BackendAgent that has not lost them. */
  readonly retainedRoots: number;
  /** Steers sent and not yet accepted, refused, or lost. */
  readonly inFlightSteers: number;
}

export type CodexProbeResource = keyof CodexNativeProbe;

const ZERO: CodexNativeProbe = {
  liveProcesses: 0,
  readerFibers: 0,
  pendingRequests: 0,
  retainedRoots: 0,
  inFlightSteers: 0,
};

export interface CodexProbeCounters {
  readonly acquired: (resource: CodexProbeResource) => void;
  readonly released: (resource: CodexProbeResource) => void;
  readonly read: () => CodexNativeProbe;
}

/**
 * Plain mutable numbers, because a count that could be interrupted between its
 * read and its write would undercount exactly when it is being read.
 */
export function createCodexProbeCounters(): CodexProbeCounters {
  const held: Record<string, number> = { ...ZERO };
  return {
    acquired: (resource) => {
      held[resource] = (held[resource] ?? 0) + 1;
    },
    released: (resource) => {
      held[resource] = (held[resource] ?? 0) - 1;
    },
    read: () => ({ ...ZERO, ...held }) as CodexNativeProbe,
  };
}

/** Lifecycle and routing counts, which are not probe readings. */
export interface CodexAdapterTally {
  readonly opens: number;
  /** Closes that took effect. Two calls on one BackendAgent count once. */
  readonly closes: number;
  /** Frames that belonged to an unknown or settled Turn and reached no Run. */
  readonly lateFrames: number;
  /** Declared methods whose payload did not fit the declaration. */
  readonly malformedFrames: number;
  /** Lines longer than the framing bound, which fail the BackendAgent. */
  readonly oversizedLines: number;
}

export type CodexTallyEvent = keyof Omit<CodexAdapterTally, "opens" | "closes">;

export interface CodexTallyCounters {
  readonly opened: () => void;
  readonly closed: () => void;
  readonly count: (event: CodexTallyEvent) => void;
  readonly read: () => CodexAdapterTally;
}

export function createCodexTallyCounters(): CodexTallyCounters {
  const tally = {
    opens: 0,
    closes: 0,
    lateFrames: 0,
    malformedFrames: 0,
    oversizedLines: 0,
  };
  return {
    opened: () => {
      tally.opens += 1;
    },
    closed: () => {
      tally.closes += 1;
    },
    count: (event) => {
      tally[event] += 1;
    },
    read: () => ({ ...tally }),
  };
}

/** Whether the adapter is holding nothing, which is what a leak test asks. */
export function codexProbeIsClear(probe: CodexNativeProbe): boolean {
  return Object.values(probe).every((held) => held === 0);
}
