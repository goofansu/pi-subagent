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
 * cannot hand an observation over fails its Run visibly. It preserves a
 * `queue-overflow` diagnostic from {@link bridgeOverflowObservation}; the
 * execution returns a failed Terminal bundle so the core owns the ending.
 *
 * The policy is decided here, in the backend module, because it is a rule
 * about what an *adapter* must do — the M4 to M6 adapters are its audience.
 * The helper that offers into one Run's intake without waiting lives with the
 * intake, in the runtime, because that is what it is about.
 *
 * What no helper can do for an adapter is *settle* the Run: an adapter does
 * not own settlement, and could not be allowed to. The diagnostic reports the
 * lossless-stop policy; the failed bundle returned by execution makes the core
 * settle the Run as failed.
 */

import { type RunObservation, runDiagnostic } from "../domain/index.ts";

/** The failure an overflowing callback bridge reports. */
export const BRIDGE_OVERFLOW_MESSAGE =
  "the backend outran its observation intake";

/** The diagnostic a bridge preserves when it cannot accept another event. */
export function bridgeOverflowObservation(): Extract<
  RunObservation,
  { readonly kind: "diagnostic" }
> {
  return {
    kind: "diagnostic",
    diagnostic: runDiagnostic(
      "queue-overflow",
      "the backend produced observations faster than they could be accepted, and this Run cannot report what it missed",
    ),
  };
}
