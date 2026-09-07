import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { backendId, runId, subagentId } from "../domain/index.ts";
import type { RunIndex, RunSnapshot } from "../runtime/repository.ts";
import {
  hostRig,
  RIG_ACTIVITY,
  RIG_ONE_SHOT_PROFILE,
  RIG_RESUMABLE_PROFILE,
  startedIds,
} from "../testing/host-rig.ts";
import { PLAIN_THEME } from "../testing/stand-in-host.ts";
import { WIDGET_KEY, widgetRows } from "./widget.ts";

/**
 * The active widget, driven through the Session that installs it.
 *
 * Everything here is asserted from the host's side: whether a widget is
 * installed, what its rows say, how many redraws it asked for. The widget's
 * own change counter is read for the coalescing test, because "far fewer
 * renders than changes" is a ratio and a ratio needs both numbers.
 */

/** Start a Run and hold it open on a gate. */
async function heldRun(
  rig: ReturnType<typeof hostRig>,
  agent = RIG_RESUMABLE_PROFILE,
): Promise<{ readonly subagentId: string; readonly runId: string }> {
  return startedIds(
    await rig.text("agent_start", {
      agent,
      description: "look around",
      prompt: "have a look",
    }),
  );
}

test("the widget appears with the first live Run and its row reads as the matrix says", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [
        {
          step: "emit",
          observation: { kind: "activity", activity: RIG_ACTIVITY },
        },
        { step: "cumulative-usage", total: { input: 4, output: 2 } },
        { step: "await-gate", gate: "hold" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  assert.equal(rig.host.hasWidget(), false);

  await heldRun(rig);
  // The widget renders from the latest index, which the subscriber wrote when
  // the Run was published.
  assert.equal(rig.host.hasWidget(), true);

  const rows = rig.host.widgetLines(120);
  assert.equal(rows.length, 2);
  // The title names the widget and counts the Run, and nothing else.
  assert.equal(rows[0], " subagents   1 running");
  // Starting returns after the Run publication, before the backend's first
  // activity publication is guaranteed. Accounting can race that activity too.
  assert.match(
    rows[1],
    new RegExp(`^ look around {2}running · (${RIG_ACTIVITY}|—) +0\\.0s$`),
  );

  // Once the real repository/subscriber pipeline has published the scripted
  // activity, the externally rendered row must include it beside Run duration.
  await rig.pump();
  assert.match(
    rig.host.widgetLines(120)[1] ?? "",
    new RegExp(`^ look around {2}running · ${RIG_ACTIVITY} +0\\.0s$`),
  );
});

test("elapsed advances only on Run publications, independent of activity and incidental renders", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [
        { step: "await-gate", gate: "first-activity" },
        {
          step: "emit",
          observation: { kind: "activity", activity: "reading file" },
        },
        { step: "await-gate", gate: "equal" },
        {
          step: "emit",
          observation: { kind: "activity", activity: "reading file" },
        },
        { step: "await-gate", gate: "changed" },
        {
          step: "emit",
          observation: { kind: "activity", activity: "writing file" },
        },
        { step: "await-gate", gate: "clear" },
        {
          step: "emit",
          observation: { kind: "activity", activity: undefined },
        },
        { step: "await-gate", gate: "repeat-after-clear" },
        {
          step: "emit",
          observation: { kind: "activity", activity: "writing file" },
        },
        { step: "await-gate", gate: "restore" },
        {
          step: "emit",
          observation: { kind: "activity", activity: "packing result" },
        },
        { step: "gate-the-finalizer", gate: "cleanup" },
        { step: "await-gate", gate: "finish" },
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const started = await heldRun(rig);
  await rig.pump();

  assert.match(rig.host.widgetLines(120)[1] ?? "", /running · — +0\.0s/);
  await rig.advanceClock(1_000);
  await rig.release("first-activity");
  await rig.pump();
  assert.match(rig.host.widgetLines(120)[1] ?? "", /reading file +1\.0s/);

  const requests = rig.host.renderRequests();
  await rig.advanceClock(12_400);
  assert.equal(rig.host.renderRequests(), requests);
  for (const width of [120, 100, 120]) {
    assert.match(rig.host.widgetLines(width)[1] ?? "", /reading file +1\.0s/);
  }
  // Hand-off changes must not advance the Run-event clock either.
  await Effect.runPromise(
    rig.installation.sink.exhausted(runId(started.runId)),
  );
  assert.match(rig.host.widgetLines(120)[1] ?? "", /reading file +1\.0s/);

  // Equal semantic activity is still a Run publication.
  await rig.release("equal");
  await rig.pump();
  assert.match(rig.host.widgetLines(120)[1] ?? "", /reading file +13\.4s/);

  await rig.release("changed");
  await rig.pump();
  assert.match(rig.host.widgetLines(120)[1] ?? "", /writing file +13\.4s/);
  await rig.advanceClock(62_000);
  assert.match(rig.host.widgetLines(120)[1] ?? "", /writing file +13\.4s/);

  await rig.release("clear");
  await rig.pump();
  const cleared = rig.host.widgetLines(120)[1] ?? "";
  assert.doesNotMatch(cleared, /writing file|ago/);
  assert.match(cleared, /running · — +1m 15s/);

  // Restoring activity does not reset elapsed Run duration.
  await rig.release("repeat-after-clear");
  await rig.pump();
  assert.match(rig.host.widgetLines(120)[1] ?? "", /writing file +1m 15s/);

  await rig.release("restore");
  await rig.pump();
  assert.match(rig.host.widgetLines(120)[1] ?? "", /packing result +1m 15s/);
  await rig.release("finish");
  await rig.pump();
  const finalizing = rig.host.widgetLines(120)[1] ?? "";
  assert.match(finalizing, /finalizing · — +1m 15s/);
  assert.doesNotMatch(finalizing, /packing result|ago/);
  await rig.release("cleanup");
  await rig.settled(started.runId);
});

test("aggregate mode has no duration or clock redraws and returning to one Run shows sampled elapsed", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [
        {
          step: "emit",
          observation: { kind: "activity", activity: "first work" },
        },
        { step: "await-gate", gate: "first-finish" },
      ],
    ],
    oneShotSteps: [
      [
        {
          step: "emit",
          observation: { kind: "activity", activity: "second work" },
        },
        { step: "await-gate", gate: "second-finish" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const first = await heldRun(rig);
  await rig.advanceClock(1_000);
  await heldRun(rig, RIG_ONE_SHOT_PROFILE);
  await rig.pump();
  assert.deepEqual(rig.host.widgetLines(120), [" subagents   2 running"]);
  const requests = rig.host.renderRequests();

  await rig.advanceClock(61_000);
  assert.equal(rig.host.renderRequests(), requests);
  assert.deepEqual(rig.host.widgetLines(120), [" subagents   2 running"]);

  await rig.release("first-finish");
  await rig.settled(first.runId);
  await rig.pump();
  const single = rig.host.widgetLines(120);
  assert.match(single[1] ?? "", /second work +1m 1s/);
  assert.doesNotMatch(single[0] ?? "", /ago/);
});

test("a Run of the one-shot backend omits backend and turns from detail", async (t) => {
  const rig = hostRig(t, {
    oneShotSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig, RIG_ONE_SHOT_PROFILE);

  assert.match(
    rig.host.widgetLines(120)[1],
    /^ look around {2}running · — +\d+\.\ds$/,
  );
});

test("the widget redraws on a change instead of reinstalling", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [{ step: "await-gate", gate: "first" }],
      [{ step: "await-gate", gate: "second" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await heldRun(rig);
  const installsAfterFirst = rig.host.widgetInstalls();
  assert.equal(installsAfterFirst, 1);

  await rig.text("agent_wait", { ids: [first.runId], timeoutSeconds: 0 });
  await heldRun(rig);

  // A second live Run changed the index; the widget asked to be redrawn and
  // `setWidget` was not called again.
  assert.equal(rig.host.widgetInstalls(), 1);
  assert.ok(rig.host.renderRequests() > 0);
});

test("a terminal Run keeps its row until its completion notice lands, and the landing takes it away", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  await rig.settled(started.runId);
  await rig.pump();

  // The row's job is to be read, and a Run shorter than the turn that started
  // it settles before anyone has looked. So a settled row stays until its
  // answer is in the conversation, which is what v1 did and what the matrix
  // promises.
  assert.equal(rig.host.hasWidget(), true);
  assert.deepEqual(rig.host.widgetLines(60), [" subagents   1 completed"]);
  assert.deepEqual(rig.installation.sink.unlanded(), [started.runId]);

  await rig.host.messageStart({
    role: "custom",
    ...rig.host.sent()[0].message,
  });
  await rig.pump();

  assert.deepEqual(rig.installation.sink.landed(), [started.runId]);
  assert.equal(rig.host.hasWidget(), false);
  assert.ok(rig.host.widgetClears() >= 1);
  assert.deepEqual(rig.host.widgetLines(), []);
});

test("zero-active completion summary remains stable as time passes", async (t) => {
  const rig = hostRig(t, { testClock: true });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  await rig.settled(started.runId);
  await rig.pump();

  // A settled Run remains in the aggregate until the hand-off resolves.
  assert.deepEqual(rig.installation.sink.unlanded(), [started.runId]);
  const settled = rig.host.widgetLines(60);
  assert.deepEqual(settled, [" subagents   1 completed"]);

  // Neither an activity age nor a duration is part of the aggregate.
  const requests = rig.host.renderRequests();
  await rig.advanceClock(1_000);
  assert.deepEqual(rig.host.widgetLines(60), settled);
  await rig.advanceClock(60_000);
  assert.deepEqual(rig.host.widgetLines(60), settled);
  assert.equal(rig.host.renderRequests(), requests);

  // There is no time figure in the summary.
  assert.doesNotMatch(settled[0], /\d+\.\ds/);
});

test("a notice lost to an interrupt keeps its row until the re-push lands", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  await rig.settled(started.runId);
  await rig.pump();
  assert.equal(rig.host.hasWidget(), true);

  // An interrupted turn discards what was queued, so the notice never reached
  // the conversation and the row has to still be there when it is pushed
  // again.
  await rig.host.turnEnd({ stopReason: "aborted" });
  await rig.host.agentSettled();
  await rig.pump();

  assert.equal(rig.host.sent().length, 2);
  assert.equal(rig.host.hasWidget(), true);

  await rig.host.messageStart({
    role: "custom",
    ...rig.host.sent()[1].message,
  });
  await rig.pump();

  assert.equal(rig.host.hasWidget(), false);
});

test("a failed widget install is retried on the next update", async (t) => {
  let failInstall = true;
  const rig = hostRig(t, {
    widgetInstallFails: () => {
      if (!failInstall) return false;
      failInstall = false;
      return true;
    },
    resumableSteps: [
      [{ step: "await-gate", gate: "first" }],
      [{ step: "await-gate", gate: "second" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig);
  assert.equal(rig.host.hasWidget(), false);

  await heldRun(rig);
  await rig.pump();

  assert.equal(rig.host.hasWidget(), true);
  assert.equal(rig.host.widgetInstalls(), 1);
  assert.match(rig.host.widgetLines(80)[0] ?? "", /subagents {3}2 running/);
});

test("the widget is cleared when the Session shuts down", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();

  await heldRun(rig);
  assert.equal(rig.host.hasWidget(), true);

  await rig.host.sessionShutdown();

  assert.equal(rig.host.hasWidget(), false);
});

// -- Coalescing --------------------------------------------------------------

test("a burst of index changes coalesces into one render request per draw", async (t) => {
  const BURST = 200;
  /** A slow terminal: it draws one request in fifty and ignores the rest. */
  const DRAWS_ONE_IN = 50;
  const activity = Array.from({ length: BURST }, (_unused, index) => ({
    step: "emit" as const,
    observation: { kind: "activity" as const, activity: `step ${index}` },
  }));
  const rig = hostRig(t, {
    renderEvery: DRAWS_ONE_IN,
    resumableSteps: [[...activity, { step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig);
  await rig.pump();

  const counts = rig.installation.widget()?.activity();
  assert.ok(counts, "the Session installed no widget");

  // The subscriber saw the burst: the change stream is not conflated, and
  // conflating it is what this widget is for.
  assert.ok(
    counts.changes > BURST / 2,
    `only ${counts.changes} changes reached the subscriber`,
  );

  // The coalescing invariant, and the assertion that can actually fail: a
  // request is armed only while none is outstanding, so the widget never asks
  // for more renders than the host drew, plus the one still outstanding.
  // Delete the pending-render guard and this becomes ~200 against 4.
  assert.ok(
    counts.renderRequests <= rig.host.rendersPerformed() + 1,
    `${counts.renderRequests} requests for ${rig.host.rendersPerformed()} draws`,
  );
  assert.ok(
    counts.renderRequests * 4 < counts.changes,
    `${counts.renderRequests} renders for ${counts.changes} changes is not coalescing`,
  );

  // And the conflation is not lossy: the row shows the latest state.
  assert.match(
    rig.host.widgetLines(80)[1],
    new RegExp(`running · step ${BURST - 1}`),
  );
});

test("a host that draws every request still gets one request per change batch", async (t) => {
  // The other end of the same rule. A fast terminal clears the pending flag at
  // once, so it is asked again for the next change — which is correct, and is
  // why the invariant is "never more than draws plus one" rather than "few".
  const rig = hostRig(t, {
    renderEvery: 1,
    resumableSteps: [
      [
        { step: "emit", observation: { kind: "activity", activity: "one" } },
        { step: "emit", observation: { kind: "activity", activity: "two" } },
        { step: "await-gate", gate: "hold" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig);
  await rig.pump();

  const counts = rig.installation.widget()?.activity();
  assert.ok(counts);
  assert.ok(
    counts.renderRequests <= rig.host.rendersPerformed() + 1,
    `${counts.renderRequests} requests for ${rig.host.rendersPerformed()} draws`,
  );
});

test("a slow subscriber still renders the latest state after the burst", async (t) => {
  const rig = hostRig(t, {
    renderEvery: 3,
    resumableSteps: [
      [
        { step: "emit", observation: { kind: "activity", activity: "first" } },
        { step: "emit", observation: { kind: "activity", activity: "second" } },
        { step: "emit", observation: { kind: "activity", activity: "last" } },
        { step: "await-gate", gate: "hold" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig);
  await rig.pump();

  assert.match(rig.host.widgetLines(80)[1], /running · last/);
});

test("the widget lists Runs that are not terminal and terminal ones whose hand-off is unresolved", () => {
  const snapshot = (id: string, phase: RunSnapshot["phase"]): RunSnapshot => ({
    identity: {
      runId: runId(id),
      subagentId: subagentId("subagent-1"),
      backendId: backendId("pi"),
      agent: "explore",
      description: "look around",
    },
    phase,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      context: { tokens: 0 },
      turns: 0,
    },
    tools: 0,
    startedAt: 0,
    ...(phase === "completed" ? { terminalStatus: "completed" as const } : {}),
  });
  const index: RunIndex = new Map([
    [runId("run-1"), snapshot("run-1", "running")],
    [runId("run-2"), snapshot("run-2", "finalizing")],
    [runId("run-3"), snapshot("run-3", "completed")],
    [runId("run-4"), snapshot("run-4", "completed")],
    [runId("run-5"), snapshot("run-5", "completed")],
  ]);

  const rows = widgetRows(index, (id) =>
    id === runId("run-4")
      ? "resolved"
      : id === runId("run-3")
        ? "exhausted"
        : id === runId("run-5")
          ? "unannounceable"
          : "pending",
  );

  assert.deepEqual(
    rows.map((row) => row.identity.runId),
    ["run-1", "run-2", "run-3", "run-5"],
  );
  // Terminal delivery reports keep their rows marked, because nothing is
  // coming for them and each row has to say why. Every other row is handed
  // over exactly as the index published it.
  assert.deepEqual(
    rows.map((row) => row.handoff),
    [undefined, undefined, "exhausted", "unannounceable"],
  );
});

test("W-3: a settled row leaves when the parent retrieves its Result, with no landing", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  await rig.settled(started.runId);
  await rig.pump();

  // Settled, notice handed to Pi, nothing landed: the row is waiting.
  assert.equal(rig.host.hasWidget(), true);
  assert.deepEqual(rig.installation.sink.landed(), []);

  await rig.text("agent_result", { id: started.runId });
  await rig.pump();

  // The notice never landed, and the row went anyway: the parent has done
  // everything the notice exists to make it do.
  assert.deepEqual(rig.installation.sink.landed(), []);
  assert.equal(rig.installation.sink.status(runId(started.runId)), "resolved");
  assert.equal(rig.host.hasWidget(), false);
});

test("W-4: a settled row leaves when a wait delivers its Result, and no notice follows", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });
  await rig.pump();

  // The wait handed the parent the answer, so the hand-off resolved without a
  // landing and the notice was never Pi's to deliver.
  assert.deepEqual(rig.host.sent(), []);
  assert.equal(rig.installation.sink.status(runId(started.runId)), "resolved");
  assert.equal(rig.host.hasWidget(), false);
});

test("W-2: a row whose notice will never arrive says so, and retrieving the Result takes it away", async (t) => {
  // The sink refuses every push because no Session is bound to send through,
  // which is the one way delivery's budget actually runs out in practice.
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  rig.installation.sink.bind(() => {
    throw new Error("this Session went stale");
  });
  await rig.settled(started.runId);
  await rig.pump();

  assert.equal(rig.installation.sink.status(runId(started.runId)), "exhausted");
  const lines = rig.host.widgetLines(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 completed/);
  assert.match(lines[0], /1 notification failed/);
  assert.doesNotMatch(lines[0], /1 failed|explore|result unavailable/);

  await rig.text("agent_result", { id: started.runId });
  await rig.pump();

  assert.equal(rig.host.hasWidget(), false);
});

test("adaptive modes follow 0 → 1 → 2 → 1 → 0 active Runs with unresolved completions summarized", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "first" }]],
    oneShotSteps: [
      [
        {
          step: "emit",
          observation: { kind: "activity", activity: "newest work" },
        },
        { step: "await-gate", gate: "second" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  assert.equal(rig.host.hasWidget(), false);
  const first = await heldRun(rig);
  assert.equal(rig.host.widgetLines(120).length, 2);
  const second = await heldRun(rig, RIG_ONE_SHOT_PROFILE);
  await rig.pump();
  assert.deepEqual(rig.host.widgetLines(120), [" subagents   2 running"]);

  await rig.release("first");
  await rig.settled(first.runId);
  await rig.pump();
  const single = rig.host.widgetLines(120);
  assert.equal(single.length, 2);
  assert.match(single[0], /1 running.*1 completed/);
  assert.match(single[1], /look around {2}running · newest work/);
  assert.doesNotMatch(single[1], /completed/);
  const narrowSingle = rig.host.widgetLines(32);
  assert.match(narrowSingle[0], /1 running.*1 comp/);
  assert.match(narrowSingle[1], /look a… {2}running · newest work/);
  assert.doesNotMatch(narrowSingle[1], /one-shot|once/);
  for (const line of narrowSingle) assert.ok(visibleWidth(line) <= 32);

  await rig.release("second");
  await rig.settled(second.runId);
  await rig.pump();
  assert.deepEqual(rig.host.widgetLines(120), [" subagents   2 completed"]);
  await rig.text("agent_result", { id: first.runId });
  assert.deepEqual(rig.host.widgetLines(120), [" subagents   1 completed"]);
  await rig.text("agent_wait", { ids: [second.runId] });
  assert.equal(rig.host.hasWidget(), false);
});

test("drawn aggregate ignores alternating hidden activity and accounting but returns fresh detail", async (t) => {
  const steps = (name: string) => [
    { step: "await-gate" as const, gate: `${name}-update` },
    {
      step: "emit" as const,
      observation: { kind: "activity" as const, activity: `${name} newest` },
    },
    { step: "cumulative-usage" as const, total: { input: 12, output: 4 } },
    { step: "await-gate" as const, gate: `${name}-finish` },
  ];
  const rig = hostRig(t, {
    resumableSteps: [steps("first")],
    oneShotSteps: [steps("second")],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const first = await heldRun(rig);
  await heldRun(rig, RIG_ONE_SHOT_PROFILE);
  await rig.pump();
  const frame = rig.host.widgetLines(120); // An actual draw, not merely a pending request.
  const requests = rig.host.renderRequests();
  const changes = rig.installation.widget()?.activity().changes ?? 0;
  for (const name of ["first", "second"]) {
    await rig.release(`${name}-update`);
    await rig.pump();
    assert.equal(rig.host.renderRequests(), requests);
    assert.deepEqual(rig.host.widgetLines(120), frame);
  }
  assert.ok((rig.installation.widget()?.activity().changes ?? 0) > changes);
  await rig.release("first-finish");
  await rig.settled(first.runId);
  await rig.pump();
  assert.match(rig.host.widgetLines(120)[1], /running · second newest/);
  assert.ok(rig.host.renderRequests() > requests);
});

test("finalizing and requested cancellation count as active, and visible changes share one pending draw", async (t) => {
  const rig = hostRig(t, {
    renderEvery: 0,
    resumableSteps: [
      [
        { step: "gate-the-finalizer", gate: "first-cleanup" },
        { step: "await-gate", gate: "first-end" },
      ],
    ],
    oneShotSteps: [
      [
        { step: "gate-the-finalizer", gate: "second-cleanup" },
        { step: "hang" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const first = await heldRun(rig);
  const second = await heldRun(rig, RIG_ONE_SHOT_PROFILE);
  rig.host.widgetLines(120);
  const requests = rig.host.renderRequests();
  await rig.release("first-end");
  await rig.pump();
  assert.equal(rig.host.renderRequests(), requests + 1);
  await rig.text("agent_cancel", { ids: [second.runId] });
  await rig.pump();
  assert.equal(rig.host.renderRequests(), requests + 1);
  const frame = rig.host.widgetLines(120);
  assert.equal(frame.length, 1);
  assert.match(frame[0], /1 finalizing/);
  assert.match(frame[0], /1 cancelling/);
  assert.doesNotMatch(frame[0], /running|completed|look around/);
  await rig.release("first-cleanup");
  await rig.settled(first.runId);
  await rig.pump();
  assert.match(
    rig.host.widgetLines(120)[1],
    /look around {2}cancelling · — +\d+\.\ds$/,
  );
  await rig.release("second-cleanup");
  await rig.settled(second.runId);
  await rig.pump();
  assert.deepEqual(rig.host.widgetLines(120), [
    " subagents   1 completed   1 cancelled",
  ]);
});

test("zero-active attention distinguishes failed outcomes from unavailable delivery and resolution removes only its Run", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [
        { step: "await-gate", gate: "finish" },
        { step: "fail", message: "failed work" },
      ],
    ],
    oneShotSteps: [[{ step: "await-gate", gate: "finish" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const failed = await heldRun(rig);
  const completed = await heldRun(rig, RIG_ONE_SHOT_PROFILE);
  await rig.release("finish");
  await rig.settled(failed.runId, completed.runId);
  await rig.pump();
  // Delivery reports its own fact through the real Session sink, independently
  // of the repository's immutable Run outcome.
  await Effect.runPromise(
    rig.installation.sink.unannounceable(runId(completed.runId)),
  );
  const frame = rig.host.widgetLines(200);
  assert.equal(frame.length, 1);
  assert.match(frame[0], /1 completed.*1 failed/);
  assert.match(frame[0], /1 no notification · result unavailable/);
  assert.doesNotMatch(frame[0], /2 failed|explore|once/);
  assert.match(rig.host.widgetLines(20)[0], /^!/);
  // Rendering at either width did not resolve anything.
  assert.equal(
    rig.installation.sink.status(runId(completed.runId)),
    "unannounceable",
  );
  assert.equal(rig.installation.sink.status(runId(failed.runId)), "pending");
  await rig.text("agent_result", { id: failed.runId });
  assert.doesNotMatch(rig.host.widgetLines(200)[0], /1 failed/);
  assert.match(rig.host.widgetLines(200)[0], /1 completed.*no notification/);
  await rig.host.sessionShutdown();
  const installs = rig.host.widgetInstalls();
  await Effect.runPromise(
    rig.installation.sink.exhausted(runId(completed.runId)),
  );
  await rig.pump();
  assert.equal(rig.host.hasWidget(), false);
  assert.equal(rig.host.widgetInstalls(), installs);
});

test("equal aggregate updates retry failed installation and resize renders current state without a redraw request", async (t) => {
  let failInstall = true;
  let color = "\u001b[31m";
  const rig = hostRig(t, {
    customTheme: {
      ...PLAIN_THEME,
      fg: (_tone, text) => `${color}${text}\u001b[0m`,
    },
    widgetInstallFails: () => failInstall,
    resumableSteps: [
      [
        { step: "await-gate", gate: "update" },
        { step: "emit", observation: { kind: "activity", activity: "hidden" } },
        { step: "hang" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await heldRun(rig);
  await heldRun(rig);
  await rig.pump();
  assert.equal(rig.host.hasWidget(), false);
  failInstall = false;
  await rig.release("update");
  await rig.pump();
  assert.equal(rig.host.hasWidget(), true);
  assert.ok(rig.host.widgetLines(120)[0].includes("\u001b[31m"));
  const requests = rig.host.renderRequests();
  assert.ok(visibleWidth(rig.host.widgetLines(8)[0]) <= 8);
  color = "\u001b[32m";
  const themed = rig.host.widgetLines(120)[0];
  assert.ok(themed.includes("\u001b[32m"));
  assert.ok(!themed.includes("\u001b[31m"));
  assert.equal(rig.host.renderRequests(), requests);
});

test("each changed aggregate hand-off fact requests a new frame after the previous draw", async (t) => {
  const rig = hostRig(t, {
    renderEvery: 0,
    resumableSteps: [[{ step: "await-gate", gate: "finish" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const first = await heldRun(rig);
  const second = await heldRun(rig);
  const third = await heldRun(rig);
  await rig.release("finish");
  await rig.settled(first.runId, second.runId, third.runId);
  await rig.pump();
  assert.deepEqual(rig.host.widgetLines(200), [" subagents   3 completed"]);

  // All Runs stay completed: attention kind/count and resolution must each
  // invalidate an already-drawn aggregate even without an activity or phase change.
  let requests = rig.host.renderRequests();
  const drawChanged = (expected: string) => {
    assert.equal(rig.host.renderRequests(), requests + 1);
    assert.deepEqual(rig.host.widgetLines(200), [expected]);
    requests = rig.host.renderRequests();
  };
  await Effect.runPromise(rig.installation.sink.exhausted(runId(first.runId)));
  drawChanged(" subagents   3 completed   1 notification failed");
  await Effect.runPromise(
    rig.installation.sink.unannounceable(runId(second.runId)),
  );
  drawChanged(
    " subagents   3 completed   1 notification failed   1 no notification · result unavailable",
  );
  await Effect.runPromise(rig.installation.sink.exhausted(runId(third.runId)));
  drawChanged(
    " subagents   3 completed   2 notification failed   1 no notification · result unavailable",
  );
  await rig.text("agent_result", { id: first.runId });
  drawChanged(
    " subagents   2 completed   1 notification failed   1 no notification · result unavailable",
  );
  await rig.text("agent_wait", { ids: [third.runId] });
  drawChanged(
    " subagents   1 completed   1 no notification · result unavailable",
  );
});

test("cancellation publishes elapsed without activity and cleanup keeps the sampled duration", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [{ step: "gate-the-finalizer", gate: "cleanup" }, { step: "hang" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const started = await heldRun(rig);
  await rig.pump();
  await rig.advanceClock(2_400);
  await rig.text("agent_cancel", { ids: [started.runId] });
  await rig.pump();
  assert.match(
    rig.host.widgetLines(120)[1],
    /look around {2}cancelling · — +2\.4s/,
  );
  const requests = rig.host.renderRequests();
  await rig.advanceClock(1_000);
  assert.match(rig.host.widgetLines(100)[1], /cancelling · — +2\.4s/);
  assert.equal(rig.host.renderRequests(), requests);
  await rig.release("cleanup");
  await rig.settled(started.runId);
  await rig.pump();
  assert.deepEqual(rig.host.widgetLines(120), [" subagents   1 cancelled"]);
});

test("the widget owns one key, so a Session cannot leave two of them installed", () => {
  assert.equal(WIDGET_KEY, "subagent-runs");
});
