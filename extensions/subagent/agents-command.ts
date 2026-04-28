import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  Markdown,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { AgentConfig } from "./types.js";

type AgentAction = "view" | "work";

type KeybindingMatcher = {
  matches(data: string, action: string): boolean;
};

function formatAgentListDescription(agent: AgentConfig): string {
  const prefix = agent.source === "user" ? "[u]" : "[d]";
  return `${prefix} ${agent.description}`;
}

export function getAgentSelectItems(
  agentConfigs: ReadonlyMap<string, AgentConfig>,
): SelectItem[] {
  return [...agentConfigs.values()].map((agent) => ({
    value: agent.name,
    label: agent.name,
    description: formatAgentListDescription(agent),
  }));
}

export function getAgentActionItems(): SelectItem[] {
  return [
    { value: "view", label: "view", description: "View agent" },
    {
      value: "work",
      label: "work",
      description: "Work on task with this agent",
    },
  ];
}

export function formatAgentPromptMarkdown(agent: AgentConfig): string {
  return agent.systemPrompt.trim() || "_No prompt configured._";
}

export function getAgentDetailMarkdownText(agent: AgentConfig): string {
  return formatAgentPromptMarkdown(agent);
}

export function buildAgentWorkMessage(agentName: string, task: string): string {
  return `Use the subagent tool with agent "${agentName}" for the task: ${task}`;
}

export function formatAgentListHint(
  separator: string,
  renderKeyHint = keyHint,
): string {
  return `${renderKeyHint("tui.select.confirm", "actions")}${separator}${renderKeyHint("tui.select.cancel", "close")}`;
}

export function formatAgentActionHint(
  separator: string,
  renderKeyHint = keyHint,
): string {
  return `${renderKeyHint("tui.select.confirm", "to confirm")}${separator}${renderKeyHint("tui.select.cancel", "back")}`;
}

type AgentWorkContext = {
  ui: Pick<ExtensionCommandContext["ui"], "notify">;
  waitForIdle(): Promise<void>;
};

export async function runAgentWorkFlow(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: AgentWorkContext,
  agent: AgentConfig,
  task: string | undefined,
  closeAgentsUi: () => void,
): Promise<void> {
  const trimmedTask = task?.trim();
  if (!trimmedTask) {
    ctx.ui.notify("Cancelled", "info");
    closeAgentsUi();
    return;
  }

  await ctx.waitForIdle();
  pi.sendUserMessage(buildAgentWorkMessage(agent.name, trimmedTask));
  closeAgentsUi();
}

class AgentsListComponent extends Container {
  private selectList: SelectList;

  constructor(
    theme: Theme,
    items: SelectItem[],
    onSelect: (agentName: string) => void | Promise<void>,
    onCancel: () => void,
  ) {
    super();

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(new Text(theme.fg("accent", theme.bold("Agents")), 1, 0));
    this.addChild(new Spacer(1));

    this.selectList = new SelectList(items, Math.min(items.length, 15), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    this.selectList.onSelect = (item) => {
      void onSelect(String(item.value));
    };
    this.selectList.onCancel = onCancel;

    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(formatAgentListHint(theme.fg("dim", " • ")), 1, 0));
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  }

  handleInput(keyData: string): void {
    this.selectList.handleInput(keyData);
  }
}

class AgentActionMenuComponent extends Container {
  private selectList: SelectList;

  constructor(
    theme: Theme,
    agent: AgentConfig,
    onSelect: (action: AgentAction) => void,
    onCancel: () => void,
  ) {
    super();

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(
      new Text(
        theme.fg("accent", theme.bold(`Actions for ${agent.name}`)),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));

    this.selectList = new SelectList(
      getAgentActionItems(),
      getAgentActionItems().length,
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    );
    this.selectList.onSelect = (item) => onSelect(item.value as AgentAction);
    this.selectList.onCancel = onCancel;

    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(formatAgentActionHint(theme.fg("dim", " • ")), 1, 0),
    );
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  }

  handleInput(keyData: string): void {
    this.selectList.handleInput(keyData);
  }
}

class AgentDetailOverlayComponent {
  private markdown: Markdown;
  private scrollOffset = 0;
  private viewHeight = 0;
  private totalLines = 0;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keybindings: KeybindingMatcher,
    private agent: AgentConfig,
    private onBack: () => void,
  ) {
    this.markdown = new Markdown(
      getAgentDetailMarkdownText(agent),
      1,
      0,
      getMarkdownTheme(),
    );
  }

  handleInput(keyData: string): void {
    if (this.keybindings.matches(keyData, "tui.select.cancel")) {
      this.onBack();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      this.scrollBy(-1);
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.down")) {
      this.scrollBy(1);
      return;
    }
    if (
      this.keybindings.matches(keyData, "tui.select.pageUp") ||
      matchesKey(keyData, Key.left)
    ) {
      this.scrollBy(-this.viewHeight || -1);
      return;
    }
    if (
      this.keybindings.matches(keyData, "tui.select.pageDown") ||
      matchesKey(keyData, Key.right)
    ) {
      this.scrollBy(this.viewHeight || 1);
    }
  }

  render(width: number): string[] {
    const maxHeight = this.getMaxHeight();
    const headerLines = 3;
    const footerLines = 2;
    const borderLines = 2;
    const innerWidth = Math.max(10, width - 2);
    const contentHeight = Math.max(
      1,
      maxHeight - headerLines - footerLines - borderLines,
    );

    const markdownLines = this.markdown.render(innerWidth);
    this.totalLines = markdownLines.length;
    this.viewHeight = contentHeight;
    const maxScroll = Math.max(0, this.totalLines - contentHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    const lines: string[] = [];
    lines.push(this.buildTitleLine(innerWidth));
    lines.push("");
    lines.push(
      ...markdownLines.slice(
        this.scrollOffset,
        this.scrollOffset + contentHeight,
      ),
    );
    while (lines.length < headerLines + contentHeight) lines.push("");
    lines.push("");
    lines.push(this.buildActionLine(innerWidth));

    const borderColor = (text: string) => this.theme.fg("borderMuted", text);
    const framed = lines.map((line) => {
      const truncated = truncateToWidth(line, innerWidth);
      const padding = Math.max(0, innerWidth - visibleWidth(truncated));
      return `${borderColor("│")}${truncated}${" ".repeat(padding)}${borderColor("│")}`;
    });

    return [
      borderColor(`┌${"─".repeat(innerWidth)}┐`),
      ...framed,
      borderColor(`└${"─".repeat(innerWidth)}┘`),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.markdown = new Markdown(
      getAgentDetailMarkdownText(this.agent),
      1,
      0,
      getMarkdownTheme(),
    );
  }

  private getMaxHeight(): number {
    const rows = this.tui.terminal.rows || 24;
    return Math.max(10, Math.floor(rows * 0.8));
  }

  private buildTitleLine(width: number): string {
    const titleText = ` ${this.agent.name} `;
    const titleWidth = visibleWidth(titleText);
    if (titleWidth >= width) {
      return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
    }
    const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
    const rightWidth = Math.max(0, width - titleWidth - leftWidth);
    return (
      this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
      this.theme.fg("accent", titleText) +
      this.theme.fg("borderMuted", "─".repeat(rightWidth))
    );
  }

  private buildActionLine(width: number): string {
    let line = [
      this.theme.fg("dim", "esc back"),
      this.theme.fg("dim", "↑/↓ scroll"),
      this.theme.fg("dim", "←/→ page"),
    ].join(this.theme.fg("muted", " • "));

    if (this.totalLines > this.viewHeight) {
      const start = Math.min(this.totalLines, this.scrollOffset + 1);
      const end = Math.min(
        this.totalLines,
        this.scrollOffset + this.viewHeight,
      );
      line += this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
    }

    return truncateToWidth(line, width);
  }

  private scrollBy(delta: number): void {
    const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
    this.scrollOffset = Math.max(
      0,
      Math.min(this.scrollOffset + delta, maxScroll),
    );
  }
}

async function openAgentDetail(
  ctx: ExtensionCommandContext,
  agent: AgentConfig,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, overlayTheme, keybindings, overlayDone) =>
      new AgentDetailOverlayComponent(
        tui,
        overlayTheme,
        keybindings,
        agent,
        () => overlayDone(undefined),
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        maxHeight: "80%",
        anchor: "center",
      },
    },
  );
}

export function registerAgentsCommand(
  pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">,
  agentConfigs: ReadonlyMap<string, AgentConfig>,
) {
  pi.registerCommand("agents", {
    description: "List loaded subagents and view their prompts.",
    handler: async (_args, ctx) => {
      const items = getAgentSelectItems(agentConfigs);
      if (items.length === 0) {
        ctx.ui.notify("No subagents are configured.", "info");
        return;
      }

      await ctx.ui.custom<void>((rootTui, theme, _keybindings, done) => {
        type ActiveComponent = {
          render(width: number): string[];
          invalidate(): void;
          handleInput?(data: string): void;
        };

        let activeComponent: ActiveComponent;

        const setActiveComponent = (component: ActiveComponent) => {
          activeComponent = component;
          rootTui.requestRender();
        };

        const openActionMenu = (agent: AgentConfig) => {
          setActiveComponent(
            new AgentActionMenuComponent(
              theme,
              agent,
              async (action) => {
                if (action === "view") {
                  await openAgentDetail(ctx, agent);
                  rootTui.requestRender();
                  return;
                }

                const task = await ctx.ui.editor(
                  `What task should ${agent.name} handle?`,
                );
                await runAgentWorkFlow(pi, ctx, agent, task, () =>
                  done(undefined),
                );
              },
              () => setActiveComponent(agentList),
            ),
          );
        };

        const agentList = new AgentsListComponent(
          theme,
          items,
          (agentName) => {
            const agent = agentConfigs.get(agentName);
            if (agent) openActionMenu(agent);
          },
          () => done(undefined),
        );

        activeComponent = agentList;

        return {
          render: (width: number) => activeComponent.render(width),
          invalidate: () => activeComponent.invalidate(),
          handleInput: (data: string) => activeComponent.handleInput?.(data),
        };
      });
    },
  });
}
