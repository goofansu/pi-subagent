/**
 * The native-callback-bridge policy.
 *
 * Most adapters can await: their provider hands them events inside something
 * that can be suspended, so `emit` applies backpressure and a backend that
 * outruns the core is simply slowed down. Some cannot. A provider that calls
 * a plain JavaScript callback gives an adapter no way to wait, and the adapter
 * has to decide what to do when the core is not ready for the next
 * observation.
 *
 * **The decision is: never drop.** A Run that quietly lost half its transcript
 * is worse than a Run that says it could not keep up, because the first one is
 * indistinguishable from a Run that had nothing more to say. So a bridge that
 * cannot hand an observation over fails its Run visibly, with the two
 * observations {@link bridgeOverflowObservations} returns: a `queue-overflow`
 * diagnostic saying what happened, and a `failed` ending stopping the Run.
 *
 * The policy is decided here, in the backend module, because it is a rule
 * about what an *adapter* must do — the M4 to M6 adapters are its audience.
 * The helper that offers into one Run's intake without waiting lives with the
 * intake, in the runtime, because that is what it is about.
 *
 * What no helper can do for an adapter is *settle* the Run: an adapter does
 * not own settlement, and could not be allowed to. What it can do is emit
 * these two observations, which is what makes the core settle it as failed.
 */

import { type RunObservation, runDiagnostic } from "../domain/index.ts";

/** The failure an overflowing callback bridge reports. */
export const BRIDGE_OVERFLOW_MESSAGE =
  "the backend outran its observation intake";

/** What a bridge that could not hand an observation over must emit instead. */
export function bridgeOverflowObservations(): readonly RunObservation[] {
  return [
    {
      kind: "diagnostic",
      diagnostic: runDiagnostic(
        "queue-overflow",
        "the backend produced observations faster than they could be accepted, and this Run cannot report what it missed",
      ),
    },
    {
      kind: "ending",
      ending: {
        ending: "failed",
        message: BRIDGE_OVERFLOW_MESSAGE,
      },
    },
  ];
}
