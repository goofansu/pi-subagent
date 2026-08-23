import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  diagnoseAgentModels,
  formatAgentGuidelines,
  formatInvalidAgentFilesWarning,
  getAgentsDir,
  loadAgentConfigsWithDiagnostics,
} from "./agents.ts";
import { registerAgentsCommand } from "./agents-command.ts";
import type { SubagentDelivery } from "./delivery.ts";
import { createSubagentDelivery } from "./delivery.ts";
import { renderMarkdownResult, renderSubagentCall } from "./render.ts";
import { REPORT_MESSAGE_TYPE, renderReportMessage } from "./report-message.ts";
import { getSubagentDepth, startSubagent } from "./runner.ts";
import type { SubagentRuns } from "./runs.ts";
import { subagentRuns } from "./runs.ts";
import type { AgentConfig } from "./types.ts";
import type { WidgetHost } from "./widget.ts";
import { installRunsWidget } from "./widget.ts";

const ID_LIST = Type.Array(Type.String(), {
  description: "Run ids returned by agent_start",
});

export interface SubagentFeatureDeps {
  delivery?: SubagentDelivery;
  runs?: SubagentRuns;
  /** Injected for tests; defaults to starting a real child pi. */
  start?: typeof startSubagent;
  /** Where the runs widget is installed. Omitted in non-interactive hosts. */
  widgetHost?: WidgetHost;
}

export function registerSubagentFeatures(
  pi: ExtensionAPI,
  projectCwd: string,
  agentsDir: string,
  agentConfigs: Map<string, AgentConfig>,
  projectTrusted: boolean,
  deps: SubagentFeatureDeps = {},
): void {
  registerAgentsCommand(pi, agentConfigs, agentsDir);

  const runs = deps.runs ?? subagentRuns;
  const start = deps.start ?? startSubagent;
  pi.registerMessageRenderer(REPORT_MESSAGE_TYPE, renderReportMessage);

  const delivery =
    deps.delivery ??
    createSubagentDelivery({
      push: (report) => {
        // A custom message rather than a user message, so the report carries a
        // renderer and shows as one collapsed line until it is asked for.
        //
        // Both options matter. `deliverAs: "followUp"` covers the case where
        // the model is mid-turn: the report waits until it finishes rather
        // than cutting into it. `triggerTurn` covers the case where the
        // session is idle, and without it the report would sit unread in
        // context until the operator happened to type something — which
        // defeats delegating the work in the first place. Together they mean
        // the model always gets a chance to act on a report, and never in the
        // middle of a sentence.
        pi.sendMessage(
          {
            customType: REPORT_MESSAGE_TYPE,
            content: report.text,
            display: true,
            details: {
              id: report.id,
              agent: report.agent,
              status: report.status,
              truncated: report.truncated,
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
      runs,
    });

  if (deps.widgetHost) installRunsWidget(deps.widgetHost, runs);

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
    "not the answer: the agent's report arrives on its own when it finishes. " +
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
        projectTrusted,
        cwd: projectCwd,
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
              "Its report will arrive when it finishes; carry on until then.",
          },
        ],
        details: undefined,
      };
    },
  });

  const waitDescription =
    "Wait for started subagents to finish and return their reports. Use only " +
    "when you cannot continue without the answer; otherwise carry on and let " +
    "the reports arrive.";

  pi.registerTool({
    name: "agent_wait",
    label: "Wait for subagents",
    description: waitDescription,
    promptSnippet: waitDescription,
    parameters: Type.Object({
      ids: ID_LIST,
      timeout_seconds: Type.Optional(
        Type.Number({
          description:
            "Give up waiting after this long. The runs keep going and report " +
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

      const sections = [...outcome.reports];
      if (outcome.stillRunning.length > 0) {
        sections.push(
          `Still running: ${outcome.stillRunning.join(", ")}. ` +
            "They will report on their own.",
        );
      }
      if (sections.length === 0) {
        sections.push(
          "Nothing to wait for — those runs have already reported.",
        );
      }

      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: {
          runs: outcome.collected,
          stillRunning: outcome.stillRunning.length,
        },
      };
    },
  });

  const resultDescription =
    "Fetch a finished subagent's full output by run id. Use it when a report " +
    "says it was trimmed, or to re-read a run you were told about earlier.";

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
      const report = delivery.recall(params.id);
      if (!report) {
        return {
          content: [
            {
              type: "text",
              text:
                `No finished run with id ${params.id}. ` +
                "Runs can be read once they have reported.",
            },
          ],
          details: undefined,
        };
      }

      const body =
        report.output ||
        (report.status === "aborted"
          ? "The run was cancelled before it produced output."
          : "The run finished without output.");

      return {
        content: [
          { type: "text", text: `${report.agent} (${report.id}):\n\n${body}` },
        ],
        details: {
          runs: [{ id: report.id, agent: report.agent, status: report.status }],
        },
      };
    },
  });

  const cancelDescription =
    "Stop subagents whose work is no longer needed. Anything they have not " +
    "finished is discarded.";

  pi.registerTool({
    name: "agent_cancel",
    label: "Cancel subagents",
    description: cancelDescription,
    promptSnippet: cancelDescription,
    parameters: Type.Object({ ids: ID_LIST }),

    async execute(_toolCallId, params) {
      const cancelled = runs.cancel(params.ids);
      // The model asked, so this tool result is the delivery for these runs;
      // a pushed "was cancelled" message would just repeat it back.
      delivery.deliverInline(cancelled);

      return {
        content: [
          {
            type: "text",
            text:
              cancelled.length > 0
                ? `Cancelled: ${cancelled.join(", ")}.`
                : "Nothing to cancel — those runs had already finished.",
          },
        ],
        details: undefined,
      };
    },
  });
}

export default function subagentExtension(pi: ExtensionAPI) {
  // A Pi child loads installed extensions just like its parent. Keep this
  // extension entirely inert there so the model cannot see and repeatedly
  // attempt a tool that the dispatcher would reject anyway. The dispatcher's
  // depth check remains the backstop for direct calls.
  if (getSubagentDepth() > 0) return;

  const agentsDir = getAgentsDir(getAgentDir());

  // One map for the process, refilled on reload rather than replaced, so the
  // tool and command closures registered below keep seeing current profiles.
  const agentConfigs = new Map<string, AgentConfig>();
  let registered = false;

  // Agents come only from user scope, so discovery reads nothing a working
  // directory controls and needs no trust decision of its own.
  //
  // A child pi is a different matter: it runs in the project directory and
  // resolves its own settings, resources, and packages there. Pi has already
  // decided whether this directory is trusted — see
  // https://pi.dev/docs/latest/security#project-trust — so read its answer and
  // forward it rather than deriving a second one. A child runs
  // non-interactively and could neither prompt nor see a session-only decision
  // on its own. A host that cannot report at all fails closed.
  pi.on("session_start", (_event, ctx) => {
    const parsedAgents = loadAgentConfigsWithDiagnostics(agentsDir);
    const diagnosedModels = diagnoseAgentModels(
      parsedAgents.configs,
      agentsDir,
      ctx.modelRegistry.getAll(),
    );
    agentConfigs.clear();
    for (const [name, config] of diagnosedModels.configs) {
      agentConfigs.set(name, config);
    }

    // session_start also fires on reload, resume and fork. Registering again
    // would install a second copy of every tool — and, once runs outlive a
    // turn, a second registry beside children that are still alive.
    if (!registered) {
      registered = true;
      registerSubagentFeatures(
        pi,
        ctx.cwd,
        agentsDir,
        agentConfigs,
        ctx.isProjectTrusted?.() ?? false,
        { widgetHost: ctx.ui as unknown as WidgetHost },
      );
    }

    const invalidFiles = [
      ...parsedAgents.invalidFiles,
      ...diagnosedModels.invalidFiles,
    ];
    if (invalidFiles.length > 0) {
      ctx.ui.notify(formatInvalidAgentFilesWarning(invalidFiles), "warning");
    }
  });
}
