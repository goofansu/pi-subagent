import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAgentGuidelines, getAgentsDir } from "./agents.ts";
import type { SubagentDelivery } from "./delivery.ts";
import { createSessionPush, createSubagentDelivery } from "./delivery.ts";
import {
  NOTIFICATION_MESSAGE_TYPE,
  parseNotificationMessage,
  renderNotificationMessage,
} from "./notification-message.ts";
import { renderMarkdownResult, renderSubagentCall } from "./render.ts";
import { getSubagentDepth, startSubagent } from "./runner.ts";
import type { SubagentRuns } from "./runs.ts";
import { subagentRuns } from "./runs.ts";
import { createSessionLifecycle } from "./session-lifecycle.ts";
import type { AgentConfig, SessionContext } from "./types.ts";

const ID_LIST = Type.Array(Type.String(), {
  description: "Run ids returned by agent_start",
});

interface SubagentToolRuntime {
  delivery: SubagentDelivery;
  runs: SubagentRuns;
  start: typeof startSubagent;
}

/** Production feature registrar: all runtime policy is already composed. */
export function registerSubagentFeatures(
  pi: ExtensionAPI,
  session: SessionContext,
  agentConfigs: Map<string, AgentConfig>,
  delivery: SubagentDelivery,
): void {
  registerSubagentFeatureTools(pi, session, agentConfigs, {
    delivery,
    runs: subagentRuns,
    start: startSubagent,
  });
}

/** Tool seam used by focused tests with a stand-in runtime. */
export function registerSubagentFeatureTools(
  pi: ExtensionAPI,
  session: SessionContext,
  agentConfigs: Map<string, AgentConfig>,
  runtime: SubagentToolRuntime,
): void {
  const { delivery, runs, start } = runtime;
  pi.registerMessageRenderer(
    NOTIFICATION_MESSAGE_TYPE,
    renderNotificationMessage,
  );

  const guidelines = formatAgentGuidelines(agentConfigs);

  const requireAgent = (name: string): AgentConfig => {
    const config = agentConfigs.get(name);
    if (config) return config;
    throw new Error(
      `Unknown agent: "${name}". Available: ${
        [...agentConfigs.keys()].join(", ") || "none"
      }`,
    );
  };

  const startDescription =
    "Start a subagent on a task and return immediately. Returns a run id, " +
    "not the answer: a completion notification arrives when it finishes. " +
    "Do not guess at what it will say.";

  pi.registerTool({
    name: "agent_start",
    label: "Start subagent",
    description: startDescription,
    promptSnippet: startDescription,
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
      const started = start({
        config,
        description: params.description,
        prompt: params.prompt,
        projectTrusted: session.projectTrusted,
        cwd: session.cwd,
        runs,
        parentModel: ctx.model
          ? {
              provider: ctx.model.provider,
              id: ctx.model.id,
              thinkingLevel: pi.getThinkingLevel(),
            }
          : undefined,
      });
      delivery.register(started.id, started.settled);

      return {
        content: [
          {
            type: "text",
            text:
              `Started ${config.name} as run ${started.id}. ` +
              "Its notification will arrive when it finishes; carry on until then.",
          },
        ],
        details: undefined,
      };
    },
  });

  const waitDescription =
    "Wait for started subagents to become terminal and return lifecycle state only. " +
    "Use only when you cannot proceed; the answer arrives via notification and agent_result.";

  pi.registerTool({
    name: "agent_await",
    label: "Await subagents",
    description: waitDescription,
    promptSnippet: waitDescription,
    parameters: Type.Object({
      ids: ID_LIST,
      timeout_seconds: Type.Optional(
        Type.Number({
          description:
            "Give up waiting after this long. The runs keep going and notify " +
            "on their own.",
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

      const sections = outcome.terminal.map(
        (run) =>
          `${run.agent} (${run.id}): ${run.phase}${
            run.reason ? ` (${run.reason})` : ""
          }`,
      );
      if (outcome.stillRunning.length > 0)
        sections.push(`Still running: ${outcome.stillRunning.join(", ")}.`);
      if (outcome.unknown.length > 0)
        sections.push(`Unknown run ids: ${outcome.unknown.join(", ")}.`);
      if (sections.length === 0) sections.push("No run ids were given.");

      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: {
          runs: outcome.terminal.map(({ id, agent, phase }) => ({
            id,
            agent,
            status: phase,
          })),
          stillRunning: outcome.stillRunning.length,
        },
      };
    },
  });

  const resultDescription =
    "Fetch a finished subagent's full output by run id. Use it when a notification " +
    "points to the result, or to re-read a run you were told about earlier.";

  pi.registerTool({
    name: "agent_result",
    label: "Read subagent result",
    description: resultDescription,
    promptSnippet: resultDescription,
    parameters: Type.Object({
      id: Type.String({ description: "A run id returned by agent_start" }),
    }),
    renderResult: renderMarkdownResult,

    async execute(_toolCallId, params) {
      const retained = delivery.result(params.id);
      if (!retained) {
        return {
          content: [
            {
              type: "text",
              text: delivery.has(params.id)
                ? `Run ${params.id} has not finished yet. Its notification will ` +
                  "arrive on its own; agent_await blocks for it if you cannot " +
                  "continue without it."
                : `No run with id ${params.id}. Check it against what ` +
                  "agent_start returned.",
            },
          ],
          details: undefined,
        };
      }

      const body =
        retained.output ||
        (retained.evicted
          ? "This run's full output was evicted to bound result-store memory."
          : retained.status === "cancelled"
            ? "The run was cancelled before it produced output."
            : "The run finished without output.");

      return {
        content: [
          {
            type: "text",
            text: `${retained.agent} (${retained.id}):\n\n${body}`,
          },
        ],
        details: {
          runs: [
            {
              id: retained.id,
              agent: retained.agent,
              status: retained.status,
            },
          ],
        },
      };
    },
  });

  const cancelDescription =
    "Stop subagents whose work is no longer needed. Partial output remains " +
    "available through agent_result after cancellation settles.";

  pi.registerTool({
    name: "agent_cancel",
    label: "Cancel subagents",
    description: cancelDescription,
    promptSnippet: cancelDescription,
    parameters: Type.Object({ ids: ID_LIST }),

    async execute(_toolCallId, params) {
      // Cancellation requests do not claim delivery: each run still stores its
      // terminal result and emits its normal cancellation notification.
      const outcome = delivery.cancel(params.ids);

      const parts: string[] = [];
      if (outcome.cancelled.length > 0)
        parts.push(`Cancelled: ${outcome.cancelled.join(", ")}.`);
      if (outcome.finished.length > 0) {
        parts.push(
          `Already finished, result kept: ${outcome.finished.join(", ")}.`,
        );
      }
      if (outcome.unknown.length > 0) {
        parts.push(`Unknown run ids: ${outcome.unknown.join(", ")}.`);
      }
      if (parts.length === 0) parts.push("Nothing to cancel.");

      return {
        content: [{ type: "text", text: parts.join(" ") }],
        details: undefined,
      };
    },
  });
}

// ── Process-lifetime state ────────────────────────────────────────────────────
//
// Runs are detached from the *turn*, not from the session: every
// session_shutdown cancels them because notifications and results belong to
// the conversation that asked. Pi caches the extension factory across session
// replacement, so this module instance outlives any one session. The stable
// push seam drops notices that settle during teardown rather than calling a
// stale ExtensionAPI.

/** Stable push target aimed at the current live session. */
const sessionPush = createSessionPush();

/** The one delivery for the process, lazily built over the shared registry. */
let processDelivery: SubagentDelivery | null = null;

function getProcessDelivery(): SubagentDelivery {
  processDelivery ??= createSubagentDelivery({
    push: sessionPush.push,
    runs: subagentRuns,
  });
  return processDelivery;
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

  pi.on("turn_end", (event) => {
    const message = event.message as { stopReason?: string } | undefined;
    if (message?.stopReason === "aborted") delivery.turnAborted();
  });

  pi.on("agent_settled", () => delivery.agentSettled());
}

/** Register session shutdown cleanup at the host event boundary. */
export function registerShutdownEventHandler(
  pi: ExtensionAPI,
  delivery: SubagentDelivery,
  beforeShutdown: () => void = () => {},
): void {
  pi.on("session_shutdown", () => {
    beforeShutdown();
    delivery.shutdown();
  });
}

export default function subagentExtension(pi: ExtensionAPI) {
  // A Pi child loads installed extensions just like its parent. Keep this
  // extension entirely inert there so the model cannot see and repeatedly
  // attempt a tool that the dispatcher would reject anyway. The dispatcher's
  // depth check remains the backstop for direct calls.
  if (getSubagentDepth() > 0) return;

  const delivery = getProcessDelivery();
  const lifecycle = createSessionLifecycle({
    pi,
    agentsDir: getAgentsDir(getAgentDir()),
    delivery,
    sessionPush,
    runs: subagentRuns,
    registerFeatures: (session, agentConfigs) =>
      registerSubagentFeatures(pi, session, agentConfigs, delivery),
  });

  // The composition root only wires host events to their owning modules.
  pi.on("session_start", (_event, ctx) => lifecycle.sessionStart(ctx));
  pi.on("session_shutdown", () => lifecycle.sessionShutdown());
  registerDeliveryEventHandlers(pi, delivery);
}
