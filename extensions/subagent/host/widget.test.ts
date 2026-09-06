import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId, runId, subagentId } from "../domain/index.ts";
import type { RunIndex, RunSnapshot } from "../runtime/repository.ts";
import {
  hostRig,
  RIG_ACTIVITY,
  RIG_ONE_SHOT_PROFILE,
  RIG_RESUMABLE_PROFILE,
  startedIds,
} from "../testing/host-rig.ts";
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
  // The row: the agent, backend, status, the turn count, and what the Run
  // said it is doing. No glyph and no clock on a live row.
  assert.match(
    rows[1],
    new RegExp(
      `^ explore {2}pi {2}running {2}(1 turn|—) {2}look around( · ${RIG_ACTIVITY})?$`,
    ),
  );
  assert.doesNotMatch(rows[1] ?? "", /\d\.\ds/);
});

test("a Run of the one-shot backend names its own backend in the row", async (t) => {
  const rig = hostRig(t, {
    oneShotSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig, RIG_ONE_SHOT_PROFILE);

  assert.match(
    rig.host.widgetLines(120)[1],
    /^ once {2}one-shot {2}running {2}—/,
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
  assert.match(rig.host.widgetLines(60)[1], /^ explore {2}pi {2}completed in /);
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

test("a settled row says what the Run cost, and the number does not move", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  await rig.settled(started.runId);
  await rig.pump();

  // The Run has settled and is waiting for its notice to land, which is the
  // whole window in which a moving number is visible to anybody.
  assert.deepEqual(rig.installation.sink.unlanded(), [started.runId]);
  const settled = rig.host.widgetLines(60);
  assert.match(settled[1], /completed/);

  // Both instants are far past the Run's own, so a row measured against the
  // draw's clock would report a second and then a minute where it had reported
  // a moment. The row's figure is the Run's, so it reads the same every time.
  rig.renderAt(Date.now() + 1_000);
  assert.deepEqual(rig.host.widgetLines(60), settled);
  rig.renderAt(Date.now() + 61_000);
  assert.deepEqual(rig.host.widgetLines(60), settled);

  // And what it says is a cost, not an age: a fake Run takes milliseconds, so
  // the figure is a sub-minute one however late the row is drawn.
  assert.match(settled[1], /completed in \d+\.\ds/);
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
  assert.match(rig.host.widgetLines(80)[1], new RegExp(`step ${BURST - 1}$`));
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

  assert.match(rig.host.widgetLines(80)[1], / · last$/);
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
  const row = rig.host.widgetLines(120)[1];
  assert.match(row, /^ explore {2}pi {2}completed in /);
  assert.match(
    row,
    new RegExp(`notification failed · ${started.runId} · result available$`),
  );

  await rig.text("agent_result", { id: started.runId });
  await rig.pump();

  assert.equal(rig.host.hasWidget(), false);
});

test("the widget owns one key, so a Session cannot leave two of them installed", () => {
  assert.equal(WIDGET_KEY, "subagent-runs");
});
