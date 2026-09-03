/**
 * What the Claude adapter is still holding, counted.
 *
 * The runtime's own probe answers "did the core leak a fiber, a queue, or a
 * mailbox". It cannot answer "is a Query still iterating, is an input stream
 * still open, is a conversation identity still retained", because the core has
 * never heard of any of the three. So the adapter keeps its own, and the exit
 * gate reads both: a Session that closed cleanly reads zero on each.
 *
 * Deliberately **outside the backend contract**, for the reason the Pi probe
 * is: a probe on the contract would be a field every adapter had to invent
 * something for, and a number the core could start believing. It is reachable
 * only through the handle this adapter's own factory returns.
 *
 * Plain mutable numbers, because a count that could be interrupted between its
 * read and its write would undercount exactly when it is being read.
 */

/** Everything the adapter retains, as numbers. Zero when nothing is held. */
export interface ClaudeNativeProbe {
  /** Queries started and not yet closed. */
  readonly liveQueries: number;
  /** Client-owned input streams opened and not yet closed. */
  readonly openInputs: number;
  /** Conversation identities retained by a BackendAgent that is still open. */
  readonly retainedIdentities: number;
}

export type ClaudeProbeResource = keyof ClaudeNativeProbe;

const ZERO: ClaudeNativeProbe = {
  liveQueries: 0,
  openInputs: 0,
  retainedIdentities: 0,
};

export interface ClaudeProbeCounters {
  readonly acquired: (resource: ClaudeProbeResource) => void;
  readonly released: (resource: ClaudeProbeResource) => void;
  readonly read: () => ClaudeNativeProbe;
}

export function createClaudeProbeCounters(): ClaudeProbeCounters {
  const held: Record<string, number> = { ...ZERO };
  return {
    acquired: (resource) => {
      held[resource] = (held[resource] ?? 0) + 1;
    },
    released: (resource) => {
      held[resource] = (held[resource] ?? 0) - 1;
    },
    read: () => ({ ...ZERO, ...held }) as ClaudeNativeProbe,
  };
}

/** Whether the adapter is holding nothing, which is what a leak test asks. */
export function claudeProbeIsClear(probe: ClaudeNativeProbe): boolean {
  return Object.values(probe).every((held) => held === 0);
}
