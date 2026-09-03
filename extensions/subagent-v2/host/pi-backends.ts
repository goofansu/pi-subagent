/**
 * The Pi backend set: the composition root for M4 onward.
 *
 * The second of the two files under `host/` that may name a backend, and the
 * boundary test names both. It sits here rather than in the adapter for the
 * same reason `demo-backends.ts` does: a backend *set* is the point where the
 * Session runtime's vocabulary and an adapter's meet, and an adapter that
 * imported the runtime to describe itself would be an adapter one edit away
 * from reaching the supervisor.
 *
 * One backend, and **no built-in Profiles**. That is the difference from the
 * demo set, and it is deliberate: a demo Profile existed so that launching the
 * extension gave a user something to try with nothing configured, whereas a Pi
 * Profile is the user's own specialist, read from their agents directory.
 * Inventing one here would put a specialist nobody wrote into every Session's
 * `/agents` list.
 *
 * The set also carries the two host facts only this adapter knows — whether
 * this process is a Pi child's load, and how deep in a delegation chain it is
 * — so the entry point can be inert inside a child and admission can enforce
 * the real depth, neither of which requires the host to know what Pi is.
 *
 * A function rather than a constant, because each Session gets its own
 * backend: an adapter retains native sessions, and two Sessions sharing one
 * would share them.
 */

import {
  createPiBackend,
  isChildResourceLoad,
  type PiBackendOptions,
  type PiNativeProbe,
  readChildDepth,
} from "../backend/pi/index.ts";
import type { BackendSet } from "../runtime/composition.ts";

/** What the set is called, for the start-up diagnostic. */
export const PI_BACKEND_SET_NAME = "pi";

/** A Pi backend set, plus the adapter probe the live lane reads. */
export interface PiBackendSet {
  readonly set: BackendSet;
  /** What the adapter is holding. Zero once the Session has closed. */
  readonly probe: () => PiNativeProbe;
}

export function createPiBackendSet(
  options: PiBackendOptions = {},
): PiBackendSet {
  const handle = createPiBackend(options);
  return {
    set: {
      name: PI_BACKEND_SET_NAME,
      backends: [handle.backend],
      profiles: [],
      isChildLoad: isChildResourceLoad,
      childDepth: () => readChildDepth(),
    },
    probe: handle.probe,
  };
}
