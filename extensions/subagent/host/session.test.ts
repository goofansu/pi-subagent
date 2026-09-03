import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { formatInvalidProfilesWarning } from "../presentation/index.ts";
import {
  hostRig,
  RIG_RESUMABLE_PROFILE,
  startedIds,
} from "../testing/host-rig.ts";

/**
 * Starting and shutting down Sessions, through the host events that do it.
 *
 * The two properties that matter are both about *pairs* of Sessions: a switch
 * must not leave two runtimes alive, and a Session that has ended must leave
 * nothing behind. Both are asserted from the runtime probe, because nothing at
 * the surface reports a stranded fiber.
 */

const A_BROKEN_PROFILE = "---\nbackend: pi\n---\n";
const A_GOOD_PROFILE = "---\ndescription: A user Profile\n---\nDo the thing.\n";
const A_PINNED_PROFILE =
  "---\ndescription: Pins a model\nmodel: claude-opus-5\n---\nDo the thing.\n";
const A_MISSING_MODEL_PROFILE =
  "---\ndescription: Pins a model this Session lacks\nmodel: not-installed\n---\nDo it.\n";

test("a Session start loads the backend set's Profiles and the user's own", async (t) => {
  const rig = hostRig(t, {
    profileFiles: { "mine.md": A_GOOD_PROFILE },
  });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  assert.deepEqual(
    rig.installation
      .profiles()
      .map((profile) => profile.name)
      .sort(),
    ["explore", "mine", "once"],
  );
});

test("a user Profile with the same name as a built-in one wins", async (t) => {
  const rig = hostRig(t, {
    profileFiles: {
      "explore.md":
        "---\ndescription: My own explore\n---\nMy own instructions.\n",
    },
  });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  const explore = rig.installation
    .profiles()
    .find((profile) => profile.name === RIG_RESUMABLE_PROFILE);
  assert.equal(explore?.description, "My own explore");
});

test("an invalid Profile file is a start-up warning, not a crash", async (t) => {
  const rig = hostRig(t, {
    profileFiles: { "broken.md": A_BROKEN_PROFILE },
  });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  const warnings = rig.host
    .notices()
    .filter((notice) => notice.level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /^Invalid subagent Profiles were skipped:/);
  assert.match(warnings[0].message, /broken\.md: missing required/);
  // The Session still works.
  assert.ok(rig.installation.profiles().length >= 2);
});

test("a Profile naming a backend the Session lacks is a diagnostic, not a crash", async (t) => {
  const rig = hostRig(t, {
    profileFiles: {
      "elsewhere.md":
        "---\ndescription: Names a backend this Session has never heard of\nbackend: not-installed\n---\nDo it.\n",
    },
  });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  const warnings = rig.host
    .notices()
    .filter((notice) => notice.level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /elsewhere\.md/);
  assert.equal(
    rig.installation.profiles().some((profile) => profile.name === "elsewhere"),
    false,
  );
});

test("the Session's model catalogue reaches the backend that validates a Profile", async (t) => {
  const seen: (readonly {
    readonly provider: string;
    readonly id: string;
  }[])[] = [];
  const rig = hostRig(t, {
    models: [
      { provider: "anthropic", id: "claude-opus-5" },
      { provider: "openai", id: "gpt-5" },
    ],
    profileFiles: { "pinned.md": A_PINNED_PROFILE },
    // A backend that validates a pinned model against the Session's own
    // catalogue, which is what a real adapter does.
    diagnose: (profile, filePath, context) => {
      const models = context?.models ?? [];
      seen.push(models);
      const pinned = profile.fields.model;
      if (typeof pinned !== "string") return [];
      return models.some((model) => model.id === pinned)
        ? []
        : [{ filePath, reason: `no model '${pinned}' in this Session` }];
    },
  });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  assert.ok(seen.length > 0, "the backend was never asked to validate");
  assert.deepEqual(seen[0], [
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "openai", id: "gpt-5" },
  ]);
  // The pinned model is in the catalogue, so the Profile loads.
  assert.ok(
    rig.installation.profiles().some((profile) => profile.name === "pinned"),
  );
  assert.deepEqual(
    rig.host.notices().filter((notice) => notice.level === "warning"),
    [],
  );
});

test("a Profile pinning a model this Session cannot reach is a diagnostic", async (t) => {
  const rig = hostRig(t, {
    models: [{ provider: "anthropic", id: "claude-opus-5" }],
    profileFiles: { "pinned.md": A_MISSING_MODEL_PROFILE },
    diagnose: (profile, filePath, context) => {
      const pinned = profile.fields.model;
      if (typeof pinned !== "string") return [];
      return (context?.models ?? []).some((model) => model.id === pinned)
        ? []
        : [{ filePath, reason: `no model '${pinned}' in this Session` }];
    },
  });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  const warnings = rig.host
    .notices()
    .filter((notice) => notice.level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /no model 'not-installed' in this Session/);
  assert.equal(
    rig.installation.profiles().some((profile) => profile.name === "pinned"),
    false,
  );
});

test("a Session with no Profile files still has the backend set's own", async (t) => {
  const rig = hostRig(t);
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  assert.deepEqual(
    rig.host.notices().filter((notice) => notice.level === "warning"),
    [],
  );
  assert.deepEqual(
    rig.installation.profiles().map((profile) => profile.name),
    ["explore", "once"],
  );
});

test("the agent_start guidelines name the Session's Profiles and follow a Session switch", async (t) => {
  const rig = hostRig(t);
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();
  assert.deepEqual(rig.installation.agentGuidelines(), [
    "agent_start explore: The explore specialist",
    "agent_start once: The one-shot specialist",
  ]);

  // The guidelines are the array the tool was registered with, so a new
  // Session's catalog reaches the model with no re-registration.
  fs.writeFileSync(path.join(rig.agentsDir, "mine.md"), A_GOOD_PROFILE);
  await rig.host.sessionShutdown();
  await rig.host.sessionStart();

  assert.deepEqual(rig.installation.agentGuidelines(), [
    "agent_start explore: The explore specialist",
    "agent_start once: The one-shot specialist",
    "agent_start mine: A user Profile",
  ]);
});

test("a Session with no Profiles at all says so in the guidelines", async (t) => {
  const rig = hostRig(t, { profiles: [] });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();

  assert.deepEqual(rig.installation.agentGuidelines(), [
    "agent_start has no configured agents.",
  ]);
});

// -- Session switching -------------------------------------------------------

test("two Session starts in one process leave exactly one runtime alive", async (t) => {
  const rig = hostRig(t);
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();
  const first = startedIds(
    await rig.text("agent_start", {
      agent: RIG_RESUMABLE_PROFILE,
      description: "d",
      prompt: "p",
    }),
  );
  await rig.text("agent_wait", { ids: [first.runId] });
  await rig.probe();

  // A second start with no shutdown between them, which is the switch the
  // handle has to survive.
  await rig.host.sessionStart();

  assert.ok(rig.noLeaks(), JSON.stringify(rig.probeAfterShutdown()));
  // The first Session's Run belongs to a Session that is gone, so its id is
  // unknown to the new one.
  assert.match(
    await rig.text("agent_result", { id: first.runId }),
    /^No run with id/,
  );
});

test("a Session switch leaves the new Session with a working widget", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [{ step: "await-gate", gate: "first" }],
      [{ step: "await-gate", gate: "second" }],
    ],
  });
  t.after(() => rig.installation.handle.release());

  await rig.host.sessionStart();
  await rig.text("agent_start", {
    agent: RIG_RESUMABLE_PROFILE,
    description: "d",
    prompt: "p",
  });
  await rig.pump();
  assert.equal(rig.host.hasWidget(), true);

  // A start with no shutdown between them, which is the switch the handle has
  // to survive: both Sessions' widgets live under one key in Pi's widget map.
  await rig.host.sessionStart();
  await rig.text("agent_start", {
    agent: RIG_RESUMABLE_PROFILE,
    description: "d",
    prompt: "p",
  });
  await rig.pump();

  assert.equal(rig.host.hasWidget(), true);
  assert.ok(rig.host.widgetLines().length > 0);
});

test("a Session shutdown disposes the runtime and leaves nothing alive", async (t) => {
  const rig = hostRig(t);

  await rig.host.sessionStart();
  const started = startedIds(
    await rig.text("agent_start", {
      agent: RIG_RESUMABLE_PROFILE,
      description: "d",
      prompt: "p",
    }),
  );
  await rig.text("agent_wait", { ids: [started.runId] });
  await rig.probe();
  await rig.host.sessionShutdown();

  assert.ok(rig.noLeaks(), JSON.stringify(rig.probeAfterShutdown()));
  assert.equal(rig.installation.handle.isLive(), false);
  assert.deepEqual(rig.installation.profiles(), []);
});

test("a Session shutdown closes an active Run and its retained BackendAgent", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });

  await rig.host.sessionStart();
  await rig.text("agent_start", {
    agent: RIG_RESUMABLE_PROFILE,
    description: "d",
    prompt: "p",
  });
  await rig.probe();
  await rig.host.sessionShutdown();

  assert.ok(rig.noLeaks(), JSON.stringify(rig.probeAfterShutdown()));
  // The fake's own evidence, from the other side of the contract: the
  // BackendAgent was closed and nothing it acquired for the execution is
  // still attached.
  const counters = rig.resumable.counters();
  assert.equal(counters.closes, counters.opens);
  assert.equal(counters.liveExecutions, 0);
  assert.equal(counters.liveSubscriptions, 0);
});

test("a shutdown with no Session is a no-op rather than an error", async (t) => {
  const rig = hostRig(t);

  await rig.host.sessionShutdown();
  await rig.host.sessionShutdown();

  assert.equal(rig.installation.handle.isLive(), false);
});

test("ten consecutive Sessions each start, run, and shut down with a zero probe", async (t) => {
  const rig = hostRig(t);

  for (let session = 0; session < 10; session += 1) {
    await rig.host.sessionStart();
    const started = startedIds(
      await rig.text("agent_start", {
        agent: RIG_RESUMABLE_PROFILE,
        description: `session ${session}`,
        prompt: "p",
      }),
    );
    await rig.text("agent_wait", { ids: [started.runId] });
    await rig.probe();
    await rig.host.sessionShutdown();

    assert.ok(
      rig.noLeaks(),
      `session ${session} leaked: ${JSON.stringify(rig.probeAfterShutdown())}`,
    );
  }
});

// -- The start-up warning ----------------------------------------------------

test("the invalid-Profile warning names one file per line", () => {
  assert.equal(
    formatInvalidProfilesWarning([
      { filePath: "/agents/one.md", reason: "missing required description" },
      { filePath: "/agents/two.md", reason: "unknown backend 'nope'" },
    ]),
    "Invalid subagent Profiles were skipped:\n" +
      "- /agents/one.md: missing required description\n" +
      "- /agents/two.md: unknown backend 'nope'",
  );
});
