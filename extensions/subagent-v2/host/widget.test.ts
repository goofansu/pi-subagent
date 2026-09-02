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
import { liveRows, WIDGET_KEY } from "./widget.ts";

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

  const rows = rig.host.widgetLines(60);
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0],
    `───${" subagents (1 running) "}${"─".repeat(60 - 3 - 23)}`,
  );
  assert.match(rows[1], /^ explore {2}pi {2}(1 turn|—) {2}running · /);
});

test("a Run of the one-shot backend names its own backend in the row", async (t) => {
  const rig = hostRig(t, {
    oneShotSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig, RIG_ONE_SHOT_PROFILE);

  assert.match(
    rig.host.widgetLines(60)[1],
    /^ once {2}one-shot {2}— {2}running/,
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

test("a terminal Run leaves the widget at publication, and the last one takes it away", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await heldRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });

  // v1 kept a settled row until its notification landed. v2's row shows what
  // is live, so it goes when the Run does.
  assert.equal(rig.host.hasWidget(), false);
  assert.ok(rig.host.widgetClears() >= 1);
  assert.deepEqual(rig.host.widgetLines(), []);
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

test("a burst of index changes produces far fewer render requests than changes", async (t) => {
  const BURST = 200;
  const activity = Array.from({ length: BURST }, (_unused, index) => ({
    step: "emit" as const,
    observation: { kind: "activity" as const, activity: `step ${index}` },
  }));
  const rig = hostRig(t, {
    resumableSteps: [[...activity, { step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  await heldRun(rig);
  await rig.pump();

  const activityCounts = rig.installation.widget()?.activity();
  assert.ok(activityCounts, "the Session installed no widget");
  // The subscriber saw the burst...
  assert.ok(
    activityCounts.changes > BURST / 2,
    `only ${activityCounts.changes} changes reached the subscriber`,
  );
  // ...and asked for a small number of renders, because a render that has not
  // happened yet will read the newer value anyway.
  assert.ok(
    activityCounts.renderRequests * 4 < activityCounts.changes,
    `${activityCounts.renderRequests} renders for ${activityCounts.changes} changes is not coalescing`,
  );
  // The row shows the latest state rather than a stale one.
  assert.match(rig.host.widgetLines(80)[1], new RegExp(`step ${BURST - 1}$`));
});

test("a slow subscriber still renders the latest state after the burst", async (t) => {
  const rig = hostRig(t, {
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

test("the widget lists only Runs that are not terminal", () => {
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
  ]);

  assert.deepEqual(
    liveRows(index).map((row) => row.identity.runId),
    ["run-1", "run-2"],
  );
});

test("the widget owns one key, so a Session cannot leave two of them installed", () => {
  assert.equal(WIDGET_KEY, "subagent-v2-runs");
});
