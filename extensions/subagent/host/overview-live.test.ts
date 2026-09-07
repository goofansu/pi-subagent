import assert from "node:assert/strict";
import { test } from "node:test";
import { runSummaries } from "../application/history.ts";
import { subagentId } from "../domain/index.ts";
import {
  emitActivity,
  emitToolCall,
  emitToolProgress,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  type HostRig,
  hostRig,
  RIG_POLICY,
  startedIds,
} from "../testing/host-rig.ts";

const ENTER = "\r";
const ESC = "\x1b";
const screen = (rig: HostRig) => rig.host.customLines(160).join("\n");
const start = async (rig: HostRig, description: string) =>
  startedIds(
    await rig.text("agent_start", {
      agent: "explore",
      description,
      prompt: "work",
    }),
  );

test("elapsed time refreshes on publication and navigation, never on idle renders or clock ticks", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [
        emitActivity("reading"),
        { step: "await-gate", gate: "change" },
        emitActivity("writing"),
        { step: "await-gate", gate: "finish" },
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig, "elapsed Label");
  await rig.pump();
  const browsing = rig.host.command("subagent", "dashboard");
  await rig.pump();
  const initial = screen(rig);
  assert.match(initial, /0\.0s/);
  const requests = rig.host.customRenderRequests();
  await rig.advanceClock(1500);
  assert.equal(rig.host.customRenderRequests(), requests);
  assert.equal(screen(rig), initial);
  await rig.release("change");
  await rig.pump();
  assert.match(screen(rig), /1\.5s/);
  const keys = ["\x1b[B", "\x1b[A", "\x1b[C", "\x1b[D", "\x1b[6~", "\x1b[5~"];
  for (const [i, key] of keys.entries()) {
    const before = screen(rig);
    const draws = rig.host.customRenderRequests();
    await rig.advanceClock(1000);
    assert.equal(rig.host.customRenderRequests(), draws);
    assert.equal(screen(rig), before);
    rig.host.customKey(key);
    assert.ok(screen(rig).includes(`${i + 2}.5s`));
  }
  await rig.release("finish");
  await rig.settled(work.runId);
  await rig.pump();
  const terminal = screen(rig);
  assert.match(terminal, /Completed/);
  assert.match(terminal, /7\.5s/);
  await rig.advanceClock(10000);
  rig.host.customKey("\x1b[B");
  assert.equal(screen(rig), terminal);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /7\.5s/);
  rig.host.customKey(ESC);
  await rig.pump();
  rig.host.customKey(ESC);
  await browsing;
});

test("semantic activity survives equal observations, clears and settlement without clock-driven redraws", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    policy: {
      ...RIG_POLICY,
      projection: { ...RIG_POLICY.projection, maxTextPartBytes: 12 },
    },
    resumableSteps: [
      [
        emitActivity("  reading\nfile  "),
        { step: "await-gate", gate: "equal" },
        emitActivity("reading file ignored suffix"),
        { step: "await-gate", gate: "clear" },
        {
          step: "emit",
          observation: { kind: "activity", activity: undefined },
        },
        { step: "await-gate", gate: "repeat" },
        emitActivity("reading file"),
        { step: "await-gate", gate: "new" },
        emitActivity("writing file"),
        { step: "await-gate", gate: "finish" },
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig, "任务 Label");
  await rig.pump();
  const baseline = await rig.probe();
  const browsing = rig.host.command("subagent", "dashboard");
  await rig.pump();
  const initial = screen(rig);
  assert.match(initial, /reading file/);
  assert.doesNotMatch(initial, /changed .* ago/);
  const requests = rig.host.customRenderRequests();
  await rig.advanceClock(500);
  assert.equal(rig.host.customRenderRequests(), requests);
  await rig.advanceClock(500);
  await rig.pump();
  assert.equal(rig.host.customRenderRequests(), requests);
  assert.equal(screen(rig), initial);
  for (const gate of ["equal", "clear", "repeat"]) {
    await rig.release(gate);
    await rig.pump();
    await rig.advanceClock(1000);
    await rig.pump();
  }
  assert.match(screen(rig), /reading file/);
  assert.match(rig.host.customLines(20).join("\n"), /任务 Label/);
  await rig.release("new");
  await rig.pump();
  assert.match(screen(rig), /writing file/);
  await rig.advanceClock(2000);
  await rig.release("finish");
  await rig.settled(work.runId);
  await rig.pump();
  assert.match(screen(rig), /Completed/);
  assert.doesNotMatch(screen(rig), /writing file|changed .* ago/);
  const rows = await rig.installation.handle.run(
    runSummaries(subagentId(work.subagentId)),
    [],
  );
  assert.equal(rows[0]?.activity, undefined);
  assert.deepEqual(rows[0]?.lastActivity, {
    summary: "writing file",
    changedAt: 4000,
  });
  rig.host.customKey(ENTER);
  await rig.pump();
  const frozen = screen(rig);
  const historyRequests = rig.host.customRenderRequests();
  assert.equal(
    (await rig.probe()).repositorySubscriptions,
    baseline.repositorySubscriptions,
  );
  await rig.advanceClock(5000);
  await rig.pump();
  assert.equal(screen(rig), frozen);
  assert.equal(rig.host.customRenderRequests(), historyRequests);
  rig.host.customKey(ESC);
  await rig.pump();
  assert.doesNotMatch(screen(rig), /writing file/);
  const overviewRequests = rig.host.customRenderRequests();
  await rig.advanceClock(5000);
  await rig.pump();
  assert.equal(rig.host.customRenderRequests(), overviewRequests);
  rig.host.customKey(ESC);
  await browsing;
  await rig.pump();
  assert.equal(
    (await rig.probe()).repositorySubscriptions,
    baseline.repositorySubscriptions,
  );
  const closedRequests = rig.host.customRenderRequests();
  await rig.advanceClock(5000);
  await rig.pump();
  assert.equal(rig.host.customRenderRequests(), closedRequests);
  await rig.host.sessionShutdown();
  assert.equal(rig.noLeaks(), true);
});

test("bursts keep one pending draw while the host is slow; elapsed time alone never redraws", async (t) => {
  const burst = (prefix: string): FakeStep[] =>
    Array.from({ length: 500 }, (_, i) => emitActivity(`${prefix} ${i}`));
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [
        { step: "await-gate", gate: "burst" },
        ...burst("first"),
        { step: "await-gate", gate: "second" },
        ...burst("latest"),
        emitToolCall("read", "call-1"),
        emitToolProgress("call-1", "completed", "read file"),
        { step: "cumulative-usage", total: { input: 3, output: 2 } },
        { step: "hang" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const browsing = rig.host.command("subagent", "dashboard");
  await rig.pump();
  assert.match(screen(rig), /No subagents/);
  await start(rig, "first Label");
  await start(rig, "second Label");
  await rig.pump();
  assert.match(screen(rig), /first Label/);
  const requests = rig.host.customRenderRequests();
  await rig.release("burst");
  await rig.pump(3000);
  await rig.advanceClock(3000);
  await rig.release("second");
  await rig.pump(3000);
  await rig.advanceClock(3000);
  // No render acknowledgement for either burst: a slow terminal owes one frame, not 2000.
  assert.equal(rig.host.customRenderRequests(), requests + 1);
  const latest = screen(rig);
  assert.match(latest, /latest 499/);
  assert.doesNotMatch(latest, /first 499/);
  assert.ok(latest.indexOf("first Label") < latest.indexOf("second Label"));
  const drained = rig.host.customRenderRequests();
  await rig.pump(3000);
  assert.equal(rig.host.customRenderRequests(), drained);
  await rig.advanceClock(1000);
  await rig.pump();
  assert.equal(rig.host.customRenderRequests(), drained);
  const callbacks = rig.host.captureCustom();
  await rig.probe();
  await rig.host.sessionStart();
  await browsing;
  assert.equal(rig.noLeaks(), true);
  const after = rig.host.customRenderRequests();
  await rig.advanceClock(5000);
  await rig.pump();
  assert.deepEqual(callbacks?.render(160), []);
  assert.equal(rig.host.customRenderRequests(), after);
});

test("selected identity stays visible across live latest-Run groups; peers retain creation order", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [{ step: "fail", message: "earlier failure" }],
      [{ step: "await-gate", gate: "success" }, { step: "complete" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const works = [];
  for (let i = 0; i < 6; i += 1) {
    const work = await start(rig, `task ${i}`);
    await rig.settled(work.runId);
    works.push(work);
  }
  const browsing = rig.host.command("subagent", "dashboard");
  await rig.pump();
  screen(rig);
  for (let i = 0; i < 5; i += 1) rig.host.customKey("\x1b[B");
  assert.match(rig.host.customLines(100, 10).join("\n"), /task 5/);
  const selected = works[5];
  const resumed = await rig.text("agent_resume", {
    id: selected.subagentId,
    description: "retry Label",
    prompt: "retry",
  });
  const retry = /run id (\S+)/.exec(resumed)?.[1];
  assert.ok(retry, resumed);
  await rig.pump();
  const active = rig.host.customLines(100, 10).join("\n");
  assert.match(rig.host.customLines(160, 60).join("\n"), /Running/);
  assert.match(active, /› retry Label +Running/);
  assert.match(active, /retry Label/);
  await rig.release("success");
  await rig.settled(retry);
  await rig.pump();
  const completed = rig.host.customLines(100, 10).join("\n");
  assert.match(completed, /Completed/);
  assert.match(completed, /› retry Label +Completed/);
  assert.match(completed, /retry Label/);
  const all = rig.host.customLines(160, 60).join("\n");
  assert.doesNotMatch(all, /Running/);
  for (let i = 0; i < 4; i += 1)
    assert.ok(all.indexOf(`task ${i}`) < all.indexOf(`task ${i + 1}`));
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Failed/);
  assert.match(screen(rig), /Completed/);
  assert.match(screen(rig), /Subagent dashboard · run history · explore/);
  assert.match(screen(rig), /task 5/);
  rig.host.customKey(ESC);
  await rig.pump();
  rig.host.customKey(ESC);
  await browsing;
  await rig.probe();
  await rig.host.sessionShutdown();
  assert.equal(rig.noLeaks(), true);
});
