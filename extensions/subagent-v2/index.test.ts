import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS_COMMAND_NAME } from "./host/agents-command.ts";
import {
  createDemoBackendSet,
  DEMO_ANSWER_PREFIX,
  DEMO_ONE_SHOT_PROFILE,
  DEMO_RESUMABLE_PROFILE,
  demoAnswer,
} from "./host/demo-backends.ts";
import { DIAGNOSTICS_COMMAND_NAME } from "./host/diagnostics-command.ts";
import { NOTIFICATION_MESSAGE_TYPE } from "./host/notification-message.ts";
import { V2_TOOL_NAMES } from "./host/tools.ts";
import subagentV2Extension, { installSubagentV2 } from "./index.ts";
import { hostRig, startedIds } from "./testing/host-rig.ts";
import { createStandInHost, resultText } from "./testing/stand-in-host.ts";

/**
 * What the v2 entry point registers, and that it registers it once.
 *
 * Pi's registries are per-process, so "once" is a real property rather than a
 * tidiness one: a tool registered twice is a tool the model sees twice. Every
 * assertion here is about the registration surface; what the handlers *do* is
 * the host tests' business.
 */

test("the v2 entry registers the six tools, both commands, and the notification renderer", () => {
  const host = createStandInHost();

  installSubagentV2(host.pi, {
    agentDir: "/nowhere",
    backendSet: createDemoBackendSet,
  });

  assert.deepEqual(
    host.tools().map((tool) => tool.name),
    [...V2_TOOL_NAMES],
  );
  assert.deepEqual(
    host.commands().map((command) => command.name),
    [AGENTS_COMMAND_NAME, DIAGNOSTICS_COMMAND_NAME],
  );
  assert.deepEqual(host.renderers(), [NOTIFICATION_MESSAGE_TYPE]);
});

test("the v2 entry subscribes to the two Session events and the three landing events", () => {
  const host = createStandInHost();

  installSubagentV2(host.pi, {
    agentDir: "/nowhere",
    backendSet: createDemoBackendSet,
  });

  assert.deepEqual(host.subscribed(), [
    "session_start",
    "session_shutdown",
    "message_start",
    "turn_end",
    "agent_settled",
  ]);
});

test("the default export installs the same surface against the machine's agent directory", () => {
  const host = createStandInHost();

  subagentV2Extension(host.pi);

  assert.deepEqual(
    host.tools().map((tool) => tool.name),
    [...V2_TOOL_NAMES],
  );
  assert.deepEqual(host.renderers(), [NOTIFICATION_MESSAGE_TYPE]);
});

test("every registered tool carries a label, a description, and a prompt snippet", () => {
  const host = createStandInHost();

  installSubagentV2(host.pi, {
    agentDir: "/nowhere",
    backendSet: createDemoBackendSet,
  });

  for (const tool of host.tools()) {
    assert.ok(tool.label.length > 0, `${tool.name} has no label`);
    assert.ok(tool.description.length > 0, `${tool.name} has no description`);
    assert.ok(
      (tool.promptSnippet ?? "").length > 0,
      `${tool.name} has no prompt snippet`,
    );
    // A snippet is one line for Pi's Available tools section, so it carries no
    // sentence-ending period and no newline.
    assert.doesNotMatch(tool.promptSnippet ?? "", /[.\n]$/);
  }
});

// ── The demo backend set ─────────────────────────────────────────────────────

test("a Session built from the demo set offers two Profiles and answers", async (t) => {
  const host = createStandInHost();
  const installation = installSubagentV2(host.pi, {
    // A directory with no Profile files, so the only Profiles are the set's.
    agentDir: hostRig(t).agentsDir,
    backendSet: createDemoBackendSet,
  });
  await host.sessionStart();
  t.after(() => installation.handle.release());

  assert.deepEqual(
    installation.profiles().map((profile) => profile.name),
    [DEMO_RESUMABLE_PROFILE, DEMO_ONE_SHOT_PROFILE],
  );

  const started = startedIds(
    resultText(
      await host.call("agent_start", {
        agent: DEMO_RESUMABLE_PROFILE,
        description: "try the demo",
        prompt: "say something",
      }),
    ),
  );
  await host.call("agent_wait", { ids: [started.runId] });

  // The demo backend echoes the brief, so the result proves the prompt made
  // the whole round trip rather than merely that a Run ran.
  assert.match(
    resultText(await host.call("agent_result", { id: started.runId })),
    new RegExp(demoAnswer("say something")),
  );
});

test("the demo Profiles describe themselves and name one backend each", () => {
  const set = createDemoBackendSet();

  assert.equal(set.backends.length, 2);
  assert.deepEqual(
    set.profiles.map((profile) => profile.backend),
    set.backends.map((backend) => backend.id),
  );
  for (const profile of set.profiles) {
    assert.ok(profile.description.length > 0);
    assert.ok(profile.systemPrompt.length > 0);
  }
  assert.ok(DEMO_ANSWER_PREFIX.length > 0);
});
