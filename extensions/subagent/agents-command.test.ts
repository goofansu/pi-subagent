import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  buildAgentWorkMessage,
  formatAgentActionHint,
  formatAgentListHint,
  formatAgentPromptMarkdown,
  getAgentActionItems,
  getAgentDetailMarkdownText,
  getAgentSelectItems,
  registerAgentsCommand,
  runAgentWorkFlow,
} from "./agents-command.js";
import type { AgentConfig } from "./types.js";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type RegisteredCommand = { name: string; options: CommandOptions };
type CommandContext = Parameters<CommandOptions["handler"]>[1];

const exploreAgent: AgentConfig = {
  name: "explore",
  description: "Fast codebase exploration.",
  model: "inherit",
  tools: "read,rg",
  systemPrompt: "# Explore\n\nRead files and report findings.",
  source: "default",
};

const reviewAgent: AgentConfig = {
  name: "reviewer",
  description: "Review code carefully.",
  systemPrompt: "Review the implementation.",
  source: "user",
};

test("getAgentSelectItems lists names and descriptions only", () => {
  const items = getAgentSelectItems(
    new Map([[exploreAgent.name, exploreAgent]]),
  );

  assert.deepEqual(items, [
    {
      value: "explore",
      label: "explore",
      description: "[d] Fast codebase exploration.",
    },
  ]);
});

test("getAgentSelectItems prefixes user agents", () => {
  const items = getAgentSelectItems(new Map([[reviewAgent.name, reviewAgent]]));

  assert.deepEqual(items, [
    {
      value: "reviewer",
      label: "reviewer",
      description: "[u] Review code carefully.",
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

test("getAgentActionItems returns the agent action menu", () => {
  assert.deepEqual(getAgentActionItems(), [
    { value: "view", label: "view", description: "View agent" },
    {
      value: "work",
      label: "work",
      description: "Work on task with this agent",
    },
  ]);
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

  registerAgentsCommand(pi, new Map([[exploreAgent.name, exploreAgent]]));

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

  registerAgentsCommand(pi, new Map());

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

test("agents command opens a selector when agents are loaded", async () => {
  const calls: RegisteredCommand[] = [];
  let customCalled = false;
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
  );

  await calls[0].options.handler("", {
    ui: {
      notify: () => {},
      custom: async () => {
        customCalled = true;
        return undefined;
      },
    },
  } as unknown as CommandContext);

  assert.equal(customCalled, true);
});
