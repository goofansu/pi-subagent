/**
 * The Run correlation, as the Pi rigs name it.
 *
 * The helper moved to `testing/correlate.ts` at M5, when a second adapter's
 * rigs needed it: the stand-in is reached through a two-method interface that
 * names no provider, so one copy serves every rig. This module re-exports it
 * so the Pi rigs' own imports are unchanged.
 */

export {
  correlateRuns,
  type ExecutionTally,
  type RunCorrelation,
} from "../correlate.ts";
