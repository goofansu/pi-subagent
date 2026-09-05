import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId } from "../domain/index.ts";
import { hostRig } from "../testing/host-rig.ts";
import { fixtureRow } from "../testing/presentation-fixtures.ts";
import {
  formatSubagentStatus,
  formatUnknownSubcommand,
  NO_LIVE_SESSION,
  SUBAGENT_COMMAND_NAME,
} from "./subagent-command.ts";

/**
 * The operator namespace: one status, one way deeper.
 *
 * What makes bare `/subagent` worth having is that it is the one place to
 * start, so it says three things and points at the Profile list. What it must
 * never become again is a report on the runtime — the counters and probes the
 * runtime and the adapters keep are for the suites and the live smokes that
 * read them, and neither a block of them nor a one-line verdict over them
 * belongs in front of an operator who cannot act on either.
 */

/** Run the command's handler the way the host would, and read what it said. */
async function say(
  rig: ReturnType<typeof hostRig>,
  args = "",
): Promise<readonly string[]> {
  const command = rig.host
    .commands()
    .find((entry) => entry.name === SUBAGENT_COMMAND_NAME);
  assert.ok(command, "the subagent command was not registered");
  const said: string[] = [];
  await command.handler(args, {
    ui: {
      notify: (message: string) => {
        said.push(message);
      },
      custom: async () => {},
      editor: async () => undefined,
    },
    waitForIdle: async () => {},
  } as never);
  return said;
}

// -- The shallow status ------------------------------------------------------

test("C-1: bare /subagent prints the shallow status and nothing about the runtime", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const [text] = await say(rig);

  assert.match(text, /^Subagents: \d+ Profiles? · no Runs$/m);
  assert.match(text, /^\/subagent profiles — /m);
  // The status once carried a `Runtime:` verdict over the counters. It does
  // not any more, and nothing else in the status names the runtime at all.
  assert.doesNotMatch(text, /Runtime/);
});

test("C-1: the status names every Profile with the backend it names", () => {
  assert.equal(
    formatSubagentStatus({
      session: { runs: [] },
      profiles: [
        {
          name: "explore",
          description: "The explore specialist",
          backend: backendId("pi"),
          fields: {},
          systemPrompt: "Explore.",
        },
        {
          name: "reviewer",
          description: "The reviewer",
          backend: backendId("claude"),
          fields: {},
          systemPrompt: "Review.",
        },
      ],
      agentsDir: "/agents",
    }),
    [
      "Subagents: 2 Profiles · no Runs",
      "",
      "  explore   pi",
      "  reviewer  claude",
      "",
      "/subagent profiles — list Profiles and read their prompts",
    ].join("\n"),
  );
});

test("C-1: the status counts Runs in the shared phase vocabulary", () => {
  const text = formatSubagentStatus({
    session: {
      runs: [
        fixtureRow({ phase: "running" }),
        fixtureRow({ phase: "completed" }),
        fixtureRow({ phase: "completed" }),
        fixtureRow({ phase: "failed" }),
      ],
    },
    profiles: [],
    agentsDir: "/agents",
  });

  assert.match(text, /1 running, 2 completed, 1 failed/);
});

test("a Session with no Profiles still says where to put one", () => {
  assert.match(
    formatSubagentStatus({
      session: { runs: [] },
      profiles: [],
      agentsDir: "/home/someone/.pi/agents",
    }),
    /Subagents: no Profiles · no Runs[\s\S]*Add a Profile to \/home\/someone\/\.pi\/agents\./,
  );
});

test("a Session with no runtime says so and still says where to put a Profile", async (t) => {
  const rig = hostRig(t);

  const [text] = await say(rig);

  // The exported constant rather than the literal, so the sentence and the
  // status that carries it cannot drift apart.
  assert.ok(text.includes(NO_LIVE_SESSION));
  assert.match(text, /Add a Profile to /);
  assert.match(text, /^\/subagent profiles — /m);
});

// -- The namespace ----------------------------------------------------------

test("C-2: /subagent is the only command, and /agents is gone", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  // v1's command is removed in 2.0. Asserted by exhaustion rather than by
  // absence: a list is the only way to notice a command nobody deleted.
  assert.deepEqual(
    rig.host.commands().map((entry) => entry.name),
    [SUBAGENT_COMMAND_NAME],
  );
});

test("C-2: /subagent profiles opens the Profile flow", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  let selectors = 0;
  const notices: string[] = [];
  const ctx = {
    ui: {
      notify: (message: string) => void notices.push(message),
      custom: async () => {
        selectors += 1;
      },
      editor: async () => undefined,
    },
    waitForIdle: async () => {},
  } as never;
  const command = rig.host
    .commands()
    .find((entry) => entry.name === SUBAGENT_COMMAND_NAME);
  await command?.handler("profiles", ctx);

  // The selector opened and nothing was notified: the Profiles are loaded, so
  // "where to put one" would be the wrong answer.
  assert.equal(selectors, 1);
  assert.deepEqual(notices, []);
});

test("an unknown subcommand names the one that exists", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  assert.deepEqual(await say(rig, "counters"), [
    formatUnknownSubcommand("counters"),
  ]);
  assert.equal(
    formatUnknownSubcommand("counters"),
    '/subagent has no "counters". Try /subagent profiles.',
  );
  // `diagnostics` was a subcommand once. It is now an unknown one rather than
  // a command that prints nothing, so an operator who still types it is told.
  assert.equal(
    formatUnknownSubcommand("diagnostics"),
    '/subagent has no "diagnostics". Try /subagent profiles.',
  );
});
