/**
 * Telling a stand-in session which Run each execution belongs to.
 *
 * A native session has no idea, and it should not: Runs are the adapter's
 * vocabulary, not the provider's. But a test that wants to say "this Control
 * reached the first Run and not the second" needs the correlation from
 * somewhere, so a rig wraps the backend and supplies it.
 *
 * It lives here rather than in either rig because both rigs need it and a
 * second copy would be a second place for the two to drift. The optional
 * `executions` hook is the only thing they differ about: the conformance rig
 * counts live executions because the shared suite asks every rig for that
 * number, and the Pi rig does not need it.
 *
 * `Effect.acquireRelease` rather than a pair of calls, because "this Run's
 * execution has ended" has to be true of a Run that was interrupted as well as
 * one that answered — and the execution scope is the only thing that knows
 * about both.
 */

import { Effect, type Scope } from "effect";
import type {
  Backend,
  BackendAgent,
  ExecutionIO,
  RunInput,
  TerminalBundle,
} from "../../backend/contract.ts";
import type { StandInPiSession } from "./stand-in-session.ts";

/** Counted as each execution enters and leaves its scope. */
export interface ExecutionTally {
  readonly began: () => void;
  readonly ended: () => void;
}

export function correlateRuns(
  backend: Backend,
  standIn: StandInPiSession,
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
