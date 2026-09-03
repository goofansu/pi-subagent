/**
 * The production backend set: Pi, Claude, and Codex, from M6 onward.
 *
 * The third of the files under `host/` that may name a backend, and the
 * boundary test names all three. It sits here rather than in either adapter
 * for the reason `pi-backends.ts` does: a backend *set* is the point where the
 * Session runtime's vocabulary and an adapter's meet, and an adapter that
 * imported the runtime to describe itself would be an adapter one edit away
 * from reaching the supervisor.
 *
 * **No built-in Profiles.** A Profile is the user's own specialist, read from
 * their agents directory, and which backend it names is a line in its
 * frontmatter. Inventing one here would put a specialist nobody wrote into
 * every Session's `/agents` list.
 *
 * **The host facts come from Pi, and only Pi.** Whether this process is a
 * child's resource load and how deep in a delegation chain it is are questions
 * only the backend that spawns children in-process can answer. Claude's and
 * Codex's children are subprocesses that never load this extension, so
 * neither has an answer of its own to give — and the depth *variable* is
 * shared, which is exactly why it moved to `backend/depth.ts` and why a
 * Bash-launched grandchild reads the same key whichever backend spawned its
 * parent.
 *
 * A function rather than a constant, because each Session gets its own
 * backends: an adapter retains native sessions and conversation identities,
 * and two Sessions sharing one would share both.
 */

import {
  CLAUDE_BACKEND_ID,
  type ClaudeBackendOptions,
  createClaudeBackend,
} from "../backend/claude/index.ts";
import {
  CODEX_BACKEND_ID,
  type CodexBackendOptions,
  createCodexBackend,
} from "../backend/codex/index.ts";
import {
  createPiBackend,
  isChildResourceLoad,
  PI_BACKEND_ID,
  type PiBackendOptions,
  readChildDepth,
} from "../backend/pi/index.ts";
import type { BackendSet } from "../runtime/composition.ts";
import type { AdapterProbe } from "./diagnostics-command.ts";

/** What the set is called, for the start-up diagnostic. */
export const PRODUCTION_BACKEND_SET_NAME = "production";

export interface ProductionBackendOptions {
  readonly pi?: PiBackendOptions;
  readonly claude?: ClaudeBackendOptions;
  readonly codex?: CodexBackendOptions;
}

/** A production backend set, plus the adapter probes the live lane reads. */
export interface ProductionBackendSet {
  readonly set: BackendSet;
  /**
   * What each adapter is holding, one named block per backend.
   *
   * One block per backend rather than a merged total, because "which adapter
   * is still holding something" is the only question a probe exists to answer,
   * and a sum cannot answer it.
   */
  readonly probe: () => AdapterProbe;
}

export function createProductionBackendSet(
  options: ProductionBackendOptions = {},
): ProductionBackendSet {
  const pi = createPiBackend(options.pi ?? {});
  const claude = createClaudeBackend(options.claude ?? {});
  const codex = createCodexBackend(options.codex ?? {});
  return {
    set: {
      name: PRODUCTION_BACKEND_SET_NAME,
      backends: [pi.backend, claude.backend, codex.backend],
      profiles: [],
      isChildLoad: isChildResourceLoad,
      childDepth: () => readChildDepth(),
    },
    probe: () => ({
      [PI_BACKEND_ID]: { ...pi.probe() },
      [CLAUDE_BACKEND_ID]: { ...claude.probe() },
      [CODEX_BACKEND_ID]: { ...codex.probe() },
    }),
  };
}
