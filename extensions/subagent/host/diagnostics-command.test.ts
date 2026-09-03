import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeProbeCounters } from "../backend/claude/index.ts";
import { createPiProbeCounters } from "../backend/pi/index.ts";
import { backendId } from "../domain/index.ts";
import { createRuntimeCounters } from "../runtime/counters.ts";
import { hostRig } from "../testing/host-rig.ts";
import { fixtureRow } from "../testing/presentation-fixtures.ts";
import {
  formatRuntimeHealth,
  formatSessionDiagnostics,
  formatSubagentStatus,
  formatUnknownSubcommand,
  NO_LIVE_SESSION,
  SUBAGENT_COMMAND_NAME,
} from "./diagnostics-command.ts";

/**
 * The operator namespace, and the one report dogfood needs beneath it.
 *
 * What makes the report worth having is that it names *every* field, zeroes
 * included: a diagnostics command that hid its zeroes would make "is this
 * counter even wired up" unanswerable, which is the question a maintainer
 * actually has when a number they expected to move has not moved.
 *
 * What makes bare `/subagent` worth having is the opposite: it is the one
 * place to start, so it says four things and points deeper.
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

/** `/subagent diagnostics`: the report bare `/subagent` used to print. */
const report = (rig: ReturnType<typeof hostRig>) => say(rig, "diagnostics");

test("the report names every runtime counter and every probe field", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const [text] = await report(rig);

  // Every field the runtime keeps, so a counter that was never wired up is
  // visible as a zero rather than as an absence.
  for (const counter of Object.keys(createRuntimeCounters().counters())) {
    assert.match(text, new RegExp(`\\b${counter}: \\d`), counter);
  }
  for (const resource of Object.keys(createRuntimeCounters().probe())) {
    assert.match(text, new RegExp(`\\b${resource}: \\d`), resource);
  }
  assert.match(text, /Runtime counters:/);
  assert.match(text, /Runtime probe:/);
});

test("between Sessions the report says there is nothing to report", async (t) => {
  const rig = hostRig(t);

  const [text] = await report(rig);

  assert.equal(text, NO_LIVE_SESSION);
});

// -- The shallow status ------------------------------------------------------

test("C-1: bare /subagent prints the shallow status and no counters", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const [text] = await say(rig);

  assert.match(text, /^Subagents: \d+ Profiles? · no Runs$/m);
  assert.match(text, /^Runtime: healthy · \d+ held$/m);
  assert.match(text, /^\/subagent profiles — /m);
  assert.match(text, /^\/subagent diagnostics — /m);
  // The counters are one level down, and a status that printed them would be
  // the command this one replaced.
  for (const counter of Object.keys(createRuntimeCounters().counters())) {
    assert.doesNotMatch(text, new RegExp(`\\b${counter}\\b`), counter);
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
      "/subagent diagnostics — runtime counters and cleanup probes",
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

  assert.match(text, /^No subagent Session is running\.$/m);
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
  assert.equal(
    formatRuntimeHealth({
      runs: [],
      counters: { lateEvents: 2, queueOverflows: 1 },
      probe: { liveRunFibers: 1 },
    }),
    "Runtime: 3 counted · 1 held — /subagent diagnostics",
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

test("an unknown subcommand names the two that exist", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  assert.deepEqual(await say(rig, "counters"), [
    formatUnknownSubcommand("counters"),
  ]);
  assert.equal(
    formatUnknownSubcommand("counters"),
    '/subagent has no "counters". Try /subagent profiles or /subagent diagnostics.',
  );
});

test("every backend's probe is reported beside the runtime's own, one block each", () => {
  // One block per backend rather than a merged total: "which adapter is still
  // holding something" is the only question a probe exists to answer, and a
  // sum cannot answer it.
  const pi = createPiProbeCounters();
  pi.acquired("openSessions");
  pi.acquired("liveSubscriptions");
  const claude = createClaudeProbeCounters();
  claude.acquired("retainedIdentities");

  const text = formatSessionDiagnostics({
    counters: { lateEvents: 2 },
    probe: { liveRunFibers: 0 },
    adapterProbe: { pi: { ...pi.read() }, claude: { ...claude.read() } },
  });

  assert.equal(
    text,
    [
      "Runtime counters:",
      "  lateEvents: 2",
      "Runtime probe:",
      "  liveRunFibers: 0",
      "Backend probe (pi):",
      "  openSessions: 1",
      "  liveSubscriptions: 1",
      "  pendingCleanups: 0",
      "Backend probe (claude):",
      "  liveQueries: 0",
      "  openInputs: 0",
      "  retainedIdentities: 1",
    ].join("\n"),
  );
});

test("a set with no probe of its own reports the two runtime blocks alone", () => {
  assert.equal(
    formatSessionDiagnostics({ counters: {}, probe: {} }),
    ["Runtime counters:", "  (none)", "Runtime probe:", "  (none)"].join("\n"),
  );
  assert.equal(
    formatSessionDiagnostics({ counters: {}, probe: {}, adapterProbe: {} }),
    ["Runtime counters:", "  (none)", "Runtime probe:", "  (none)"].join("\n"),
  );
});

test("the live report carries one block per backend, straight from the set", async (t) => {
  // The formatter is proven above; this is the wiring. The command reads the
  // probes through the entry point rather than through the runtime, so a
  // report that lost a block would look fine to the formatter's own test.
  const rig = hostRig(t, {
    adapterProbe: () => ({
      pi: { openSessions: 1, liveSubscriptions: 0, pendingCleanups: 0 },
      claude: { liveQueries: 2, openInputs: 1, retainedIdentities: 1 },
      codex: {
        liveProcesses: 1,
        readerFibers: 1,
        pendingRequests: 0,
        retainedRoots: 1,
        inFlightSteers: 0,
      },
    }),
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const [text] = await report(rig);

  assert.match(text, /Backend probe \(pi\):\n {2}openSessions: 1/);
  assert.match(text, /Backend probe \(claude\):\n {2}liveQueries: 2/);
  assert.match(text, /Backend probe \(codex\):\n {2}liveProcesses: 1/);
  assert.match(text, /Runtime counters:/);
  assert.match(text, /Runtime probe:/);
});
