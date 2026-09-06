import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Profile } from "./domain/index.ts";
import {
  NOTIFICATION_MESSAGE_TYPE,
  renderNotificationMessage,
} from "./host/notification-message.ts";
import type { ProductionBackendSet } from "./host/production-backends.ts";
import { createProductionBackendSet } from "./host/production-backends.ts";
import type { SessionPushSink } from "./host/push-sink.ts";
import { createSessionPushSink } from "./host/push-sink.ts";
import { shutdownSession, startSession } from "./host/session.ts";
import type { SessionHandle } from "./host/session-handle.ts";
import { createSessionHandle } from "./host/session-handle.ts";
import type { AdapterProbe } from "./host/subagent-command.ts";
import { registerSubagentCommand } from "./host/subagent-command.ts";
import { registerSubagentTools } from "./host/tools.ts";
import type { ActiveWidget } from "./host/widget.ts";
import { profilesDir } from "./profiles/discovery.ts";
import type {
  BackendSet,
  SessionRuntimeOptions,
} from "./runtime/composition.ts";
import type { RuntimePolicy } from "./runtime/policy.ts";
import type { ResultEncoder } from "./runtime/result-store.ts";

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
  /**
   * The bounds each Session's runtime enforces.
   *
   * Omitted means the defaults, which is what a real Pi process wants. It is
   * an option because the bounds are configuration rather than policy the host
   * decides — and because a test proving what happens *at* a bound has to be
   * able to lower it.
   */
  readonly policy?: RuntimePolicy;
  /** Test seam overriding the Session clock for deterministic host tests. */
  readonly clock?: SessionRuntimeOptions["clock"];
  /**
   * Test-only Result-encoding seam; composition documents why it is not a
   * production encoding policy.
   */
  readonly resultEncoder?: ResultEncoder;
  /** Reads the wall clock. Supplied by a test so widget durations are fixed. */
  readonly now?: () => number;
  /**
   * What the live backend adapters are still holding, one block per backend,
   * for the diagnostics command.
   *
   * Outside the backend contract on purpose: a probe on the contract would be
   * a number the core could start believing. It is reported beside the
   * runtime's own counters because dogfood needs both in one place — the
   * runtime's probe says whether the core leaked, and these say whether an
   * adapter did, and which one.
   */
  readonly probe?: () => AdapterProbe | undefined;
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
 * - the registrations themselves: seven tools, one command, one message
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
  // The two host facts the backend set answers, read once, before anything is
  // registered. A set is cheap to build and performs no provider work, so
  // asking one and discarding it costs nothing; each Session gets its own.
  const hostFacts = options.backendSet();
  if (hostFacts.isChildLoad() || hostFacts.childDepth() > 0) {
    // Inert inside a child. Registering the delegation tools there would show
    // a model seven tools it is not allowed to use, and it would try: the depth
    // check in admission is the backstop, not the answer. Nothing is
    // registered and no Session event is subscribed to, so this process
    // behaves as though the extension were not installed at all.
    return {
      handle,
      sink,
      profiles: () => [],
      agentGuidelines: () => [],
      widget: () => undefined,
    };
  }
  /** Rewritten in place per Session; see `SessionWiring.agentGuidelines`. */
  const agentGuidelines: string[] = [];
  /** The live Session's Profiles, for `/subagent` to count and list. */
  let profiles: readonly Profile[] = [];
  let widget: ActiveWidget | undefined;

  const wiring = {
    pi,
    handle,
    sink,
    backendSet: options.backendSet,
    agentDir: options.agentDir,
    agentGuidelines,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.resultEncoder === undefined
      ? {}
      : { resultEncoder: options.resultEncoder }),
    setProfiles: (loaded: readonly Profile[]) => {
      profiles = loaded;
    },
    now: options.now ?? (() => Date.now()),
  };

  const agentsDir = profilesDir(options.agentDir);
  registerSubagentTools(
    pi,
    handle,
    agentGuidelines,
    hostFacts.childDepth,
    // Two narrow functions rather than the sink, exactly as the widget is
    // handed a read model: the result and wait handlers say the parent has a
    // Result, the wait handlers say which Runs they are about to wait on, and
    // neither can push anything.
    { consumed: (id) => sink.consumed(id), hold: (scope) => sink.hold(scope) },
  );
  // One operator command. v1's `/agents` is gone in 2.0 and its flow is
  // `/subagent profiles`, which is the one public surface 2.0 removes.
  registerSubagentCommand(
    pi,
    handle,
    () => options.probe?.(),
    // Plain counts rather than the sink, for the reason the tools get one
    // function and the widget gets a read model.
    () => ({ ...sink.counts() }),
    () => profiles,
    agentsDir,
  );
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
  // decision; the entry point only forwards neutral evidence to it. The fourth
  // way a hand-off resolves — the parent being handed the Result, by
  // `agent_result` or by a wait — is not a host event, so it arrives through
  // the tool handlers above.
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
 * The backend set is the **production set**: Pi and Claude, no built-in
 * Profiles, and the two host facts that make this process inert inside a
 * child. The demo set and the Pi-only set stay in the tree because a host test
 * and Pi's own live lane need them, but nothing ships either.
 *
 * The set is built once here rather than per Session so that the probes the
 * diagnostics command reports are the live adapters'. Each Session still gets
 * its own backends, because `createProductionBackendSet` is called for each
 * one.
 */
export default function subagentV2Extension(pi: ExtensionAPI): void {
  let live: ProductionBackendSet | undefined;
  installSubagentV2(pi, {
    agentDir: getAgentDir(),
    backendSet: () => {
      live = createProductionBackendSet();
      return live.set;
    },
    // Handed on as the set reported it: the command prints whatever each
    // adapter is counting, and naming a provider's own fields here would put
    // provider vocabulary in the entry point.
    probe: () => live?.probe(),
  });
}
