/**
 * The decoded shape of each tool's input.
 *
 * These are what the façade takes, and they are declared here rather than at
 * the host because the façade is what they are *for*: the host's `Schema`
 * declarations describe the same seven shapes for Pi's benefit, and the compiler
 * checks that what a decode produces is what an operation accepts at the one
 * call site where the two meet.
 *
 * Ids are **branded** here, which is a statement about where the check
 * happens. A model can spell anything, so an id has to be checked somewhere;
 * the host's `Schema` declaration is that somewhere, because it is also what
 * Pi validates the call against. An id that reaches the façade has therefore
 * already been checked, and the façade needs no laundering step and no
 * "unrecognized id" outcome of its own — a malformed id is a decode failure
 * naming the field, which is a better answer than a fabricated `unknown Run`.
 */

import type { RunId, SubagentId } from "../domain/index.ts";

/** What a Run inherits from the Session that started it. */
export interface SessionFacts {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  /**
   * How deep this Session already is.
   *
   * Zero in M3: nothing runs inside a Subagent yet, because no adapter exists
   * to spawn one. The inert-in-child guard and real child depth arrive with
   * the Pi adapter.
   */
  readonly childDepth: number;
  readonly parentModel?: {
    readonly provider: string;
    readonly id: string;
    readonly thinkingLevel?: string;
  };
}

export interface StartInput {
  readonly agent: string;
  readonly description: string;
  readonly prompt: string;
}

export interface ResumeInput {
  readonly id: SubagentId;
  readonly description: string;
  readonly prompt: string;
}

export interface SteerInput {
  readonly id: RunId;
  readonly message: string;
}

export interface CancelInput {
  readonly ids: readonly RunId[];
}

export interface WaitInput {
  readonly ids: readonly RunId[];
  readonly timeoutSeconds?: number;
}

/**
 * `agent_wait_all` names no Run: it covers every Run of this Session that is
 * active when the call arrives, which is why the shape has no `ids`.
 */
export interface WaitAllInput {
  readonly timeoutSeconds?: number;
}

export interface ResultInput {
  readonly id: RunId;
}
