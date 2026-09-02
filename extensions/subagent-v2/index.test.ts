import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { PINNED_EFFECT_VERSION } from "./effect-version.ts";
import subagentV2Extension, {
  formatSkeletonStatus,
  V2_COMMAND_NAME,
  V2_SKELETON_MARKER,
} from "./index.ts";

type RegisteredCommand = {
  name: string;
  options: Parameters<ExtensionAPI["registerCommand"]>[1];
};

/**
 * Record every registration surface a Pi host offers an extension.
 *
 * A widget is not one of them: `setWidget` lives on the UI context a session
 * event hands out, never on `ExtensionAPI`. An extension that registers no
 * session event handler therefore cannot install one, which is what the
 * `events` assertion below proves.
 */
function stubHost(): {
  pi: ExtensionAPI;
  commands: RegisteredCommand[];
  tools: string[];
  renderers: string[];
  events: string[];
} {
  const commands: RegisteredCommand[] = [];
  const tools: string[] = [];
  const renderers: string[] = [];
  const events: string[] = [];
  const pi = {
    registerCommand(name: string, options: unknown) {
      commands.push({
        name,
        options: options as RegisteredCommand["options"],
      });
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerMessageRenderer(customType: string) {
      renderers.push(customType);
    },
    on(event: string) {
      events.push(event);
    },
    sendMessage() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  return { pi, commands, tools, renderers, events };
}

test("the v2 entry registers exactly one slash command", () => {
  const host = stubHost();

  subagentV2Extension(host.pi);

  assert.deepEqual(
    host.commands.map((command) => command.name),
    [V2_COMMAND_NAME],
  );
});

test("the v2 entry registers no model tools, renderers, or session event handlers", () => {
  const host = stubHost();

  subagentV2Extension(host.pi);

  assert.deepEqual(host.tools, []);
  assert.deepEqual(host.renderers, []);
  // No session event handler means no UI context, so no widget either.
  assert.deepEqual(host.events, []);
});

test("the placeholder command reports the skeleton marker and the pinned Effect version", async () => {
  const host = stubHost();
  const notified: Array<{ message: string; level: string }> = [];

  subagentV2Extension(host.pi);
  await host.commands[0].options.handler("", {
    ui: {
      notify(message: string, level: string) {
        notified.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext);

  assert.equal(notified.length, 1);
  assert.equal(notified[0].level, "info");
  assert.ok(notified[0].message.includes(V2_SKELETON_MARKER));
  assert.ok(notified[0].message.includes(PINNED_EFFECT_VERSION));
  assert.equal(notified[0].message, formatSkeletonStatus());
});

test("the placeholder command describes itself for the command list", () => {
  const host = stubHost();

  subagentV2Extension(host.pi);

  assert.equal(
    host.commands[0].options.description,
    "Report that the pi-subagent v2 skeleton is loaded.",
  );
});
