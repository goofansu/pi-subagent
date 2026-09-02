/**
 * Binding a Pi Session to a managed v2 runtime.
 *
 * This is where the two lifetimes meet. Pi registers tools, commands, and
 * renderers **once per process**; a Session starts and ends many times inside
 * that process, and each one needs its own runtime — its own Subagents, its
 * own Run index, its own Result store, its own backends. So registration
 * closes over a {@link SessionHandle} and this module refills it:
 *
 * - `session_start` builds a runtime from the composition module with the
 *   backend set and the Session's Profile sources; installs the widget *in the
 *   runtime's own Scope*; binds the push sink to the Session's `sendMessage`;
 *   refreshes the `agent_start` guidelines; and warns about Profile files it
 *   could not use.
 * - `session_shutdown` releases the handle, which detaches the host-side
 *   installs and disposes the runtime. Disposal closes the Session Scope, and
 *   closing the Session Scope *is* the M2 shutdown: every Subagent closed,
 *   every active Run cancelled and awaited, every retained BackendAgent
 *   released, in reverse acquisition order.
 *
 * Binding disposes whatever was bound, so a Session switch cannot leave two
 * runtimes alive whatever order the host events arrive in.
 *
 * The widget going in the runtime's Scope rather than being uninstalled by
 * hand is the point of `ManagedRuntime.scope`: the subscription's finalizer is
 * registered on the same Scope the disposal closes, so "the widget outlives
 * its Session" is not a mistake anyone can make here.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, ManagedRuntime, Scope } from "effect";
import type { Profile, ProfileDiagnostic } from "../domain/index.ts";
import type { BackendSet, SessionServices } from "../runtime/composition.ts";
import { sessionRuntimeLayer } from "../runtime/composition.ts";
import { ProfileCatalog } from "../runtime/profile-catalog.ts";
import type { SessionPushSink } from "./push-sink.ts";
import type { SessionHandle } from "./session-handle.ts";
import { formatAgentGuidelines } from "./tool-copy.ts";
import type { ActiveWidget, WidgetHost } from "./widget.ts";
import { installActiveWidget } from "./widget.ts";

/** What one Session start needs from the process. */
export interface SessionWiring {
  readonly pi: Pick<ExtensionAPI, "sendMessage">;
  readonly handle: SessionHandle;
  readonly sink: SessionPushSink;
  /**
   * The backend set for the Session about to start.
   *
   * A function rather than a value, because each Session gets its own
   * backends: a fake retains a conversation and a cumulative token total, and
   * a real adapter retains a provider identity. Two Sessions sharing one would
   * share all of it.
   */
  readonly backendSet: () => BackendSet;
  /** Where user Profiles are read from. User scope only, as M1 decided. */
  readonly agentDir: string;
  /**
   * The live `agent_start` guideline array, rewritten in place per Session.
   *
   * Pi stores the array a tool was registered with, so mutating its contents
   * is what makes the guidelines follow the Session's Profile catalog without
   * re-registering the tool.
   */
  readonly agentGuidelines: string[];
  /** Publish the Profiles the live Session loaded, for `/agents` to read. */
  readonly setProfiles: (profiles: readonly Profile[]) => void;
  /** Reads the wall clock, so the widget's durations stay testable. */
  readonly now: () => number;
}

/** What a Session start reports back, for a test to assert on. */
export interface StartedSession {
  readonly profiles: readonly Profile[];
  readonly diagnostics: readonly ProfileDiagnostic[];
  readonly widget: ActiveWidget;
}

/**
 * How a Session start names Profile files it could not use.
 *
 * A broken Profile has to be visible without opening a log: a user who wrote
 * one and got silence would conclude the feature does not work. One line per
 * diagnostic, because a Profile with two mistakes should be fixable in one
 * pass.
 */
export function formatInvalidProfilesWarning(
  diagnostics: readonly ProfileDiagnostic[],
): string {
  return [
    "Invalid subagent Profiles were skipped:",
    ...diagnostics.map(
      (diagnostic) => `- ${diagnostic.filePath}: ${diagnostic.reason}`,
    ),
  ].join("\n");
}

/** What the Session installs inside its own Scope, and reads once. */
function openSession(
  host: WidgetHost,
  now: () => number,
): Effect.Effect<StartedSession, never, SessionServices | Scope.Scope> {
  return Effect.gen(function* () {
    const catalog = yield* ProfileCatalog;
    const widget = yield* installActiveWidget(host, now);
    return {
      widget,
      profiles: catalog.list(),
      diagnostics: catalog.diagnostics(),
    };
  });
}

/** The slice of a Session's context this module reads. */
export type SessionStartContext = Pick<ExtensionContext, "ui">;

/**
 * Start a Session: build the runtime, install the surfaces, bind the sink.
 *
 * The order is not arbitrary. The runtime is built first, because everything
 * else needs its services. The widget goes into the runtime's Scope, so it
 * leaves when the runtime does. The sink is bound last, because binding it is
 * what makes notifications start flowing and there is no point in that before
 * the Session can render them.
 */
export async function startSession(
  wiring: SessionWiring,
  ctx: SessionStartContext,
): Promise<StartedSession> {
  const runtime = ManagedRuntime.make(
    sessionRuntimeLayer({
      backendSet: wiring.backendSet(),
      profiles: { from: "directory", agentDir: wiring.agentDir },
      sink: wiring.sink,
    }),
  );

  const widgetHost = ctx.ui as unknown as WidgetHost;
  const opened = await runtime.runPromise(
    Scope.provide(openSession(widgetHost, wiring.now), runtime.scope),
  );

  await wiring.handle.bind({
    runtime,
    // The sink lives in Pi's message surface rather than in the Scope, so it
    // is the one thing disposal cannot reach and the one thing detached here.
    detach: () => wiring.sink.unbind(),
  });

  wiring.sink.bind((message) =>
    wiring.pi.sendMessage(message, {
      deliverAs: "followUp",
      triggerTurn: true,
    }),
  );

  wiring.setProfiles(opened.profiles);
  // Rewritten in place: see `agentGuidelines` above.
  wiring.agentGuidelines.length = 0;
  wiring.agentGuidelines.push(...formatAgentGuidelines(opened.profiles));

  if (opened.diagnostics.length > 0) {
    ctx.ui.notify(formatInvalidProfilesWarning(opened.diagnostics), "warning");
  }

  return opened;
}

/** End a Session: detach the surfaces and dispose the runtime. */
export async function shutdownSession(wiring: {
  readonly handle: SessionHandle;
  readonly setProfiles: (profiles: readonly Profile[]) => void;
}): Promise<void> {
  await wiring.handle.release();
  wiring.setProfiles([]);
}
