/**
 * Telling a stand-in which Run each execution belongs to.
 *
 * A native session, process, or Query has no idea, and it should not: Runs are
 * the adapter's vocabulary, not the provider's. But a test that wants to say
 * "this Control reached the first Run and not the second" needs the
 * correlation from somewhere, so a rig wraps the backend and supplies it.
 *
 * It lives here, above every adapter's own test directory, because all four
 * rigs need it and a copy per adapter would be a place for them to drift. The
 * stand-in is reached through {@link RunCorrelation} — two methods, and
 * neither mentions a provider — so this module names no adapter and the
 * boundary stays clean in both directions.
 *
 * `Effect.acquireRelease` rather than a pair of calls, because "this Run's
 * execution has ended" has to be true of a Run that was interrupted as well as
 * one that answered, and the execution scope is the only thing that knows
 * about both.
 */

import { Effect, type Scope } from "effect";
import type {
  Backend,
  BackendAgent,
  ExecutionIO,
  RunInput,
  TerminalBundle,
} from "../backend/contract.ts";
import type { RunId } from "../domain/index.ts";

/** The slice of a stand-in that can be told which Run is running. */
export interface RunCorrelation {
  readonly beginRun: (runId: RunId) => void;
  readonly endRun: () => void;
}

/** Counted as each execution enters and leaves its scope. */
export interface ExecutionTally {
  readonly began: () => void;
  readonly ended: () => void;
}

export function correlateRuns(
  backend: Backend,
  standIn: RunCorrelation,
  executions?: ExecutionTally,
): Backend {
  return {
    id: backend.id,
    validateProfile: backend.validateProfile,
    open: (profile, subagent) =>
      Effect.map(
        backend.open(profile, subagent),
        (agent): BackendAgent => ({
          capabilities: agent.capabilities,
          admitResume: agent.admitResume,
          close: agent.close,
          execute: (
            input: RunInput,
            io: ExecutionIO,
          ): Effect.Effect<TerminalBundle, never, Scope.Scope> =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  executions?.began();
                  standIn.beginRun(input.runId);
                }),
                () =>
                  Effect.sync(() => {
                    executions?.ended();
                    standIn.endRun();
                  }),
              );
              return yield* agent.execute(input, io);
            }),
        }),
      ),
  };
}
