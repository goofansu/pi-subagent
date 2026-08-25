import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  diagnoseAgentModels,
  formatInvalidAgentFilesWarning,
  loadAgentConfigsWithDiagnostics,
} from "./agents.ts";
import { registerAgentsCommand } from "./agents-command.ts";
import type { SessionPush, SubagentDelivery } from "./delivery.ts";
import { buildNotificationMessage } from "./notification-message.ts";
import type { SubagentRuns } from "./runs.ts";
import type { AgentConfig, SessionContext } from "./types.ts";
import type { WidgetHost } from "./widget.ts";
import { installRunsWidget } from "./widget.ts";

export interface SessionStartContext {
  cwd: string;
  modelRegistry: { getAll(): Array<{ provider: string; id: string }> };
  isProjectTrusted?: () => boolean;
  ui: {
    notify(message: string, level: "warning"): void;
    setWidget: WidgetHost["setWidget"];
  };
}

export interface SessionLifecycle {
  sessionStart(ctx: SessionStartContext): void;
  sessionShutdown(): void;
}

export interface SessionLifecycleOptions {
  pi: ExtensionAPI;
  agentsDir: string;
  delivery: SubagentDelivery;
  sessionPush: SessionPush;
  runs: SubagentRuns;
  registerFeatures(
    session: SessionContext,
    agentConfigs: Map<string, AgentConfig>,
  ): void;
}

/** Own the mutable state and host events of one process-lifetime session seam. */
export function createSessionLifecycle({
  pi,
  agentsDir,
  delivery,
  sessionPush,
  runs,
  registerFeatures,
}: SessionLifecycleOptions): SessionLifecycle {
  // These objects are deliberately stable: tools and commands register once,
  // then every session refills the same references they closed over.
  const agentConfigs = new Map<string, AgentConfig>();
  const sessionContext: SessionContext = {
    cwd: process.cwd(),
    projectTrusted: false,
  };
  let registered = false;
  let uninstallWidget: (() => void) | null = null;

  return {
    sessionStart(ctx) {
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
      sessionContext.cwd = ctx.cwd;
      sessionContext.projectTrusted = ctx.isProjectTrusted?.() ?? false;

      sessionPush.bind((notification) => {
        pi.sendMessage(buildNotificationMessage(notification), {
          deliverAs: "followUp",
          triggerTurn: true,
        });
      });
      uninstallWidget?.();
      uninstallWidget = installRunsWidget(ctx.ui, runs);

      if (!registered) {
        registered = true;
        registerAgentsCommand(pi, agentConfigs, agentsDir);
        registerFeatures(sessionContext, agentConfigs);
      }

      const invalidFiles = [
        ...parsedAgents.invalidFiles,
        ...diagnosedModels.invalidFiles,
      ];
      if (invalidFiles.length > 0) {
        ctx.ui.notify(formatInvalidAgentFilesWarning(invalidFiles), "warning");
      }
    },

    sessionShutdown() {
      sessionPush.unbind();
      uninstallWidget?.();
      uninstallWidget = null;
      delivery.shutdown();
    },
  };
}
