import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAgentGuidelines, getAgentsDir } from "./agents.ts";
import { createDefaultHarnessRegistry } from "./composition.ts";
import type { SessionPush, SubagentDelivery } from "./delivery.ts";
import { createSessionPush, createSubagentDelivery } from "./delivery.ts";
import type { HarnessRegistry } from "./harnesses/contract.ts";
import {
  NOTIFICATION_MESSAGE_TYPE,
  parseNotificationMessage,
  renderNotificationMessage,
} from "./notification-message.ts";
import { isPiChildExtensionLoad } from "./pi-child-extension-load.ts";
import {
  formatAgentResultUnavailable,
  formatCancelOutcome,
  formatResult,
  formatResumeOutcome,
  formatStartResult,
  formatSteerOutcome,
  formatUnknownAgent,
  formatWaitOutcome,
} from "./presentation.ts";
import {
  type CollectedRuns,
  renderMarkdownResult,
  renderResumeResult,
  renderSubagentCall,
} from "./render.ts";
import { getSubagentDepth } from "./runner.ts";
import { createSubagentRuns, type SubagentRuns } from "./runs.ts";
import { createSessionLifecycle } from "./session-lifecycle.ts";
import { createSubagentManager, type SubagentManager } from "./subagents.ts";
import type { AgentConfig, SessionContext } from "./types.ts";

const ID_LIST = Type.Array(Type.String(), {
  description: "Run ids returned by agent_start or agent_resume",
});

export interface SubagentToolRuntime {
  delivery: SubagentDelivery;
  subagents: Pick<SubagentManager, "start" | "resume">;
}

/** Tool seam used by focused tests with a stand-in runtime. */
export function registerSubagentFeatureTools(
  pi: ExtensionAPI,
  session: SessionContext,
  agentConfigs: Map<string, AgentConfig>,
  runtime: SubagentToolRuntime,
): void {
  const { delivery, subagents } = runtime;
  pi.registerMessageRenderer(
    NOTIFICATION_MESSAGE_TYPE,
    renderNotificationMessage,
  );

  const guidelines = formatAgentGuidelines(agentConfigs);

  const requireAgent = (name: string): AgentConfig => {
    const config = agentConfigs.get(name);
    if (config) return config;
    throw new Error(formatUnknownAgent(name, [...agentConfigs.keys()]));
  };

  // pi documents promptSnippet as one line for the Available tools section, so
  // each snippet is a period-less phrase while the full contract stays in description.
  const startSnippet =
    "Create a stable subagent and return its identity and first run id immediately";
  const startDescription =
    "Create a stable Session-scoped subagent and immediately start its first Run. " +
    "Returns distinct Subagent and Run ids, not the answer. Use the Run id for " +
    "agent_wait, agent_result, agent_cancel, and agent_steer; a completion " +
    "notification arrives when the Run finishes. Do not guess at what it will say.";

  pi.registerTool({
    name: "agent_start",
    label: "Start subagent",
    description: startDescription,
    promptSnippet: startSnippet,
    promptGuidelines: guidelines,
    parameters: Type.Object({
      agent: Type.String({ description: "The agent to run the task" }),
      description: Type.String({ description: "Label for this specific run" }),
      prompt: Type.String({ description: "The full task brief" }),
    }),
    renderCall: renderSubagentCall,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = requireAgent(params.agent);

      // Deliberately no signal. The turn's cancellation must not reach a
      // detached run: the point of starting one is that it outlives the turn.
      const started = subagents.start({
        config,
        description: params.description,
        prompt: params.prompt,
        projectTrusted: session.projectTrusted,
        cwd: session.cwd,
        parentModel: ctx.model
          ? {
              provider: ctx.model.provider,
              id: ctx.model.id,
              thinkingLevel: pi.getThinkingLevel(),
            }
          : undefined,
      });
      delivery.register(
        started.runId,
        config.name,
        started.settled,
        started.subagentId,
      );

      return {
        content: [
          {
            type: "text",
            text: formatStartResult(
              config.name,
              started.subagentId,
              started.runId,
            ),
          },
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "agent_resume",
    label: "Resume subagent",
    description:
      "Immediately start a new asynchronous Run on an idle stable Subagent, retaining only Harness-private Conversation context. " +
      "Pass a Subagent id returned by agent_start, not a Run id. Returns the new Run id immediately, not the answer; " +
      "use that Run id for wait, result, cancellation, and steering. Active Subagents reject resume without queueing; " +
      "lost Conversation context starts no Run and requires a new Subagent.",
    promptSnippet:
      "Resume an idle stable subagent and return its new run id immediately",
    promptGuidelines: [
      "agent_resume takes the stable Subagent id from agent_start; agent_wait, agent_result, agent_cancel, and agent_steer take Run ids.",
      "agent_resume returns immediately with a new Run id, not the answer; continue independent work and use agent_wait when only that Run remains.",
      "If agent_resume reports Conversation loss, start a new Subagent; no Run or provider work was started.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "A stable Subagent id returned by agent_start",
      }),
      description: Type.String({ description: "Label for this new Run" }),
      prompt: Type.String({ description: "The full next task brief" }),
    }),
    renderResult: renderResumeResult,

    async execute(_toolCallId, params) {
      const outcome = subagents.resume({
        subagentId: params.id,
        description: params.description,
        prompt: params.prompt,
      });
      if (outcome.outcome === "started") {
        delivery.register(
          outcome.runId,
          outcome.agent,
          outcome.settled,
          params.id,
        );
      }
      return {
        content: [
          { type: "text", text: formatResumeOutcome(params.id, outcome) },
        ],
        details:
          outcome.outcome === "started"
            ? { subagentId: params.id, runId: outcome.runId }
            : undefined,
      };
    },
  });

  const waitSnippet =
    "Block until named runs finish and return lifecycle state only, never output";

  const waitDescription =
    "Block until named Runs finish by Run id and return lifecycle state: identity and " +
    "status, never output. Waiting does not make a run finish sooner, and the " +
    "completion notification arrives either way — but holding the turn keeps " +
    "the answer in front of you, so wait here whenever the run's answer is the " +
    "only thing left to do. Pass every id you are waiting on in one call. " +
    "A still-running result means the timeout expired, not that the run broke.";

  // Guidelines from every tool are flattened into one unattributed list, so
  // each bullet has to name the tool it governs.
  const waitGuidelines = [
    "After agent_start or agent_resume, do the work that does not depend on the Run first; " +
      "when only the run's answer is left, call agent_wait instead of ending " +
      "the turn.",
    "One agent_wait covers a whole barrier: pass every id at once, with a " +
      "timeout_seconds that comfortably exceeds the work you delegated.",
    "agent_wait returning still-running means it timed out, not that the run " +
      "failed — the notification still arrives on its own, so do not " +
      "immediately call agent_wait for the same ids again.",
  ];

  pi.registerTool({
    name: "agent_wait",
    label: "Wait for subagents",
    description: waitDescription,
    promptSnippet: waitSnippet,
    promptGuidelines: waitGuidelines,
    parameters: Type.Object({
      ids: ID_LIST,
      timeout_seconds: Type.Optional(
        Type.Number({
          description:
            "Give up waiting after this long. Prefer a value that comfortably " +
            "exceeds the delegated work; the runs keep going after a timeout " +
            "and notify on their own.",
        }),
      ),
    }),
    renderResult: renderMarkdownResult,

    async execute(_toolCallId, params, signal) {
      const outcome = await delivery.wait(params.ids, {
        ...(params.timeout_seconds === undefined
          ? {}
          : { timeoutMs: params.timeout_seconds * 1_000 }),
        ...(signal ? { signal } : {}),
      });

      const details: CollectedRuns = {
        runs: outcome.terminal.map(({ id, agent, phase }) => ({
          id,
          agent,
          status: phase,
        })),
        stillRunning: outcome.stillRunning.length,
      };
      return {
        content: [{ type: "text", text: formatWaitOutcome(outcome) }],
        details,
      };
    },
  });

  const resultSnippet = "Fetch a finished subagent's full output by run id";
  const resultDescription =
    "Fetch a finished subagent's full output by run id. Use it when a notification " +
    "points to the result, or to re-read a run you were told about earlier.";

  pi.registerTool({
    name: "agent_result",
    label: "Read subagent result",
    description: resultDescription,
    promptSnippet: resultSnippet,
    parameters: Type.Object({
      id: Type.String({
        description: "A Run id returned by agent_start or agent_resume",
      }),
    }),
    renderResult: renderMarkdownResult,

    async execute(_toolCallId, params) {
      const retained = delivery.result(params.id);
      if (!retained) {
        return {
          content: [
            {
              type: "text",
              text: formatAgentResultUnavailable(
                params.id,
                delivery.has(params.id),
              ),
            },
          ],
          details: undefined,
        };
      }

      const details: CollectedRuns = {
        runs: [
          {
            id: retained.id,
            agent: retained.agent,
            status: retained.status,
          },
        ],
      };
      return {
        content: [
          {
            type: "text",
            text: formatResult(retained),
          },
        ],
        details,
      };
    },
  });

  const cancelSnippet = "Stop subagents whose work is no longer needed";
  const cancelDescription =
    "Stop Runs whose work is no longer needed by Run id; never pass a stable Subagent id. " +
    "Partial output remains available through agent_result after cancellation settles, " +
    "and cancellation does not close the owning Subagent.";

  pi.registerTool({
    name: "agent_cancel",
    label: "Cancel subagents",
    description: cancelDescription,
    promptSnippet: cancelSnippet,
    parameters: Type.Object({ ids: ID_LIST }),

    async execute(_toolCallId, params) {
      // Cancellation requests do not claim delivery: each run still stores its
      // terminal result and emits its normal cancellation notification.
      const outcome = delivery.cancel(params.ids);

      return {
        content: [{ type: "text", text: formatCancelOutcome(outcome) }],
        details: undefined,
      };
    },
  });

  const steerSnippet = "Send one guidance message to an active subagent run";
  const steerDescription =
    "Send one guidance message to an active subagent Run. `accepted` means " +
    "only that the complete message synchronously entered its local bounded " +
    "mailbox. It does not mean the Harness dequeued it, a provider accepted " +
    "it, or a model consumed it. Do not retry repeatedly or resend a " +
    "steering message in a loop.";

  pi.registerTool({
    name: "agent_steer",
    label: "Steer subagent",
    description: steerDescription,
    promptSnippet: steerSnippet,
    parameters: Type.Object({
      id: Type.String({
        description: "A Run id returned by agent_start or agent_resume",
      }),
      message: Type.String({
        description:
          "Guidance for the active Run; admitted text is preserved exactly",
      }),
    }),
    renderResult: renderMarkdownResult,

    async execute(_toolCallId, params) {
      const outcome = delivery.steer(params.id, params.message);
      return {
        content: [
          { type: "text", text: formatSteerOutcome(params.id, outcome) },
        ],
        details: undefined,
      };
    },
  });
}

/** Register the session-event boundary that drives notification landing/retry. */
export function registerDeliveryEventHandlers(
  pi: ExtensionAPI,
  delivery: SubagentDelivery,
): void {
  pi.on("message_start", (event) => {
    const notification = parseNotificationMessage(event.message);
    if (notification) delivery.notificationLanded(notification.id);
  });

  pi.on("turn_end", (event, ctx) => {
    delivery.hostTurnCompleted({
      stopReason:
        event.message && "stopReason" in event.message
          ? event.message.stopReason
          : undefined,
      signalAborted: ctx?.signal?.aborted === true,
    });
  });

  pi.on("agent_settled", () => delivery.agentSettled());
}

export interface SubagentRuntimeDependencies {
  agentsDir: string;
  runs?: SubagentRuns;
  sessionPush?: SessionPush;
  harnesses?: HarnessRegistry;
  delivery?: SubagentDelivery;
  subagents?: SubagentManager;
}

export interface SubagentRuntime {
  readonly runs: SubagentRuns;
  readonly sessionPush: SessionPush;
  readonly delivery: SubagentDelivery;
  readonly harnesses: HarnessRegistry;
  readonly subagents: SubagentManager;
  attach(pi: ExtensionAPI): void;
}

/**
 * Compose one process-lifetime runtime from explicit dependencies.
 *
 * The runtime owns the stable registry, push target, delivery, harness
 * registry, session lifecycle, and host-event wiring. `attach` is separate so
 * tests can provide a host without coupling the factory to process state.
 */
export function createSubagentRuntime(
  dependencies: SubagentRuntimeDependencies,
): SubagentRuntime {
  const runs = dependencies.runs ?? createSubagentRuns();
  const sessionPush = dependencies.sessionPush ?? createSessionPush();
  const harnesses = dependencies.harnesses ?? createDefaultHarnessRegistry();
  const delivery =
    dependencies.delivery ??
    createSubagentDelivery({ push: sessionPush.push, runs });
  const subagents =
    dependencies.subagents ?? createSubagentManager({ harnesses, runs });
  return {
    runs,
    sessionPush,
    delivery,
    harnesses,
    subagents,
    attach(pi) {
      const lifecycle = createSessionLifecycle({
        pi,
        agentsDir: dependencies.agentsDir,
        delivery,
        sessionPush,
        runs,
        harnesses,
        subagents,
        registerFeatures: (session, agentConfigs) =>
          registerSubagentFeatureTools(pi, session, agentConfigs, {
            delivery,
            subagents,
          }),
      });

      // The composition root only forwards host events to their owning
      // modules. Delivery's event handlers remain one stable seam.
      pi.on("session_start", (_event, ctx) => lifecycle.sessionStart(ctx));
      pi.on("session_shutdown", () => lifecycle.sessionShutdown());
      registerDeliveryEventHandlers(pi, delivery);
    },
  };
}

/** The process-lifetime runtime for this loaded parent extension factory. */
let processRuntime: SubagentRuntime | null = null;

export default function subagentExtension(pi: ExtensionAPI) {
  // A Pi child loads installed extensions just like its parent. Keep this
  // extension entirely inert there so the model cannot see and repeatedly
  // attempt a tool that the dispatcher would reject anyway. The dispatcher's
  // depth check remains the backstop for direct calls.
  if (isPiChildExtensionLoad() || getSubagentDepth() > 0) return;

  processRuntime ??= createSubagentRuntime({
    agentsDir: getAgentsDir(getAgentDir()),
  });
  processRuntime.attach(pi);
}
