/**
 * Every bound the Session runtime enforces, in one plain value.
 *
 * `RuntimePolicy` is configuration, not a service with behaviour: nothing here
 * decides anything, it only says how much. Keeping it a value rather than a
 * Layer is the roadmap's rule about keeping the session-long services few, and
 * it has a practical consequence — a test lowers a bound by spreading over the
 * defaults, with no wiring to change.
 *
 * Every field is a bound something would otherwise be unbounded by, and each
 * one names what goes wrong without it:
 *
 * - without `maxActiveRuns`, a model can start Runs until the process dies;
 * - without the control bounds, a caller can steer faster than a backend
 *   consumes;
 * - without `observationQueueBound`, a chatty backend can outrun the reducer;
 * - without `maxResultBytes` and `resultStoreBytes`, one Run's output can take
 *   the heap;
 * - without `openBudget`, a backend that hangs while opening holds the caller
 *   forever;
 * - without `cleanupBudget`, a hung finalizer leaves a Run in `finalizing`
 *   forever;
 * - without `deliveryRetryBudget`, a failing sink is retried forever.
 *
 * Durations are milliseconds rather than `Duration` values, because every one
 * of them is compared against a test clock a test advances by a number.
 */

import {
  DEFAULT_PROJECTION_BOUNDS,
  DIAGNOSTIC_MESSAGE_MAX_BYTES,
  type ProjectionBounds,
} from "../domain/index.ts";

/** The three axes a Control mailbox is bounded on. */
export interface ControlBounds {
  /** How many Controls may be admitted and not yet taken. */
  readonly maxPending: number;
  /** How large one Control's text may be. */
  readonly maxMessageBytes: number;
  /** How much text may be pending across all of them. */
  readonly maxPendingBytes: number;
}

/** How hard delivery tries before it gives up on one Run. */
export interface DeliveryRetryBudget {
  /** Total pushes, so 1 means no retry at all. */
  readonly attempts: number;
  /** How long to wait between them, on the runtime clock. */
  readonly delayMillis: number;
}

export interface RuntimePolicy {
  /** Runs active across every Subagent at once. */
  readonly maxActiveRuns: number;
  readonly controls: ControlBounds;
  readonly projection: ProjectionBounds;
  /**
   * The most bytes one stored result may occupy, encoded.
   *
   * This is what a Run reserves at admission and what settlement bounds its
   * candidate result to, so a reservation is a guarantee rather than an
   * estimate. It is a separate bound from the projection bounds because those
   * bound items and texts, and the encoded whole is not their product — an
   * item may carry any number of parts.
   */
  readonly maxResultBytes: number;
  /** Reservations plus pinned plus stored may never exceed this. */
  readonly resultStoreBytes: number;
  /** How many decoded observations may be waiting for the reducer. */
  readonly observationQueueBound: number;
  /** How long a backend has to open before the start is rejected. */
  readonly openBudgetMillis: number;
  /**
   * How long a cancelled execution may take to exit, and native execution or
   * BackendAgent finalizers may take to close.
   */
  readonly cleanupBudgetMillis: number;
  readonly deliveryRetryBudget: DeliveryRetryBudget;
  /** When set, every Run is cancelled with reason `timeout` after this long. */
  readonly defaultRunTimeoutMillis?: number;
}

/**
 * v1's control bounds exactly. They are the one part of this policy that has a
 * v1 number to match, and matching it means a caller that learned v1's
 * steering rhythm finds v2 behaves the same way.
 */
export const DEFAULT_CONTROL_BOUNDS: ControlBounds = {
  maxPending: 16,
  maxMessageBytes: 16 * 1024,
  maxPendingBytes: 64 * 1024,
};

/**
 * Eight concurrent Runs.
 *
 * v1 has no global limit at all — that is the deliberate decision in ADR-0001
 * — so this is v2's own number rather than a match. Eight is enough that a
 * plausible fan-out never notices it and small enough that eight runaway
 * backends cannot take a Pi process down between them.
 */
export const DEFAULT_MAX_ACTIVE_RUNS = 8;

/** A quarter of a megabyte per result, encoded. */
export const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

/**
 * Four megabytes of results.
 *
 * Half of it is exactly the reservation for a full house of active Runs, so
 * the other half is what stored results share. v1's budget is 2,000,000
 * characters, which this is deliberately close to: the point is that eviction
 * is reachable in a long Session rather than theoretical.
 */
export const DEFAULT_RESULT_STORE_BYTES = 4 * 1024 * 1024;

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  maxActiveRuns: DEFAULT_MAX_ACTIVE_RUNS,
  controls: DEFAULT_CONTROL_BOUNDS,
  projection: DEFAULT_PROJECTION_BOUNDS,
  maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
  resultStoreBytes: DEFAULT_RESULT_STORE_BYTES,
  observationQueueBound: 256,
  openBudgetMillis: 30_000,
  cleanupBudgetMillis: 5_000,
  deliveryRetryBudget: { attempts: 3, delayMillis: 1_000 },
};

/**
 * The smallest store budget that can admit a full house of Runs.
 *
 * A policy whose store budget is below this can never reach `maxActiveRuns`,
 * because the last Runs would have no result capacity to reserve. That is a
 * legitimate thing for a test to configure deliberately — it is how the
 * at-capacity-for-result-reasons path is exercised — so this is a number a
 * caller can read rather than a rule anything enforces.
 */
export function minimumStoreBytesFor(policy: RuntimePolicy): number {
  return policy.maxActiveRuns * policy.maxResultBytes;
}

/**
 * A floor for `maxResultBytes`, below which a result could not carry even one
 * diagnostic explaining why it is empty.
 */
export const MINIMUM_USEFUL_RESULT_BYTES = DIAGNOSTIC_MESSAGE_MAX_BYTES;
