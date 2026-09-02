import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId, type Profile } from "../domain/index.ts";
import {
  AGENTS_COMMAND_NAME,
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

/**
 * `/agents`, ported from v1 over the v2 Profile catalog.
 *
 * The interactive parts are Pi TUI components, so what is asserted here is
 * what the command *decides*: which items the list holds, how a filter narrows
 * them, what the actions are, what the work action sends, and what an empty
 * setup says. The components themselves are v1's, unchanged apart from the
 * type they read.
 */

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "explore",
    description: "The explore specialist",
    backend: backendId("pi"),
    fields: {},
    systemPrompt: "Explore.\n",
    ...overrides,
  };
}

/** The minimum host and context the command handler needs. */
function commandHost(profiles: readonly Profile[], agentsDir = "/agents") {
  const commands: {
    name: string;
    description?: string;
    handler: (args: string, ctx: unknown) => Promise<void> | void;
  }[] = [];
  const notices: { message: string; level: string }[] = [];
  const userMessages: string[] = [];
  const pi = {
    registerCommand: (
      name: string,
      definition: { description?: string; handler: never },
    ) => {
      commands.push({ name, ...definition });
    },
    sendUserMessage: (content: string) => void userMessages.push(content),
  };
  registerAgentsCommand(
    pi as unknown as Parameters<typeof registerAgentsCommand>[0],
    () => profiles,
    agentsDir,
  );
  let selectorOpened = false;
  const ctx = {
    ui: {
      notify: (message: string, level = "info") =>
        void notices.push({ message, level }),
      custom: async () => {
        selectorOpened = true;
      },
      editor: async () => "review the diff",
    },
    waitForIdle: async () => {},
  };
  return {
    commands,
    notices,
    userMessages,
    ctx,
    pi,
    selectorOpened: () => selectorOpened,
  };
}

test("the agents command registers itself once, with a description", () => {
  const host = commandHost([profile()]);

  assert.deepEqual(
    host.commands.map((command) => command.name),
    [AGENTS_COMMAND_NAME],
  );
  assert.equal(
    host.commands[0].description,
    "List loaded subagents and view their prompts.",
  );
});

test("the list holds one item per Profile, by name and description", () => {
  const items = getAgentSelectItems([
    profile(),
    profile({ name: "reviewer", description: "The review specialist" }),
  ]);

  assert.deepEqual(items, [
    {
      value: "explore",
      label: "explore",
      description: "The explore specialist",
    },
    {
      value: "reviewer",
      label: "reviewer",
      description: "The review specialist",
    },
  ]);
});

test("the list is identical whatever backend a Profile names", () => {
  // Compatibility-matrix proof: `/agents` carries no backend-specific field.
  // See docs/v2/compatibility-matrix.md.
  const items = ["pi", "claude", "codex", "demo-one-shot"].map((backend) =>
    getAgentSelectItems([profile({ backend: backendId(backend) })]),
  );

  assert.equal(new Set(items.map((entry) => JSON.stringify(entry))).size, 1);
});

test("a filter narrows the list and an empty query leaves it alone", () => {
  const items = getAgentSelectItems([
    profile(),
    profile({ name: "reviewer", description: "The review specialist" }),
  ]);

  assert.deepEqual(getFilteredAgentSelectItems(items, "  "), items);
  assert.deepEqual(
    getFilteredAgentSelectItems(items, "review").map((item) => item.value),
    ["reviewer"],
  );
  assert.deepEqual(getFilteredAgentSelectItems(items, "zzzz"), []);
});

test("a Profile's detail view is its prompt body, trimmed", () => {
  assert.equal(
    formatAgentPromptMarkdown(
      profile({ systemPrompt: "\n# Explore\n\nLook.\n" }),
    ),
    "# Explore\n\nLook.",
  );
});

test("the two actions are view and work, under a title naming the Profile", () => {
  assert.deepEqual(getAgentActionItems(), [
    { value: "view", label: "View" },
    { value: "work", label: "Work" },
  ]);
  assert.equal(formatAgentActionTitle("explore"), "Choose action for explore");
});

test("the work action sends a user message naming the Profile and the task", async () => {
  const host = commandHost([profile()]);
  let closed = false;

  await runAgentWorkFlow(
    host.pi as unknown as Parameters<typeof runAgentWorkFlow>[0],
    host.ctx,
    profile(),
    "review the diff",
    () => {
      closed = true;
    },
  );

  assert.deepEqual(host.userMessages, [
    'Use agent_start with agent "explore" for the task: review the diff',
  ]);
  assert.equal(closed, true);
});

test("an empty task cancels the work action and sends nothing", async () => {
  const host = commandHost([profile()]);

  await runAgentWorkFlow(
    host.pi as unknown as Parameters<typeof runAgentWorkFlow>[0],
    host.ctx,
    profile(),
    "   ",
    () => {},
  );

  assert.deepEqual(host.userMessages, []);
  assert.deepEqual(host.notices, [{ message: "Cancelled", level: "info" }]);
});

test("the work message is one sentence the model can act on", () => {
  assert.equal(
    buildAgentWorkMessage("reviewer", "read the diff"),
    'Use agent_start with agent "reviewer" for the task: read the diff',
  );
});

test("with no Profiles the command names the agents directory and opens no selector", async () => {
  const host = commandHost([], "/home/someone/.pi/agents");

  await host.commands[0].handler("", host.ctx);

  assert.deepEqual(host.notices, [
    {
      message:
        "No subagents are configured. Add a Profile to /home/someone/.pi/agents.",
      level: "info",
    },
  ]);
  assert.equal(host.selectorOpened(), false);
});

test("with Profiles the command opens the selector", async () => {
  const host = commandHost([profile()]);

  await host.commands[0].handler("", host.ctx);

  assert.deepEqual(host.notices, []);
  assert.equal(host.selectorOpened(), true);
});

test("the no-Profiles message names the directory it was given", () => {
  assert.equal(
    formatNoAgentsMessage("/agents"),
    "No subagents are configured. Add a Profile to /agents.",
  );
});

test("each view's hints name the keys it responds to", () => {
  const stub = (_action: unknown, description: string) => description;

  assert.equal(formatAgentListHint(" • ", stub as never), "actions • close");
  assert.equal(
    formatAgentActionHint(" • ", stub as never),
    "to confirm • back",
  );
  assert.equal(
    formatAgentDetailHint(" • ", stub as never),
    "back • ↑/↓ scroll • ←/→ page",
  );
});
