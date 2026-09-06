import assert from "node:assert/strict";
import { test } from "node:test";
import { runId, subagentId } from "../domain/index.ts";
import { emitText } from "../testing/fakes/script.ts";
import {
  hostRig,
  RIG_ANSWER,
  RIG_ONE_SHOT_PROFILE,
  RIG_POLICY,
  RIG_RESUMABLE_PROFILE,
  startedIds,
} from "../testing/host-rig.ts";
import {
  buildNotificationMessage,
  parseNotificationMessage,
} from "./notification-message.ts";

/**
 * The M3 exit gate, proven at the surface.
 *
 * Each test here is one gate item, and each is written so that a reader can
 * see the user-visible claim rather than the mechanism behind it:
 *
 * - every public operation works against both fakes;
 * - a terminal widget change and a retrievable Result are visible together;
 * - storage precedes notification, and a missed delivery cannot lose a Result;
 * - repeated Sessions leave nothing alive.
 *
 * The last of those is in the Session tests, next to the rest of the Session
 * lifecycle. Everything else is here.
 */

const BOTH_FAKES = [
  { agent: RIG_RESUMABLE_PROFILE, backend: "pi" },
  { agent: RIG_ONE_SHOT_PROFILE, backend: "one-shot" },
] as const;

async function started(
  rig: ReturnType<typeof hostRig>,
  agent: string,
): Promise<{ readonly subagentId: string; readonly runId: string }> {
  return startedIds(
    await rig.text("agent_start", {
      agent,
      description: "look around",
      prompt: "have a look",
    }),
  );
}

async function commandText(
  rig: ReturnType<typeof hostRig>,
  args: string,
): Promise<string> {
  const command = rig.host
    .commands()
    .find((entry) => entry.name === "subagent");
  assert.ok(command, "the /subagent command was not registered");
  const messages: string[] = [];
  await command.handler(args, {
    ui: { notify: (message: string) => messages.push(message) },
  });
  return messages.at(-1) ?? "";
}

// -- Every operation, against both fakes -------------------------------------

for (const fake of BOTH_FAKES) {
  test(`every public operation answers for the ${fake.backend} backend`, async (t) => {
    const rig = hostRig(t);
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());

    // start: the success path, and the rejection every backend shares.
    const ids = await started(rig, fake.agent);
    assert.match(
      await rig.text("agent_start", {
        agent: "ghost",
        description: "d",
        prompt: "p",
      }),
      /^Unknown agent: "ghost"\./,
    );

    // steer: accepted or unsupported, depending on the backend's capability,
    // and unknown for an id no Run ever had.
    const steered = await rig.text("agent_steer", {
      id: ids.runId,
      message: "go left",
    });
    assert.match(
      steered,
      fake.backend === "pi"
        ? /Steering accepted|already completed|mailbox closed/
        : /declared no steering Control|already completed/,
    );
    assert.match(
      await rig.text("agent_steer", { id: "run-never", message: "go" }),
      /unknown Run/,
    );

    // wait: the success path, which delivers the Result, and the unknown-id
    // path.
    const waited = await rig.text("agent_wait", { ids: [ids.runId] });
    assert.match(waited, new RegExp(`, run ${ids.runId}:\n`));
    assert.match(waited, /· completed in /);
    assert.match(waited, new RegExp(RIG_ANSWER));
    assert.equal(
      await rig.text("agent_wait", { ids: ["run-never"] }),
      "Unknown run ids: run-never.",
    );

    // result: the stored answer, and the unknown-id path.
    assert.match(
      await rig.text("agent_result", { id: ids.runId }),
      new RegExp(RIG_ANSWER),
    );
    assert.match(
      await rig.text("agent_result", { id: "run-never" }),
      /^No run with id run-never\./,
    );

    // cancel: a terminal Run reports as finished, an unknown one as unknown.
    const cancelled = await rig.text("agent_cancel", {
      ids: [ids.runId, "run-never"],
    });
    assert.match(cancelled, /Already finished, result kept/);
    assert.match(cancelled, /Unknown run ids: run-never\./);

    // resume: supported or not, depending on the backend, and unknown for an
    // id that names no Subagent.
    assert.match(
      await rig.text("agent_resume", {
        id: ids.subagentId,
        description: "again",
        prompt: "once more",
      }),
      fake.backend === "pi" ? /^Resumed subagent/ : /does not support resume/,
    );
    assert.match(
      await rig.text("agent_resume", {
        id: "subagent-never",
        description: "d",
        prompt: "p",
      }),
      /unknown Subagent/,
    );
  });
}

// -- Bounded cancellation at the surface ------------------------------------

test("a stuck demo execution is cancelled visibly and remains inspectable", async (t) => {
  const partial = "the part produced before the provider stuck";
  const cleanupBudgetMillis = 2_000;
  const rig = hostRig(t, {
    resumableSteps: [
      [emitText(partial), { step: "hang-on-stop" }],
      [emitText(partial), { step: "hang-on-stop" }],
    ],
    testClock: true,
    policy: { ...RIG_POLICY, cleanupBudgetMillis },
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.pump();

  const cancel = await rig.text("agent_cancel", { ids: [ids.runId] });
  assert.equal(
    cancel,
    `Cancellation requested: ${ids.runId}. Each Run stops when its execution and cleanup finish, keeps whatever output it produced, and still sends its own notification.`,
  );
  assert.match(rig.host.widgetLines().join("\n"), /cancelling/);

  await rig.advanceClock(cleanupBudgetMillis + 1);
  await rig.pump();

  assert.match(rig.host.widgetLines().join("\n"), /cancelled/);
  assert.match(
    await commandText(rig, ""),
    /Runtime: attention needed · 1 incident/,
  );
  assert.match(await commandText(rig, "diagnostics"), /cleanupEscalations: 1/);

  const notice = rig.host.sent()[0]?.message;
  assert.ok(notice, "the cancelled Run sent no notice");
  await rig.host.messageStart({ role: "custom", ...notice });
  await rig.pump();
  assert.deepEqual(rig.host.widgetLines(), []);

  const result = await rig.text("agent_result", { id: ids.runId });
  assert.match(result, new RegExp(partial));
  assert.match(result, /native cleanup did not finish/);

  // A wait already blocked on another stuck Run is released by the same one
  // budget advancement; it does not rely on polling agent_result afterwards.
  const waitingIds = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.pump();
  await rig.text("agent_cancel", { ids: [waitingIds.runId] });
  const waiting = rig.text("agent_wait", { ids: [waitingIds.runId] });
  await rig.pump();
  await rig.advanceClock(cleanupBudgetMillis + 1);
  const waited = await waiting;
  assert.match(waited, /cancelled/);
  assert.match(waited, new RegExp(partial));
});

test("session shutdown abandons a stuck Run and the next Session starts cleanly", async (t) => {
  const cleanupBudgetMillis = 2_000;
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "hang-on-stop" }]],
    testClock: true,
    policy: { ...RIG_POLICY, cleanupBudgetMillis },
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.pump();
  await rig.probe();
  // Capture the Session's TestClock before release makes the handle reject
  // new work; its service remains controllable while disposal is in flight.
  await rig.advanceClock(0);

  const shutdown = rig.host.sessionShutdown();
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await rig.advanceClock(cleanupBudgetMillis + 1);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await rig.advanceClock(cleanupBudgetMillis + 1);
  await shutdown;
  assert.equal(rig.installation.handle.isLive(), false);
  assert.equal(rig.noLeaks(), true);

  await rig.host.sessionStart();
  assert.equal(rig.installation.handle.isLive(), true);
  assert.deepEqual(rig.host.widgetLines(), []);
});

// -- Atomicity at the surface ------------------------------------------------

test("when the widget stops listing a Run, agent_result returns its result", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();
  // A row lasts until its notice lands, so landing the notice is what takes
  // the Run off the widget.
  await rig.host.messageStart({
    role: "custom",
    ...rig.host.sent()[0].message,
  });
  await rig.pump();

  // A Run that has left the widget has been announced, and a Run that has been
  // announced was stored before the notice was built — so it has a result.
  assert.deepEqual(rig.host.widgetLines(), []);
  const result = await rig.text("agent_result", { id: ids.runId });
  assert.doesNotMatch(result, /has not finished yet/);
  assert.match(result, new RegExp(RIG_ANSWER));
});

test("a Run that is still on the widget has no result yet, and says so", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.pump();

  assert.ok(rig.host.widgetLines().length > 0);
  assert.match(
    await rig.text("agent_result", { id: ids.runId }),
    /has not finished yet, so it has no result/,
  );
});

// -- Storage precedes notification -------------------------------------------

test("a settled Run sends exactly one follow-up notice that triggers a turn", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();

  const sent = rig.host.sent();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  // Built from the stored Result, so the notice and `agent_result` cannot
  // disagree about what the Run said.
  assert.match(String(sent[0].message.content), new RegExp(RIG_ANSWER));
  const parsed = parseNotificationMessage({
    role: "custom",
    ...sent[0].message,
  });
  // The duration is wall-clock and therefore the one field a golden cannot
  // name; everything else the collapsed line reads is exact.
  assert.ok((parsed?.durationMillis ?? -1) >= 0);
  assert.deepEqual(
    { ...parsed, durationMillis: 0 },
    {
      runId: ids.runId,
      subagentId: ids.subagentId,
      agent: RIG_RESUMABLE_PROFILE,
      label: "look around",
      status: "completed",
      durationMillis: 0,
    },
  );
});

test("a push that fails leaves the Result retrievable and unchanged", async (t) => {
  let failing = true;
  const rig = hostRig(t, { sendFails: () => failing });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();

  // The push threw, so nothing was sent and nothing is waiting to land.
  assert.deepEqual(rig.host.sent(), []);
  assert.deepEqual(rig.installation.sink.unlanded(), []);
  // The Result is exactly what it would have been.
  const before = await rig.text("agent_result", { id: ids.runId });
  assert.match(before, new RegExp(RIG_ANSWER));

  failing = false;
  assert.equal(await rig.text("agent_result", { id: ids.runId }), before);
});

test("a notice an interrupt discarded is pushed again and lands exactly once", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();
  assert.equal(rig.host.sent().length, 1);
  assert.deepEqual(rig.installation.sink.unlanded(), [ids.runId]);

  // The turn that would have carried the notice was interrupted.
  await rig.host.turnEnd({ stopReason: "aborted" });
  await rig.host.agentSettled();

  assert.equal(rig.host.sent().length, 2);

  // The re-pushed notice lands, and the Result is untouched throughout.
  const resent = rig.host.sent()[1].message;
  await rig.host.messageStart({ role: "custom", ...resent });

  assert.deepEqual(rig.installation.sink.landed(), [ids.runId]);
  assert.deepEqual(rig.installation.sink.unlanded(), []);
  await rig.host.turnEnd({ stopReason: "aborted" });
  await rig.host.agentSettled();
  assert.equal(rig.host.sent().length, 2);
  assert.match(
    await rig.text("agent_result", { id: ids.runId }),
    new RegExp(RIG_ANSWER),
  );
});

test("a lost notice waits while Pi still holds pending messages", async (t) => {
  const rig = hostRig(t, { hasPendingMessages: true });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();
  assert.equal(rig.host.sent().length, 1);

  await rig.host.turnEnd({ stopReason: "aborted" });
  await rig.host.agentSettled();

  assert.equal(rig.host.sent().length, 1);
  await rig.host.turnEnd({ stopReason: "stop" });
  assert.equal(rig.host.sent().length, 2);
});

test("a notice that landed the first time is never sent twice", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();
  await rig.host.messageStart({
    role: "custom",
    ...rig.host.sent()[0].message,
  });

  await rig.host.turnEnd({ stopReason: "aborted" });
  await rig.host.agentSettled();

  assert.equal(rig.host.sent().length, 1);
  assert.deepEqual(rig.installation.sink.landed(), [ids.runId]);
});

test("shutting down drops an unlanded notice rather than sending it into the next Session", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();
  assert.deepEqual(rig.installation.sink.unlanded(), [ids.runId]);

  await rig.host.sessionShutdown();
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await rig.host.turnEnd({ stopReason: "aborted" });
  await rig.host.agentSettled();

  // One message, from the Session that asked for it.
  assert.equal(rig.host.sent().length, 1);
});

test("a cancelled Run still notifies, and its notice points at what it produced", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.text("agent_cancel", { ids: [ids.runId] });
  await rig.settled(ids.runId);
  await rig.pump();

  const sent = rig.host.sent();
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].message.content,
    `Subagent "look around" was cancelled in 0.0s (requested).\n\n` +
      `Agent: explore\nRun: ${ids.runId}\nSubagent: ${ids.subagentId}\n\n` +
      `No output was produced. The Run record is available. Call agent_result with {"id":"${ids.runId}"}.`,
  );
});

test("the message the sink sends is the one the renderer can parse", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const ids = await started(rig, RIG_RESUMABLE_PROFILE);
  await rig.settled(ids.runId);
  await rig.pump();

  // The build and the parse are one declaration, so this is a round trip
  // rather than two shapes that happen to agree today.
  const sent = rig.host.sent()[0].message;
  const rebuilt = buildNotificationMessage({
    runId: runId(ids.runId),
    subagentId: subagentId(ids.subagentId),
    agent: RIG_RESUMABLE_PROFILE,
    label: "look around",
    status: "completed",
    resultAvailability: "complete",
    output: RIG_ANSWER,
    preview: RIG_ANSWER,
    // The Run's real duration, which is wall-clock: the round trip is about
    // the two shapes agreeing, not about what the clock said.
    durationMillis: (sent.details as { durationMillis: number }).durationMillis,
    accounting: { inputTokens: 12, outputTokens: 8, cost: 0, turns: 1 },
    retrieveWith: "agent_result",
  });

  assert.deepEqual(sent.details, rebuilt.details);
  assert.equal(sent.content, rebuilt.content);
});
