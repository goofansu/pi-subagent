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
import { createSessionPushSink } from "./push-sink.ts";

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

test("the report names every runtime counter, every probe field, and every hand-off outcome", async (t) => {
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
  // And every hand-off outcome, from the sink, for the same reason: a Session
  // whose notices are all being refused and one whose notices are all being
  // lost after hand-off look identical without them.
  for (const field of Object.keys(createSessionPushSink().counts())) {
    assert.match(text, new RegExp(`\\b${field}: \\d`), field);
  }
  assert.match(text, /Runtime counters:/);
  assert.match(text, /Runtime probe:/);
  assert.match(text, /Notification hand-offs:/);
});

test("the hand-off block sits between the runtime's numbers and the adapters'", () => {
  const text = formatSessionDiagnostics({
    counters: { lateEvents: 2 },
    probe: { liveRunFibers: 0 },
    handoff: {
      pushesAttempted: 3,
      handOffsAccepted: 2,
      handOffsRefused: 1,
      lostAfterHandOff: 1,
      rePushes: 1,
      landings: 1,
      exhaustions: 0,
      consumedBeforeLanding: 0,
    },
    adapterProbe: { pi: { openSessions: 1 } },
  });

  // Zeroes included, in the order the sink declares them, so "is this counter
  // even wired up" stays answerable.
  assert.equal(
    text,
    [
      "Runtime counters:",
      "  lateEvents: 2",
      "Runtime probe:",
      "  liveRunFibers: 0",
      "Notification hand-offs:",
      "  pushesAttempted: 3",
      "  handOffsAccepted: 2",
      "  handOffsRefused: 1",
      "  lostAfterHandOff: 1",
      "  rePushes: 1",
      "  landings: 1",
      "  exhaustions: 0",
      "  consumedBeforeLanding: 0",
      "Backend probe (pi):",
      "  openSessions: 1",
    ].join("\n"),
  );
});

test("a live Session's hand-off block is the sink's, and it survives the Session", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();

  const started = await rig.text("agent_start", {
    agent: "explore",
    description: "look around",
    prompt: "have a look",
  });
  const runId = /run id (\S+)/.exec(started)?.[1];
  assert.ok(runId);
  await rig.text("agent_wait", { ids: [runId] });
  await rig.pump();

  const [live] = await report(rig);
  assert.match(live, /pushesAttempted: 1/);
  assert.match(live, /handOffsAccepted: 1/);
  await rig.probe();

  await rig.host.sessionShutdown();

  // The counts are not cleared by `unbind`, so what the Session that just
  // ended did is still readable; the command has no Session to read the
  // probes from, which is an answer rather than an error.
  assert.equal((await report(rig))[0], NO_LIVE_SESSION);
  assert.equal(rig.installation.sink.counts().pushesAttempted, 1);
  assert.equal(rig.noLeaks(), true);
});

test("bare /subagent does not print the hand-off block; it is the deep end's", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const [text] = await say(rig);

  assert.doesNotMatch(text, /Notification hand-offs/);
  for (const field of Object.keys(createSessionPushSink().counts())) {
    assert.doesNotMatch(text, new RegExp(`\\b${field}\\b`), field);
  }
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
  // A defect is what makes the verdict change, and the count beside it is the
  // defects alone: the two expected counters here are not in the line at all.
  assert.equal(
    formatRuntimeHealth({
      runs: [],
      counters: { lateEvents: 2, queueOverflows: 1 },
      probe: { liveRunFibers: 1 },
    }),
    "Runtime: attention needed · 1 defect · 1 held — /subagent diagnostics",
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
    "Runtime: attention needed · 1 incident · 0 held — /subagent diagnostics",
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
    "Runtime: attention needed · 1 defect · 2 incidents · 4 held — /subagent diagnostics",
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
    "Runtime: attention needed · 1 unclassified · 0 held — /subagent diagnostics",
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
    handoff: { landings: 1 },
    adapterProbe: { pi: { ...pi.read() }, claude: { ...claude.read() } },
  });

  assert.equal(
    text,
    [
      "Runtime counters:",
      "  lateEvents: 2",
      "Runtime probe:",
      "  liveRunFibers: 0",
      "Notification hand-offs:",
      "  landings: 1",
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

test("a set with no probe of its own reports the three Session blocks alone", () => {
  // The adapter probe is the only optional block, and the asymmetry is
  // deliberate: a Session with no backend probes genuinely has none, while
  // every Session has a sink, so its block is required and cannot be dropped
  // by a caller forgetting it.
  const blocks = [
    "Runtime counters:",
    "  (none)",
    "Runtime probe:",
    "  (none)",
    "Notification hand-offs:",
    "  (none)",
  ].join("\n");

  assert.equal(
    formatSessionDiagnostics({ counters: {}, probe: {}, handoff: {} }),
    blocks,
  );
  assert.equal(
    formatSessionDiagnostics({
      counters: {},
      probe: {},
      handoff: {},
      adapterProbe: {},
    }),
    blocks,
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
