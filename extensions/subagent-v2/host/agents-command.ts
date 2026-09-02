/**
 * `/agents`: list the Profiles this Session loaded, and open their prompts.
 *
 * Ported from v1, structure and keys included, over the v2 Profile catalog's
 * list. The three things a user does with it — filter the list, read a
 * Profile's prompt, hand a Profile some work — are the compatibility matrix's
 * `/agents` row, and the port keeps them because a command whose keys moved is
 * a command a user has to relearn.
 *
 * What changed is only where the list comes from: v1 read a `Map` the session
 * lifecycle refilled, and this reads whatever the live Session runtime's
 * `ProfileCatalog` holds. A Session with no runtime has no Profiles, which is
 * the same answer as a Session with no Profile files: say where to put one.
 *
 * The list is deliberately backend-independent. A Profile appears by name and
 * description whatever backend it names, and no backend-specific field is
 * shown — a user choosing a specialist is choosing a specialist, not a
 * provider.
 */

import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
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
} from "@earendil-works/pi-tui";
import type { Profile } from "../domain/index.ts";

/** The command name. */
export const AGENTS_COMMAND_NAME = "agents";

type AgentAction = "view" | "work";

const AGENT_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

/** How many Profiles the list shows before it starts scrolling. */
const MAX_VISIBLE_PROFILE_ROWS = 15;

interface KeybindingMatcher {
  matches(data: string, action: string): boolean;
}

/**
 * The five colours a `SelectList` paints, in one place.
 *
 * Both lists in this command — the Profile list and the action menu — take the
 * same five, and v1 spelled them out twice. Two copies of a palette is two
 * places for a theme change to be applied in one of.
 */
function selectListStyle(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

/** Whether a select item's value is one of the two actions on offer. */
function isAgentAction(value: unknown): value is AgentAction {
  return value === "view" || value === "work";
}

/** One list item per Profile: its name, and what it is for. */
export function getAgentSelectItems(
  profiles: readonly Profile[],
): SelectItem[] {
  return profiles.map((profile) => ({
    value: profile.name,
    label: profile.name,
    description: profile.description,
  }));
}

/**
 * Narrow the list by a query, fuzzily, across name and description.
 *
 * An empty or whitespace-only query is not a filter that matches nothing — it
 * is no filter, which is what a user who has just cleared the box means.
 */
export function getFilteredAgentSelectItems(
  items: readonly SelectItem[],
  query: string,
): SelectItem[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];
  return fuzzyFilter(
    [...items],
    trimmed,
    (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
  );
}

/** The two things a user can do with a Profile: read it, or hand it work. */
export function getAgentActionItems(): SelectItem[] {
  return [
    { value: "view", label: "View" },
    { value: "work", label: "Work" },
  ];
}

/** The action menu's title, which names the Profile it is about. */
export function formatAgentActionTitle(agentName: string): string {
  return `Choose action for ${agentName}`;
}

/** The prompt body, which every valid Profile has. */
export function formatAgentPromptMarkdown(profile: Profile): string {
  return profile.systemPrompt.trim();
}

/**
 * The user message the work action sends.
 *
 * Phrased as an instruction to the model rather than as a tool call, because
 * the model is the thing that knows how to brief a Subagent.
 */
export function buildAgentWorkMessage(agentName: string, task: string): string {
  return `Use agent_start with agent "${agentName}" for the task: ${task}`;
}

/** Where to put a Profile, for the case where there are none to list. */
export function formatNoAgentsMessage(agentsDir: string): string {
  return `No subagents are configured. Add a Profile to ${agentsDir}.`;
}

/** What the Profile list says its keys do. */
export function formatAgentListHint(
  separator: string,
  renderKeyHint = keyHint,
): string {
  return `${renderKeyHint("tui.select.confirm", "actions")}${separator}${renderKeyHint("tui.select.cancel", "close")}`;
}

/** What the action menu says its keys do. */
export function formatAgentActionHint(
  separator: string,
  renderKeyHint = keyHint,
): string {
  return `${renderKeyHint("tui.select.confirm", "to confirm")}${separator}${renderKeyHint("tui.select.cancel", "back")}`;
}

/** What the prompt view says its keys do, scrolling included. */
export function formatAgentDetailHint(
  separator: string,
  renderKeyHint = keyHint,
): string {
  return [
    renderKeyHint("tui.select.cancel", "back"),
    "↑/↓ scroll",
    "←/→ page",
  ].join(separator);
}

interface AgentWorkContext {
  ui: Pick<ExtensionCommandContext["ui"], "notify">;
  waitForIdle(): Promise<void>;
}

/**
 * Hand a Profile some work.
 *
 * The message goes in as a *user* message rather than as a tool call, exactly
 * as v1 does: the model decides how to brief the Subagent, and a command that
 * called `agent_start` itself would be a second caller of the façade with its
 * own idea of what a good brief looks like.
 */
export async function runAgentWorkFlow(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: AgentWorkContext,
  profile: Profile,
  task: string | undefined,
  closeAgentsUi: () => void,
): Promise<void> {
  const trimmed = task?.trim();
  if (!trimmed) {
    ctx.ui.notify("Cancelled", "info");
    closeAgentsUi();
    return;
  }
  await ctx.waitForIdle();
  pi.sendUserMessage(buildAgentWorkMessage(profile.name, trimmed));
  closeAgentsUi();
}

class AgentsListComponent extends Container {
  private readonly searchInput = new Input();
  private readonly listContainer = new Container();
  private theme: Theme;
  private items: SelectItem[];
  private onSelect: (agentName: string) => void | Promise<void>;
  private onCancel: () => void;
  private keybindings: KeybindingMatcher;
  private requestRender: () => void;
  private selectList: SelectList | null = null;

  constructor(
    theme: Theme,
    items: SelectItem[],
    onSelect: (agentName: string) => void | Promise<void>,
    onCancel: () => void,
    keybindings: KeybindingMatcher,
    requestRender: () => void,
  ) {
    super();
    this.theme = theme;
    this.items = items;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.keybindings = keybindings;
    this.requestRender = requestRender;

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(
      new Text(theme.fg("accent", theme.bold("Select agent")), 1, 0),
    );
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg("dim", "Type to search") +
          theme.fg("dim", " • ") +
          formatAgentListHint(theme.fg("dim", " • ")),
        1,
        0,
      ),
    );
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    this.updateList();
  }

  handleInput(keyData: string): void {
    if (
      this.keybindings.matches(keyData, "tui.select.up") ||
      this.keybindings.matches(keyData, "tui.select.down") ||
      this.keybindings.matches(keyData, "tui.select.confirm") ||
      this.keybindings.matches(keyData, "tui.select.cancel")
    ) {
      if (this.selectList) {
        this.selectList.handleInput(keyData);
      } else if (this.keybindings.matches(keyData, "tui.select.cancel")) {
        this.onCancel();
      }
      this.requestRender();
      return;
    }

    this.searchInput.handleInput(keyData);
    this.updateList();
    this.requestRender();
  }

  private updateList(): void {
    this.listContainer.clear();
    const filtered = getFilteredAgentSelectItems(
      this.items,
      this.searchInput.getValue(),
    );

    if (filtered.length === 0) {
      this.selectList = null;
      this.listContainer.addChild(
        new Text(this.theme.fg("warning", "  No matching agents"), 0, 0),
      );
      return;
    }

    this.selectList = new SelectList(
      filtered,
      Math.min(filtered.length, MAX_VISIBLE_PROFILE_ROWS),
      selectListStyle(this.theme),
      AGENT_SELECT_LIST_LAYOUT,
    );
    this.selectList.onSelect = (item) => {
      void this.onSelect(String(item.value));
    };
    this.selectList.onCancel = this.onCancel;
    this.listContainer.addChild(this.selectList);
  }
}

class AgentActionMenuComponent extends Container {
  private selectList: SelectList;

  constructor(
    theme: Theme,
    profile: Profile,
    onSelect: (action: AgentAction) => void,
    onCancel: () => void,
  ) {
    super();

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(
      new Text(
        theme.fg("accent", theme.bold(formatAgentActionTitle(profile.name))),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));

    const actions = getAgentActionItems();
    this.selectList = new SelectList(
      actions,
      actions.length,
      selectListStyle(theme),
    );
    // Checked rather than cast: the list is built from `getAgentActionItems`,
    // so this cannot fail today, and a third action added there without a
    // branch here would otherwise be silently treated as `work`.
    this.selectList.onSelect = (item) => {
      if (isAgentAction(item.value)) onSelect(item.value);
    };
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
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingMatcher;
  private profile: Profile;
  private onBack: () => void;
  private markdown: Markdown;
  private scrollOffset = 0;
  private viewHeight = 0;
  private totalLines = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingMatcher,
    profile: Profile,
    onBack: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.profile = profile;
    this.onBack = onBack;
    this.markdown = new Markdown(
      formatAgentPromptMarkdown(profile),
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
      formatAgentPromptMarkdown(this.profile),
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
    const titleText = ` ${this.profile.name} `;
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
    let line = formatAgentDetailHint(
      this.theme.fg("muted", " • "),
      (action, description) =>
        this.theme.fg("dim", keyHint(action, description)),
    );

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
  profile: Profile,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, overlayTheme, keybindings, overlayDone) =>
      new AgentDetailOverlayComponent(
        tui,
        overlayTheme,
        keybindings,
        profile,
        () => overlayDone(undefined),
      ),
    {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
    },
  );
}

/**
 * Register `/agents` once per process.
 *
 * `profiles` is read at handler time rather than captured, because the command
 * registers once and the catalog belongs to whichever Session is live.
 */
export function registerAgentsCommand(
  pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">,
  profiles: () => readonly Profile[],
  agentsDir: string,
): void {
  pi.registerCommand(AGENTS_COMMAND_NAME, {
    description: "List loaded subagents and view their prompts.",
    handler: async (_args, ctx) => {
      const loaded = profiles();
      const items = getAgentSelectItems(loaded);
      if (items.length === 0) {
        ctx.ui.notify(formatNoAgentsMessage(agentsDir), "info");
        return;
      }
      const byName = new Map(
        loaded.map((profile) => [profile.name, profile] as const),
      );

      await ctx.ui.custom<void>((rootTui, theme, keybindings, done) => {
        interface ActiveComponent {
          render(width: number): string[];
          invalidate(): void;
          handleInput?(data: string): void;
        }

        let activeComponent: ActiveComponent;

        const setActiveComponent = (component: ActiveComponent): void => {
          activeComponent = component;
          rootTui.requestRender();
        };

        const openActionMenu = (profile: Profile): void => {
          setActiveComponent(
            new AgentActionMenuComponent(
              theme,
              profile,
              async (action) => {
                if (action === "view") {
                  await openAgentDetail(ctx, profile);
                  rootTui.requestRender();
                  return;
                }
                const task = await ctx.ui.editor(
                  `What task should ${profile.name} handle?`,
                );
                await runAgentWorkFlow(pi, ctx, profile, task, () =>
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
            const profile = byName.get(agentName);
            if (profile) openActionMenu(profile);
          },
          () => done(undefined),
          keybindings,
          () => rootTui.requestRender(),
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
