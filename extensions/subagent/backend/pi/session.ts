/**
 * The slice of Pi's native session this adapter uses, and how one is made.
 *
 * Pi's own name for the abstraction is `AgentSession` today and may be
 * `AgentHarness` or something else tomorrow. Nothing outside this directory
 * knows either name: the contract above speaks of a `BackendAgent`, and the
 * rename would be an edit to this file.
 *
 * The slice is a `Pick` rather than a hand-written interface so the compiler
 * keeps it honest — a method Pi removes or re-types stops compiling here
 * rather than at run time in a live Session — with one addition Pi's type does
 * not expose in the shape this adapter needs: the extension runner's `emit`,
 * which is how a child's extensions are told the session is shutting down.
 *
 * {@link PiSessionFactory} is the seam every test injects at. It takes the
 * options the adapter built and returns a session, which is exactly what
 * `createAgentSession` does — so a stand-in is a drop-in and the adapter has
 * no test-only branch in it.
 */

import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

/** One native session event, as the adapter receives it. */
export type PiSessionEvent = AgentSessionEvent;

/** What the adapter needs a native session to be able to do. */
export type PiSession = Pick<
  AgentSession,
  | "prompt"
  | "steer"
  | "subscribe"
  | "bindExtensions"
  | "abort"
  | "waitForIdle"
  | "clearQueue"
  | "dispose"
  | "messages"
  | "isIdle"
> & {
  readonly extensionRunner: {
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
};

/** The options one native session is constructed from. */
export type PiSessionOptions = CreateAgentSessionOptions;

/** How a native session is made. Injected by every test. */
export type PiSessionFactory = (
  options: PiSessionOptions,
) => Promise<{ readonly session: PiSession }>;

/** How the options are built, so a test can skip the filesystem entirely. */
export type PiSessionOptionsFactory = () => Promise<PiSessionOptions>;
