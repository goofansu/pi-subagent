import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId } from "../domain/index.ts";
import { createRuntimeCounters } from "../runtime/counters.ts";
import { hostRig } from "../testing/host-rig.ts";
import { fixtureRow } from "../testing/presentation-fixtures.ts";
import { createSessionPushSink } from "./push-sink.ts";
import {
  formatRuntimeHealth,
  formatSubagentStatus,
  formatUnknownSubcommand,
  NO_LIVE_SESSION,
  SUBAGENT_COMMAND_NAME,
} from "./subagent-command.ts";

/**
 * The operator namespace: one status, one way deeper.
 *
 * What makes bare `/subagent` worth having is that it is the one place to
 * start, so it says four things and points at the Profile list. What it must
 * never become again is a wall of counters — the numbers the runtime and the
 * adapters keep are for the suites and the live smokes that read them, and the
 * one verdict an operator can act on is the health line.
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

test("C-1: bare /subagent prints the shallow status and no counters", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const [text] = await say(rig);

  assert.match(text, /^Subagents: \d+ Profiles? · no Runs$/m);
  assert.match(text, /^Runtime: healthy · \d+ held$/m);
  assert.match(text, /^\/subagent profiles — /m);
  // No command prints the counters, and a status that printed them would be
  // the command this one replaced.
  for (const counter of Object.keys(createRuntimeCounters().counters())) {
    assert.doesNotMatch(text, new RegExp(`\\b${counter}\\b`), counter);
  }
  // Nor the sink's hand-off counts, for the same reason.
  for (const field of Object.keys(createSessionPushSink().counts())) {
    assert.doesNotMatch(text, new RegExp(`\\b${field}\\b`), field);
  }
});

test("C-1: the status names every Profile with the backend it names", () => {
  assert.equal(
    formatSubagentStatus({
      session: { runs: [], counters: {}, probe: {} },
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
      "Runtime: healthy · 0 held",
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
      counters: {},
      probe: {},
    },
    profiles: [],
    agentsDir: "/agents",
  });

  assert.match(text, /1 running, 2 completed, 1 failed/);
});

test("a Session with no Profiles still says where to put one", () => {
  assert.match(
    formatSubagentStatus({
      session: { runs: [], counters: {}, probe: {} },
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

test("health is a verdict on what was noticed and a count of what is held", () => {
  assert.equal(
    formatRuntimeHealth({ runs: [], counters: {}, probe: {} }),
    "Runtime: healthy · 0 held",
  );
  // What a live Session holds is held on purpose — a fiber per Run and a
  // repository subscription for the widget — so it is reported and not judged.
  assert.equal(
    formatRuntimeHealth({
      runs: [fixtureRow({ phase: "running" })],
      counters: {},
      probe: { liveRunFibers: 1, repositorySubscriptions: 1 },
    }),
    "Runtime: healthy · 2 held",
  );
  // A defect is what makes the verdict change, and the count beside it is the
  // defects alone: the two expected counters here are not in the line at all.
  assert.equal(
    formatRuntimeHealth({
      runs: [],
      counters: { lateEvents: 2, queueOverflows: 1 },
      probe: { liveRunFibers: 1 },
    }),
    "Runtime: attention needed · 1 defect · 1 held",
  );
});

test("C-3: a Session whose only raised counters are expected ones is healthy", () => {
  // The defect this row fixes. Twenty late events and two reconciliation
  // differences is a Session running exactly as designed, and the old line
  // called it `Runtime: 22 counted`.
  assert.equal(
    formatRuntimeHealth({
      runs: [],
      counters: {
        lateEvents: 20,
        reconciliationDifferences: 2,
        duplicateSettlements: 3,
        lateEndings: 3,
        lateObservations: 1,
        evictions: 4,
      },
      probe: { liveRunFibers: 4 },
    }),
    "Runtime: healthy · 4 held",
  );
});

test("C-3: the health line names the non-zero classes, worst first", () => {
  assert.equal(
    formatRuntimeHealth({
      runs: [],
      counters: { deliveryFailures: 1, lateEvents: 9 },
      probe: {},
    }),
    "Runtime: attention needed · 1 incident · 0 held",
  );
  assert.equal(
    formatRuntimeHealth({
      runs: [],
      counters: {
        conflictingCommits: 1,
        cleanupEscalations: 1,
        deliveryFailures: 1,
        lateEvents: 40,
      },
      probe: { liveRunFibers: 4 },
    }),
    "Runtime: attention needed · 1 defect · 2 incidents · 4 held",
  );
});

test("C-3: a counter the host does not recognise is named rather than ignored", () => {
  // The counter block is structural so that a counter cannot be added without
  // appearing. A name with no class must therefore not disappear into
  // "healthy" — it is the one case where silence would defeat the block.
  assert.equal(
    formatRuntimeHealth({
      runs: [],
      counters: { somethingNobodyClassified: 1, lateEvents: 3 },
      probe: {},
    }),
    "Runtime: attention needed · 1 unclassified · 0 held",
  );
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
