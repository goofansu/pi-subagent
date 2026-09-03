/**
 * What presentation is allowed to know about a Run.
 *
 * Presentation imports the domain and Pi's TUI primitives, and nothing else.
 * That is an architectural rule rather than a tidiness preference: v1's
 * dispatcher ended up owning presentation state because presentation could
 * reach the thing that owned lifecycle, and once it could, it did.
 *
 * So the shapes a renderer reads are declared here, in domain types only. The
 * runtime's `RunSnapshot` is structurally one of these, so the host hands its
 * snapshots straight across with no mapping layer and no second shape to keep
 * in step — but presentation cannot name the runtime, and therefore cannot
 * reach the repository, the store, or the supervisor through it.
 */

import type {
  CancellationRequest,
  RunIdentity,
  RunPhase,
  TerminalRunPhase,
  UsageSnapshot,
} from "../domain/index.ts";

/**
 * One live Run, as a row.
 *
 * Deliberately the published index's row and not the projection: a projection
 * holds the whole transcript, and a widget that read one would do work
 * proportional to how much a backend said.
 */
export interface RunRowView {
  readonly identity: RunIdentity;
  readonly phase: RunPhase;
  /** Present once a cancellation has been recorded, whatever the phase. */
  readonly cancellation?: CancellationRequest;
  /** Conflated and display-only. Absent once the Run settles. */
  readonly activity?: string;
  readonly usage: UsageSnapshot;
  /** How many tool calls the Run has, not which ones. */
  readonly tools: number;
  readonly startedAt: number;
  /** Present exactly when the phase is terminal. */
  readonly terminalStatus?: TerminalRunPhase;
}

/**
 * How long a row has been going.
 *
 * A live Run is measured against now; a settled one has stopped, and the
 * caller supplies the instant it stopped at. Presentation reads no clock of
 * its own — a renderer that called `Date.now()` would produce a different
 * string every time it was asked, which is not something a golden test can
 * pin.
 */
export function elapsedMillis(
  row: Pick<RunRowView, "startedAt">,
  now: number,
): number {
  return Math.max(0, now - row.startedAt);
}
