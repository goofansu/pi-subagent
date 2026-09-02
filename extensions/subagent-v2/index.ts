import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Profile } from "./domain/index.ts";
import { registerAgentsCommand } from "./host/agents-command.ts";
import { createDemoBackendSet } from "./host/demo-backends.ts";
import {
  NOTIFICATION_MESSAGE_TYPE,
  renderNotificationMessage,
} from "./host/notification-message.ts";
import type { SessionPushSink } from "./host/push-sink.ts";
import { createSessionPushSink } from "./host/push-sink.ts";
import { shutdownSession, startSession } from "./host/session.ts";
import type { SessionHandle } from "./host/session-handle.ts";
import { createSessionHandle } from "./host/session-handle.ts";
import { registerSubagentTools } from "./host/tools.ts";
import type { ActiveWidget } from "./host/widget.ts";
import { profilesDir } from "./profiles/discovery.ts";
import type { BackendSet } from "./runtime/composition.ts";

/** What the extension needs from the process it is loaded into. */
export interface SubagentV2Options {
  /** Pi's agent directory. Profiles live in `agents/` beneath it. */
  readonly agentDir: string;
  /**
   * The backend set each Session is built from.
   *
   * A function, because each Session gets its own backends: a backend retains
   * conversations and provider identities, and two Sessions sharing one would
   * share both.
   */
  readonly backendSet: () => BackendSet;
  /** Reads the wall clock. Supplied by a test so widget durations are fixed. */
  readonly now?: () => number;
}

/**
 * What one installation exposes, for a test on the far side of the host.
 *
 * A host test asserts on what a user would see — the text a tool returned, the
 * message that was sent, the rows the widget drew. The handle is here for the
 * one thing no host surface reports: the runtime probe, which is how "this
 * Session leaked nothing" becomes an assertion.
 */
export interface SubagentV2Installation {
  readonly handle: SessionHandle;
  readonly sink: SessionPushSink;
  readonly profiles: () => readonly Profile[];
  readonly agentGuidelines: () => readonly string[];
  /**
   * The live Session's widget, or nothing between Sessions.
   *
   * Here for one measurement no host surface reports: how many index changes
   * the subscriber saw against how many renders it asked for. Coalescing is a
   * ratio, and a ratio needs both numbers.
   */
  readonly widget: () => ActiveWidget | undefined;
}

/**
 * Register everything the extension registers, against one set of options.
 *
 * Everything here is registered **once per process**, because that is how Pi's
 * registries work: a tool, a command, or a renderer registered twice is
 * registered twice. Everything Session-scoped lives behind the session handle
 * instead, and each `session_start` refills it.
 *
 * So the factory has exactly four kinds of thing in it:
 *
 * - the process-level state the registrations close over — the session handle,
 *   the push sink, the live guideline array, and the live Profile list;
 * - the registrations themselves: six tools, one command, one message
 *   renderer;
 * - the two Session events that build and dispose a runtime;
 * - the three host events that drive notification landing.
 *
 * Split from the default export so a test can supply a Profile directory and a
 * backend set instead of reading the machine's own, which is what every
 * host-level test in this milestone does.
 */
export function installSubagentV2(
  pi: ExtensionAPI,
  options: SubagentV2Options,
): SubagentV2Installation {
  const handle = createSessionHandle();
  const sink = createSessionPushSink();
  /** Rewritten in place per Session; see `SessionWiring.agentGuidelines`. */
  const agentGuidelines: string[] = [];
  /** The live Session's Profiles, for `/agents` to list. */
  let profiles: readonly Profile[] = [];
  let widget: ActiveWidget | undefined;

  const wiring = {
    pi,
    handle,
    sink,
    backendSet: options.backendSet,
    agentDir: options.agentDir,
    agentGuidelines,
    setProfiles: (loaded: readonly Profile[]) => {
      profiles = loaded;
    },
    now: options.now ?? (() => Date.now()),
  };

  registerSubagentTools(pi, handle, agentGuidelines);
  registerAgentsCommand(pi, () => profiles, profilesDir(options.agentDir));
  pi.registerMessageRenderer(
    NOTIFICATION_MESSAGE_TYPE,
    renderNotificationMessage,
  );

  pi.on("session_start", async (_event, ctx) => {
    widget = (await startSession(wiring, ctx)).widget;
  });
  pi.on("session_shutdown", async () => {
    await shutdownSession(wiring);
    widget = undefined;
  });

  // The three events notification landing is decided by. The sink owns the
  // decision; the entry point only forwards neutral evidence to it.
  pi.on("message_start", (event) => sink.messageStarted(event.message));
  pi.on("turn_end", (event, ctx) =>
    sink.turnEnded({
      ...(event.message && "stopReason" in event.message
        ? { stopReason: String(event.message.stopReason) }
        : {}),
      signalAborted: ctx?.signal?.aborted === true,
    }),
  );
  pi.on("agent_settled", () => sink.agentSettled());

  return {
    handle,
    sink,
    profiles: () => profiles,
    agentGuidelines: () => [...agentGuidelines],
    widget: () => widget,
  };
}

/**
 * The v2 extension.
 *
 * The backend set is the demo set, which is the point of M3: launching Pi with
 * only this entry point gives a working subagent extension backed by two demo
 * backends and two built-in demo Profiles, with nothing to configure. M4
 * replaces the set with one containing the real Pi backend, and the demo
 * Profiles go with it.
 */
export default function subagentV2Extension(pi: ExtensionAPI): void {
  installSubagentV2(pi, {
    agentDir: getAgentDir(),
    backendSet: createDemoBackendSet,
  });
}
