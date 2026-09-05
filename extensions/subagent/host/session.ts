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
import { formatInvalidProfilesWarning } from "../presentation/index.ts";
import type { BackendSet, SessionServices } from "../runtime/composition.ts";
import { sessionRuntimeLayer } from "../runtime/composition.ts";
import type { RuntimePolicy } from "../runtime/policy.ts";
import { ProfileCatalog } from "../runtime/profile-catalog.ts";
import type { SessionPushSink } from "./push-sink.ts";
import type { SessionHandle } from "./session-handle.ts";
import { formatAgentGuidelines } from "./tool-copy.ts";
import type {
  ActiveWidget,
  CompletionHandoffView,
  WidgetHost,
} from "./widget.ts";
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
  /** The bounds this Session enforces. Omitted means the defaults. */
  readonly policy?: RuntimePolicy;
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

/** What the Session installs inside its own Scope, and reads once. */
function openSession(
  host: WidgetHost,
  now: () => number,
  handoff: CompletionHandoffView,
): Effect.Effect<StartedSession, never, SessionServices | Scope.Scope> {
  return Effect.gen(function* () {
    const catalog = yield* ProfileCatalog;
    const widget = yield* installActiveWidget(host, now, handoff);
    return {
      widget,
      profiles: catalog.list(),
      diagnostics: catalog.diagnostics(),
    };
  });
}

/**
 * The slice of a Session's context this module reads.
 *
 * `modelRegistry` is read for its catalogue, which the backends validate
 * pinned models against. It is optional because a host that offers no registry
 * is a host with an empty catalogue, which is a Session a Profile can still be
 * loaded into — and a diagnostic a Profile author can still be shown.
 */
export type SessionStartContext = Pick<
  ExtensionContext,
  "hasPendingMessages" | "ui"
> & {
  readonly modelRegistry?: {
    getAll(): readonly { readonly provider: string; readonly id: string }[];
  };
};

/**
 * Start a Session: dispose the last one, build the runtime, install the
 * surfaces, bind the sink.
 *
 * The order is not arbitrary.
 *
 * **The previous Session's runtime goes first**, before the new one is built.
 * Nothing currently observable depends on that: a Session's widget appears
 * only with its first live Run, so a new Session has nothing installed under
 * the shared widget key at the moment an old Session's Scope closes. The order
 * is here because that is a coincidence rather than a guarantee — the two
 * widgets share one key in Pi's widget map, and an old Scope's finalizer
 * clearing a new Session's widget is the kind of failure that appears the
 * first time anything makes a widget install earlier. `bind` disposes what was
 * bound as well, which is what makes "never two runtimes alive" true whatever
 * a caller does; this makes the ordering explicit rather than incidental.
 *
 * Then the runtime, because everything else needs its services. Then the
 * widget, into the runtime's own Scope, so it leaves when the runtime does.
 * The sink is bound last, because binding it is what makes notifications start
 * flowing and there is no point in that before the Session can render them.
 * The widget reads the sink's hand-off view before that bind, which is safe
 * for the same reason: nothing has settled yet, so no hand-off exists.
 */
export async function startSession(
  wiring: SessionWiring,
  ctx: SessionStartContext,
): Promise<StartedSession> {
  await wiring.handle.release();

  const runtime = ManagedRuntime.make(
    sessionRuntimeLayer({
      backendSet: wiring.backendSet(),
      profiles: { from: "directory", agentDir: wiring.agentDir },
      sink: wiring.sink,
      // Read from the live Session rather than the process: a Session's model
      // catalogue is a Session's, and a Profile is validated against the one
      // it is being loaded into.
      validation: { models: [...(ctx.modelRegistry?.getAll() ?? [])] },
      ...(wiring.policy === undefined ? {} : { policy: wiring.policy }),
    }),
  );

  // Pi's `setWidget` is overloaded against Pi's own `Theme`, which
  // presentation does not name — it works against the three colour functions
  // it actually uses. The cast is where those two views of a theme meet, and
  // it is here rather than in the widget so the widget stays testable with a
  // theme that paints nothing.
  const widgetHost = ctx.ui as unknown as WidgetHost;
  // Disposed rather than orphaned if opening fails. `openSession` is typed as
  // never failing, so this is about a defect — a host context that throws, an
  // unreadable Profile directory — and the alternative is a runtime nothing
  // holds and nothing can ever close.
  let opened: StartedSession;
  try {
    opened = await runtime.runPromise(
      Scope.provide(
        // A read model rather than the sink itself: the widget asks how far a
        // hand-off has got and never decides it.
        openSession(widgetHost, wiring.now, {
          status: wiring.sink.status,
          subscribe: wiring.sink.subscribe,
        }),
        runtime.scope,
      ),
    );
  } catch (failure) {
    await runtime.dispose();
    throw failure;
  }

  await wiring.handle.bind({
    runtime,
    // The sink lives in Pi's message surface rather than in the Scope, so it
    // is the one thing disposal cannot reach and the one thing detached here.
    detach: () => wiring.sink.unbind(),
  });

  wiring.sink.bind(
    (message) =>
      wiring.pi.sendMessage(message, {
        deliverAs: "followUp",
        triggerTurn: true,
      }),
    () => ctx.hasPendingMessages(),
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
