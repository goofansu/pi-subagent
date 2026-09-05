import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId, type Profile } from "../domain/index.ts";
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
  openProfilesUi,
  runAgentWorkFlow,
} from "./agents-command.ts";

/**
 * `/agents`, over the Session's Profile catalog.
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

/**
 * The minimum host and context the Profile flow needs.
 *
 * The flow registers no command of its own — `/subagent profiles` is its one
 * entry point — so this drives {@link openProfilesUi} directly, which is what
 * the namespace's handler calls.
 */
function commandHost(profiles: readonly Profile[], agentsDir = "/agents") {
  const notices: { message: string; level: string }[] = [];
  const userMessages: string[] = [];
  const pi = {
    sendUserMessage: (content: string) => void userMessages.push(content),
  };
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
    notices,
    userMessages,
    ctx,
    pi,
    selectorOpened: () => selectorOpened,
    /** What `/subagent profiles` does when an operator types it. */
    open: () =>
      openProfilesUi(
        pi as unknown as Parameters<typeof openProfilesUi>[0],
        () => profiles,
        agentsDir,
        ctx as unknown as Parameters<typeof openProfilesUi>[3],
      ),
  };
}

test("the Profile flow registers no command of its own", () => {
  // `/subagent profiles` is the one entry point. v1's `/agents` is removed in
  // 2.0, and this module owns the flow rather than a registration — so a
  // second entry point cannot be added here without the namespace knowing.
  assert.equal(
    Object.hasOwn(commandHost([profile()]).pi, "registerCommand"),
    false,
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
  // `/agents` carries no backend-specific field, so every backend name — the
  // two that ship and any a demo set adds — produces the same list.
  const items = ["pi", "claude", "demo-one-shot"].map((backend) =>
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

  await host.open();

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

  await host.open();

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
