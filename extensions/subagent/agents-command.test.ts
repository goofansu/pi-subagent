import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildAgentWorkMessage,
  formatAgentActionHint,
  formatAgentActionTitle,
  formatAgentDetailHint,
  formatAgentListHint,
  formatAgentPromptMarkdown,
  formatNoAgentsMessage,
  getAgentActionItems,
  getAgentSelectItems,
  getFilteredAgentSelectItems,
  registerAgentsCommand,
  runAgentWorkFlow,
} from "./agents-command.ts";
import type { AgentConfig } from "./types.ts";

const AGENTS_DIR = "/tmp/user-agent/agents";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type RegisteredCommand = { name: string; options: CommandOptions };
type CommandContext = Parameters<CommandOptions["handler"]>[1];
type CustomFactory = (
  tui: { requestRender(): void },
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  keybindings: { matches(data: string, action: string): boolean },
  done: (value: undefined) => void,
) => {
  render(width: number): string[];
};

initTheme(undefined, false);

const testTheme = {
  fg(color: string, text: string) {
    const code = color === "success" ? 32 : color === "warning" ? 33 : 90;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
  bold(text: string) {
    return `\u001b[1m${text}\u001b[22m`;
  },
};

const exploreAgent: AgentConfig = {
  name: "explore",
  description: "Fast codebase exploration.",
  tools: "read,rg",
  systemPrompt: "# Explore\n\nRead files and report findings.",
};

const reviewAgent: AgentConfig = {
  name: "reviewer",
  description: "Review code carefully.",
  systemPrompt: "Review the implementation.",
};

test("getAgentSelectItems lists each agent by name and description", () => {
  const items = getAgentSelectItems(
    new Map([[exploreAgent.name, exploreAgent]]),
  );

  assert.deepEqual(items, [
    {
      value: "explore",
      label: "explore",
      description: "Fast codebase exploration.",
    },
  ]);
});

test("getFilteredAgentSelectItems filters agents by name and description", () => {
  const items = getAgentSelectItems(
    new Map([
      [exploreAgent.name, exploreAgent],
      [reviewAgent.name, reviewAgent],
    ]),
  );

  assert.deepEqual(getFilteredAgentSelectItems(items, "fast"), [
    {
      value: "explore",
      label: "explore",
      description: "Fast codebase exploration.",
    },
  ]);
  assert.deepEqual(getFilteredAgentSelectItems(items, "reviewer"), [
    {
      value: "reviewer",
      label: "reviewer",
      description: "Review code carefully.",
    },
  ]);
});

test("the detail view renders only the prompt, without the description", () => {
  assert.equal(
    formatAgentPromptMarkdown(exploreAgent),
    "# Explore\n\nRead files and report findings.",
  );
  assert.equal(
    formatAgentPromptMarkdown(exploreAgent).includes(exploreAgent.description),
    false,
  );
});

test("formatAgentPromptMarkdown renders the selected agent prompt", () => {
  assert.equal(
    formatAgentPromptMarkdown(exploreAgent),
    "# Explore\n\nRead files and report findings.",
  );
});

test("getAgentActionItems returns action names without descriptions", () => {
  assert.deepEqual(getAgentActionItems(), [
    { value: "view", label: "View" },
    { value: "work", label: "Work" },
  ]);
});

test("formatAgentActionTitle names the selected agent", () => {
  assert.equal(
    formatAgentActionTitle("reviewer"),
    "Choose action for reviewer",
  );
});

test("formatNoAgentsMessage names the directory to create a profile in", () => {
  assert.equal(
    formatNoAgentsMessage(AGENTS_DIR),
    `No subagents are configured. Add a profile to ${AGENTS_DIR}.`,
  );
});

test("formatAgentListHint uses keybinding descriptions", () => {
  const hint = formatAgentListHint(
    " • ",
    (keybinding, description) => `${keybinding} ${description}`,
  );

  assert.match(hint, /actions/);
  assert.match(hint, /close/);
});

test("formatAgentActionHint uses keybinding descriptions", () => {
  const hint = formatAgentActionHint(
    " • ",
    (keybinding, description) => `${keybinding} ${description}`,
  );

  assert.match(hint, /to confirm/);
  assert.match(hint, /back/);
});

test("formatAgentDetailHint uses key hint for back and compact arrow labels", () => {
  assert.equal(
    formatAgentDetailHint(
      " • ",
      (keybinding, description) => `${keybinding} ${description}`,
    ),
    "tui.select.cancel back • ↑/↓ scroll • ←/→ page",
  );
});

test("buildAgentWorkMessage returns the selected-agent work prompt", () => {
  assert.equal(
    buildAgentWorkMessage("explore", "inspect the parser"),
    'Use the subagent tool with agent "explore" for the task: inspect the parser',
  );
});

test("runAgentWorkFlow closes the agents UI when task entry is cancelled", async () => {
  let closeCount = 0;
  const notifications: Array<{ message: string; level: string }> = [];

  await runAgentWorkFlow(
    { sendUserMessage: () => {} },
    {
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      waitForIdle: async () => {
        throw new Error("should not wait when cancelled");
      },
    },
    exploreAgent,
    "   ",
    () => {
      closeCount++;
    },
  );

  assert.equal(closeCount, 1);
  assert.deepEqual(notifications, [{ message: "Cancelled", level: "info" }]);
});

test("runAgentWorkFlow sends message and closes UI when task is provided", async () => {
  let idleWaited = false;
  let closeCount = 0;
  const sentMessages: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  await runAgentWorkFlow(
    {
      sendUserMessage(msg: string) {
        sentMessages.push(msg);
      },
    },
    {
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      waitForIdle: async () => {
        idleWaited = true;
      },
    },
    exploreAgent,
    "  inspect the parser  ",
    () => {
      closeCount++;
    },
  );

  assert.equal(idleWaited, true, "must wait for idle before sending");
  assert.equal(closeCount, 1, "must close UI once");
  assert.deepEqual(notifications, [], "must not notify when task is provided");
  assert.deepEqual(sentMessages, [
    'Use the subagent tool with agent "explore" for the task: inspect the parser',
  ]);
});

test("registerAgentsCommand registers the agents slash command", () => {
  const calls: RegisteredCommand[] = [];
  const pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> = {
    registerCommand(name, options) {
      calls.push({ name, options });
    },
    sendUserMessage: () => {},
  };

  registerAgentsCommand(
    pi,
    new Map([[exploreAgent.name, exploreAgent]]),
    AGENTS_DIR,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "agents");
  assert.equal(
    calls[0].options.description,
    "List loaded subagents and view their prompts.",
  );
});

test("agents command points at the agents directory when none are configured", async () => {
  const calls: RegisteredCommand[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let customCalled = false;
  const pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> = {
    registerCommand(name, options) {
      calls.push({ name, options });
    },
    sendUserMessage: () => {},
  };

  registerAgentsCommand(pi, new Map(), AGENTS_DIR);

  await calls[0].options.handler("", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {
        customCalled = true;
      },
    },
  } as unknown as CommandContext);

  assert.equal(customCalled, false);
  assert.deepEqual(notifications, [
    { message: formatNoAgentsMessage(AGENTS_DIR), level: "info" },
  ]);
});

test("agents command opens a selector when agents are loaded", async () => {
  const calls: RegisteredCommand[] = [];
  let customCalled = false;
  let rendered: string[] = [];
  const pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> = {
    registerCommand(name, options) {
      calls.push({ name, options });
    },
    sendUserMessage: () => {},
  };

  registerAgentsCommand(
    pi,
    new Map([
      [exploreAgent.name, exploreAgent],
      [reviewAgent.name, reviewAgent],
    ]),
    AGENTS_DIR,
  );

  await calls[0].options.handler("", {
    ui: {
      notify: () => {},
      custom: async (factory: unknown) => {
        customCalled = true;
        const component = (factory as CustomFactory)(
          { requestRender() {} },
          testTheme,
          { matches: () => false },
          () => {},
        );
        rendered = component.render(100);
        return undefined;
      },
    },
  } as unknown as CommandContext);

  assert.equal(customCalled, true);
  const plainLines = stripVTControlCharacters(rendered.join("\n")).split("\n");
  const exploreLine = plainLines.find(
    (line) => line.includes("explore") && line.includes("Fast codebase"),
  );
  assert.ok(exploreLine);
  const descriptionGap =
    exploreLine.indexOf("Fast codebase") -
    (exploreLine.indexOf("explore") + "explore".length);
  assert.ok(descriptionGap >= 1 && descriptionGap < 10);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 100));
});
