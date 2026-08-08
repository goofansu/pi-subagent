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
  getAgentActionItems,
  getAgentDetailMarkdownText,
  getAgentSelectItems,
  getAgentsTrustStatus,
  getFilteredAgentSelectItems,
  registerAgentsCommand,
  runAgentWorkFlow,
} from "./agents-command.ts";
import type { AgentConfig } from "./types.ts";

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
  source: "user",
};

const reviewAgent: AgentConfig = {
  name: "reviewer",
  description: "Review code carefully.",
  systemPrompt: "Review the implementation.",
  source: "user",
};

const projectAgent: AgentConfig = {
  name: "deployer",
  description: "Deploy the project.",
  systemPrompt: "Deploy to production.",
  source: "project",
};

test("getAgentSelectItems includes the resolved default harness", () => {
  const items = getAgentSelectItems(
    new Map([[exploreAgent.name, exploreAgent]]),
  );

  assert.deepEqual(items, [
    {
      value: "explore",
      label: "explore",
      description: "[u] [pi] Fast codebase exploration.",
    },
  ]);
});

test("getAgentSelectItems prefixes user agents", () => {
  const items = getAgentSelectItems(new Map([[reviewAgent.name, reviewAgent]]));

  assert.deepEqual(items, [
    {
      value: "reviewer",
      label: "reviewer",
      description: "[u] [pi] Review code carefully.",
    },
  ]);
});

test("getAgentSelectItems prefixes project agents", () => {
  const items = getAgentSelectItems(
    new Map([[projectAgent.name, projectAgent]]),
  );

  assert.deepEqual(items, [
    {
      value: "deployer",
      label: "deployer",
      description: "[p] [pi] Deploy the project.",
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
      description: "[u] [pi] Fast codebase exploration.",
    },
  ]);
  assert.deepEqual(getFilteredAgentSelectItems(items, "reviewer"), [
    {
      value: "reviewer",
      label: "reviewer",
      description: "[u] [pi] Review code carefully.",
    },
  ]);
});

test("getAgentDetailMarkdownText renders only the prompt without description", () => {
  assert.equal(
    getAgentDetailMarkdownText(exploreAgent),
    "# Explore\n\nRead files and report findings.",
  );
  assert.equal(
    getAgentDetailMarkdownText(exploreAgent).includes(exploreAgent.description),
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

test("getAgentsTrustStatus describes available agent sources", () => {
  assert.deepEqual(getAgentsTrustStatus(true), {
    primary: "✓ Project trusted",
    secondary: "[u] User agents • [p] Project agents",
  });
  assert.deepEqual(getAgentsTrustStatus(false), {
    primary: "⚠ Project untrusted — [p] project agents excluded",
    secondary: "[u] User agents remain available",
  });
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

  registerAgentsCommand(pi, new Map([[exploreAgent.name, exploreAgent]]), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "agents");
  assert.equal(
    calls[0].options.description,
    "List loaded subagents and view their prompts.",
  );
});

test("agents command notifies when no agents are configured", async () => {
  const calls: RegisteredCommand[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> = {
    registerCommand(name, options) {
      calls.push({ name, options });
    },
    sendUserMessage: () => {},
  };

  registerAgentsCommand(pi, new Map(), true);

  await calls[0].options.handler("", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as CommandContext);

  assert.deepEqual(notifications, [
    { message: "No subagents are configured.", level: "info" },
  ]);
});

test("untrusted empty agents open an explanatory width-safe TUI", async () => {
  const calls: RegisteredCommand[] = [];
  const notifications: string[] = [];
  let rendered: string[] = [];
  const pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> = {
    registerCommand(name, options) {
      calls.push({ name, options });
    },
    sendUserMessage: () => {},
  };

  registerAgentsCommand(pi, new Map(), false);

  await calls[0].options.handler("", {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      custom: async (factory: unknown) => {
        const component = (factory as CustomFactory)(
          { requestRender() {} },
          testTheme,
          { matches: () => false },
          () => {},
        );
        rendered = component.render(32);
      },
    },
  } as unknown as CommandContext);

  const rawText = rendered.join("\n");
  const text = stripVTControlCharacters(rawText).replace(/\s+/g, " ");
  assert.deepEqual(notifications, []);
  assert.ok(rawText.includes("\u001b[33m⚠ Project untrusted"));
  assert.ok(rawText.includes("\u001b[90m"));
  assert.match(text, /project agents excluded/);
  assert.match(text, /User agents remain available/);
  assert.match(text, /No user agents are configured/);
  assert.match(text, /\/trust and restart Pi/);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 32));
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
    true,
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
  const renderedText = rendered.join("\n");
  const plainLines = stripVTControlCharacters(renderedText).split("\n");
  assert.ok(renderedText.includes("\u001b[32m✓ Project trusted"));
  assert.match(
    plainLines.join(" ").replace(/\s+/g, " "),
    /\[u\] User agents • \[p\] Project agents/,
  );
  const exploreLine = plainLines.find(
    (line) => line.includes("explore") && line.includes("Fast codebase"),
  );
  assert.ok(exploreLine);
  const descriptionGap =
    exploreLine.indexOf("[u]") -
    (exploreLine.indexOf("explore") + "explore".length);
  assert.ok(descriptionGap >= 1 && descriptionGap < 10);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 100));
});
