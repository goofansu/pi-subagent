import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runId } from "../domain/index.ts";
import {
  emitActivity,
  emitText,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  type HostRig,
  hostRig,
  RIG_POLICY,
  startedIds,
} from "../testing/host-rig.ts";
import { PLAIN_THEME } from "../testing/stand-in-host.ts";

test("a history is re-entered on the Run it was left on, under the Subagent the overview kept", async (t) => {
  const steps: readonly FakeStep[] = [{ step: "complete" }];
  const rig = hostRig(t, {
    resumableSteps: Array.from({ length: 12 }, () => steps),
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const ids: Awaited<ReturnType<typeof start>>[] = [];
  for (let i = 0; i < 12; i += 1) {
    const id = await start(rig, `任务${i} 👩‍💻 café`);
    await rig.settled(id.runId);
    ids.push(id);
  }
  await rig.pump();
  const browsing = await open(rig);
  for (let i = 0; i < 11; i += 1) rig.host.customKey(DOWN);
  assert.match(rig.host.customLines(80, 10).join("\n"), /任务11/);
  const target = ids[11];
  for (let i = 1; i < 12; i += 1) {
    const id = await resume(rig, target.subagentId, `successive ${i}`);
    await rig.settled(id);
  }
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(rig.host.customLines(80, 10).join("\n"), /successive 11/);
  for (let i = 0; i < 11; i += 1) rig.host.customKey(DOWN);
  assert.match(rig.host.customLines(80, 10).join("\n"), /任务11/);
  rig.host.customKey(ESC);
  await rig.pump();
  assert.match(rig.host.customLines(80, 10).join("\n"), /successive 11/);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(rig.host.customLines(80, 10).join("\n"), /任务11/);
  rig.host.customKey(UP);
  assert.match(
    rig.host.customLines(80, 10).join("\n"),
    /› successive 1 +Completed/,
  );
  rig.host.customKey(ESC);
  await rig.pump();
  await close(rig, browsing);
});

for (const view of ["overview", "history"] as const) {
  for (const replacement of [false, true]) {
    test(`${replacement ? "replacement" : "shutdown"} at ${view}, including reads in flight, disposes callbacks and cannot render into the next Session`, async (t) => {
      const rig = hostRig(t);
      await rig.host.sessionStart();
      t.after(() => rig.installation.handle.release());
      const id = await start(rig, "old Session task");
      await rig.settled(id.runId);
      await rig.pump();
      const baseline = await rig.probe();
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const browsing = await open(rig);
        const callbacks = rig.host.captureCustom();
        assert.ok(callbacks);
        if (view === "history") {
          rig.host.customKey(ENTER);
          await rig.pump();
          rig.host.customKey(ESC);
          await rig.pump();
        }
        await close(rig, browsing);
        const requests = rig.host.customRenderRequests();
        callbacks.handleInput?.(ENTER);
        callbacks.handleInput?.(ESC);
        assert.deepEqual(callbacks.render(100), []);
        assert.equal(rig.host.customRenderRequests(), requests);
        assert.deepEqual(await rig.probe(), baseline);
      }
      const browsing = rig.host.command("subagent", "dashboard");
      if (view === "history") {
        await rig.pump();
        rig.host.customKey(ENTER); // Immediately replace with the history read in flight.
      }
      const callbacks = rig.host.captureCustom();
      assert.ok(callbacks);
      if (replacement) await rig.host.sessionStart();
      else await rig.host.sessionShutdown();
      await browsing;
      assert.equal(rig.host.customOpen(), false);
      assert.equal(rig.host.customDisposals(), 4);
      assert.equal(rig.noLeaks(), true);
      const requests = rig.host.customRenderRequests();
      callbacks.handleInput?.(ENTER);
      assert.deepEqual(callbacks.render(100), []);
      if (!replacement) await rig.host.sessionStart();
      await rig.pump();
      assert.equal(rig.host.customRenderRequests(), requests);
      const fresh = await open(rig);
      assert.match(screen(rig), /No subagents in this session/);
      assert.doesNotMatch(screen(rig), /old Session task/);
      await close(rig, fresh);
    });
  }
}

for (const waiting of [false, true]) {
  test(`dashboard observation leaves ${waiting ? "wait delivery" : "Notification and retrieval"} and Controls unchanged`, async (t) => {
    const results = [];
    for (const browsing of [false, true]) {
      const trace: string[] = [];
      const rig = hostRig(t, {
        trace,
        resumableSteps: [
          [
            emitActivity("working"),
            { step: "await-gate", gate: "finish" },
            emitText("the answer"),
            { step: "complete" },
          ],
        ],
      });
      await rig.host.sessionStart();
      t.after(() => rig.installation.handle.release());
      const work = await start(rig, "observed task");
      await rig.pump();
      const waiter = waiting
        ? rig.text("agent_wait", { ids: [work.runId] })
        : undefined;
      await rig.pump();
      const dashboard = browsing ? await open(rig) : undefined;
      if (dashboard) {
        rig.host.customKey(ENTER);
        await rig.pump();
        for (const key of [ENTER, "r", "c", "s", DOWN, UP])
          rig.host.customKey(key);
      }
      await rig.release("finish");
      await rig.settled(work.runId);
      await rig.pump();
      const waited = await waiter;
      if (dashboard) {
        assert.doesNotMatch(screen(rig), /the answer/); // Active capture stays frozen.
        rig.host.customKey(ESC);
        await rig.pump();
        assert.doesNotMatch(screen(rig), /the answer/); // History carries no output.
        rig.host.customKey(ENTER);
        await rig.pump();
        assert.match(screen(rig), /the answer/); // Reopening reads the terminal Result.
        rig.host.customKey(ESC);
        await rig.pump();
        rig.host.customKey(ESC);
        await rig.pump();
        await close(rig, dashboard);
      }
      const handoff = rig.installation.sink.status(runId(work.runId));
      const counts = rig.installation.sink.counts();
      const notices = rig.host.sent().length;
      const retrieved = await rig.text("agent_result", { id: work.runId });
      assert.match(retrieved, /the answer/);
      assert.equal(
        await rig.text("agent_result", { id: work.runId }),
        retrieved,
      );
      if (waiting) assert.match(waited ?? "", /the answer/);
      else assert.equal(handoff, "pending");
      assert.deepEqual(rig.host.userMessages(), []);
      await rig.probe();
      await rig.host.sessionShutdown();
      assert.equal(rig.noLeaks(), true);
      results.push({
        counts,
        notices,
        handoff,
        counters: rig.resumable.counters(),
        trace: trace.map((event) => event.replaceAll(work.runId, "<Run>")),
      });
    }
    assert.deepEqual(results[1], results[0]);
  });
}

test("run history keeps its entry-time elapsed duration until it is reread", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [{ step: "await-gate", gate: "finish" }, { step: "complete" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig, "timed task");
  await rig.pump();
  await rig.advanceClock(10_000);
  const browsing = await open(rig);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Running.*10\.0s/);

  await rig.release("finish");
  await rig.settled(work.runId);
  await rig.pump();
  await rig.advanceClock(50_000);
  rig.host.customKey(DOWN);
  assert.match(screen(rig), /Running.*10\.0s/);
  assert.doesNotMatch(stripVTControlCharacters(screen(rig)), /1m/); // Not a 256-color escape.

  rig.host.customKey(ESC);
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Completed.*10\.0s/);
  rig.host.customKey(ESC);
  await rig.pump();
  await close(rig, browsing);
});

test("configured selection bindings drive navigation and its displayed hint", async (t) => {
  const rig = hostRig(t, {
    customKeybindings: {
      "tui.select.up": "k",
      "tui.select.down": "j",
    },
    resumableSteps: [[{ step: "hang" }], [{ step: "hang" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await start(rig, "first task");
  await start(rig, "second task");
  await rig.pump();
  const browsing = await open(rig);
  const footer = stripVTControlCharacters(screen(rig)).split("\n").at(-1) ?? "";
  assert.match(footer, /k\/j move/);
  assert.doesNotMatch(footer, /up\/down move/);
  assert.match(screen(rig), /› first task {3}Running/);
  rig.host.customKey("j");
  assert.match(screen(rig), /› second task/);
  rig.host.customKey("k");
  assert.match(screen(rig), /› first task/);
  // The page bindings keep their default keys, and each still means its own
  // direction: what the dashboard reads from a keystroke is every binding it
  // matched, so a page key resolved as its opposite would be read as one.
  rig.host.customKey(PAGE_DOWN);
  assert.match(screen(rig), /› second task/);
  rig.host.customKey(PAGE_UP);
  assert.match(screen(rig), /› first task/);
  await close(rig, browsing);
});

test("activity updates live without reordering, turns and Profile names are absent from compact rows, history is entry-only", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [
        emitActivity("initial activity"),
        { step: "await-gate", gate: "change" },
        emitActivity("changed activity"),
        { step: "cumulative-usage", total: { input: 3, output: 2 } },
        { step: "hang" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await start(rig, "first Label");
  await start(rig, "second Label");
  await rig.pump();
  const baseline = await rig.probe();
  const browsing = await open(rig);
  const before = screen(rig);
  assert.match(before, /initial activity/);
  const requests = rig.host.customRenderRequests();
  await rig.release("change");
  await rig.pump();
  assert.match(screen(rig), /changed activity/);
  assert.equal(rig.host.customRenderRequests(), requests + 1);
  assert.equal(
    (await rig.probe()).repositorySubscriptions,
    baseline.repositorySubscriptions + 1,
  );
  rig.host.customKey(DOWN);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Subagent dashboard · run history · explore/);
  assert.match(screen(rig), /second Label/);
  rig.host.customKey(ESC);
  await rig.pump();
  const after = screen(rig);
  assert.match(after, /changed activity/);
  assert.doesNotMatch(after, /turns?|explore|subagent-/);
  assert.ok(after.indexOf("first Label") < after.indexOf("second Label"));
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Subagent dashboard · run history · explore/);
  assert.match(screen(rig), /second Label/);
  rig.host.customKey(ESC);
  await rig.pump();
  await close(rig, browsing);
});

test("Escape during an entry read closes immediately and late reads cannot redraw", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const browsing = rig.host.command("subagent", "dashboard");
  rig.host.customKey(ESC);
  const requests = rig.host.customRenderRequests();
  await browsing;
  await rig.pump();
  assert.equal(rig.host.customOpen(), false);
  assert.equal(rig.host.customRenderRequests(), requests);
});

test("all three levels retain a full themed surface across resize and invalidation without refreshing snapshots", async (t) => {
  let accent = 36;
  const themed: { color: string; text: string }[] = [];
  const rig = hostRig(t, {
    customTheme: {
      ...PLAIN_THEME,
      fg: (color, text) => {
        themed.push({ color, text: stripVTControlCharacters(text) });
        return `\x1b[${color === "accent" ? accent : 33}m${text}\x1b[39m`;
      },
      bg: (color, text) =>
        `\x1b[${color === "selectedBg" ? 45 : 44}m${text}\x1b[49m`,
      bold: (text) => `\x1b[1m${text}\x1b[22m`,
    },
    resumableSteps: [[emitText("Unicode 界 👩‍💻 é"), { step: "hang" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await start(rig, "任务 👩‍💻 café");
  const browsing = await open(rig);
  for (const title of [
    "Subagent dashboard",
    "Subagent dashboard · run history",
    "Subagent dashboard · run inspection",
  ]) {
    for (const [rows, height] of [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [10, 10],
      [13, 13],
      [24, 24],
    ]) {
      for (const width of [0, 1, 2, 3, 6, 20, 80]) {
        const lines = rig.host.customLines(width, rows);
        assert.equal(lines.length, height);
        assert.ok(lines.every((line) => visibleWidth(line) === width));
        assert.ok(lines.every((line) => line.startsWith("\x1b[49m")));
        assert.ok(lines.every((line) => !line.includes("\ufffd")));
      }
    }
    const before = rig.host.customLines(80, 24);
    const plain = before.map(stripVTControlCharacters).join("\n");
    assert.ok(plain.includes(title));
    assert.match(plain.split("\n").at(-1) ?? "", /up\/down move/);
    assert.doesNotMatch(plain, /[╭╮╰╯│├┤]/);
    assert.match(plain.split("\n").at(-2) ?? "", /^ ─+ $/);
    if (title !== "Subagent dashboard · run inspection") {
      assert.match(plain, /› 任务/);
      assert.match(plain, /任务 👩‍💻 café/);
      const selectedRow = plain
        .split("\n")
        .find((line) => line.includes("› 任务"));
      assert.ok(selectedRow);
      assert.doesNotMatch(selectedRow, /enter/);
      assert.doesNotMatch(selectedRow, /explore|run-|subagent-|Label:/);
      assert.match(plain.split("\n").at(-1) ?? "", /enter (runs|inspect)/);
      if (title === "Subagent dashboard") assert.doesNotMatch(plain, /explore/);
      else
        assert.match(
          plain,
          /Subagent dashboard · run history · explore · newest first/,
        );
      assert.ok(
        before.some((line) => line.includes("\x1b[45m")),
        "selection has a background as well as a marker",
      );
    }
    accent = accent === 36 ? 35 : 36;
    rig.host.captureCustom()?.invalidate();
    const after = rig.host.customLines(80, 24);
    assert.notDeepEqual(after, before);
    assert.deepEqual(
      after.map(stripVTControlCharacters),
      before.map(stripVTControlCharacters),
    );
    if (title !== "Subagent dashboard · run inspection") {
      rig.host.customKey(ENTER);
      await rig.pump();
    }
  }
  assert.ok(
    themed.some(
      ({ color, text }) => color === "warning" && text.trim() === "Running",
    ),
  );
  assert.ok(
    themed.some(
      ({ color, text }) => color === "warning" && text.includes("Running"),
    ),
  );
  assert.ok(
    themed.some(
      ({ color, text }) => color === "warning" && text === "active snapshot",
    ),
  );
  for (let i = 0; i < 2; i += 1) {
    rig.host.customKey(ESC);
    await rig.pump();
  }
  await close(rig, browsing);
});

const ESC = "\x1b";
const ENTER = "\r";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

async function start(rig: HostRig, description: string, agent = "explore") {
  return startedIds(
    await rig.text("agent_start", {
      agent,
      description,
      prompt: "private admission prompt",
    }),
  );
}
async function resume(rig: HostRig, id: string, description: string) {
  const text = await rig.text("agent_resume", {
    id,
    description,
    prompt: "private resumed prompt",
  });
  const runId = /run id (\S+)/.exec(text)?.[1];
  assert.ok(runId, text);
  return runId;
}
async function open(rig: HostRig) {
  const closed = rig.host.command("subagent", "dashboard");
  await rig.pump();
  return { closed };
}
test("overview follows publication rather than numeric ID allocation; failed opens leave no history", async (t) => {
  const rig = hostRig(t, {
    resumableOpen: { open: "hangs", gate: "open" },
    resumableSteps: [[{ step: "hang" }]],
    oneShotSteps: [[{ step: "hang" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const delayed = start(rig, "allocated first");
  await rig.pump();
  const publishedFirst = await start(rig, "published first", "once");
  await rig.release("open");
  const allocatedFirst = await delayed;
  assert.ok(allocatedFirst.subagentId.endsWith("-1"));
  assert.ok(publishedFirst.subagentId.endsWith("-2"));
  const browsing = await open(rig);
  const text = screen(rig);
  assert.ok(text.indexOf("published first") < text.indexOf("allocated first"));
  await close(rig, browsing);

  const refused = hostRig(t, {
    resumableOpen: { open: "fails", reason: "unavailable" },
  });
  await refused.host.sessionStart();
  t.after(() => refused.installation.handle.release());
  await refused.text("agent_start", {
    agent: "explore",
    description: "never published",
    prompt: "try",
  });
  const empty = await open(refused);
  assert.match(screen(refused), /No subagents in this session/);
  await close(refused, empty);
});

const screen = (rig: HostRig) => rig.host.customLines(160, 60).join("\n");
async function close(rig: HostRig, browsing: { closed: Promise<void> }) {
  rig.host.customKey(ESC);
  await browsing.closed;
}

test("runs reuses no-Session response; a live empty Session opens and closes an explicit overview", async (t) => {
  const rig = hostRig(t);
  await rig.host.command("subagent", "dashboard");
  assert.equal(
    rig.host.notices().at(-1)?.message,
    "No subagent Session is running.",
  );
  assert.equal(rig.host.customOpen(), false);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const browsing = rig.host.command("subagent", "dashboard");
  await rig.pump();
  assert.equal(rig.host.customOpen(), true);
  assert.match(
    rig.host.customLines().join("\n"),
    /No subagents in this session/,
  );
  const panel = rig.host.customLines(80, 24).map(stripVTControlCharacters);
  assert.equal(panel.length, 24);
  assert.ok(panel.every((line) => visibleWidth(line) === 80));
  assert.match(panel[0], /^ ██████ {4}Subagent dashboard *$/);
  assert.match(panel[1], /^ ██ {2}██ {4}\/work *$/);
  assert.match(
    panel[2],
    /^ ████ {2}██ {2}0 active · 0 needs attention · 0 completed *$/,
  );
  assert.match(panel[3], /^ ██ {4}██ +$/);
  assert.match(panel[4], /^ +$/);
  assert.match(panel.at(-2) ?? "", /^ ─+ $/);
  assert.doesNotMatch(panel.join("\n"), /[╭╮╰╯│├┤]/);
  assert.match(panel.at(-1) ?? "", /^ escape.*close/);
  assert.ok(panel.some((line) => /^ +$/.test(line)));
  assert.doesNotMatch(panel.join("\n"), /1-1\/1|enter|scroll/);
  rig.host.customKey(ENTER);
  assert.equal(rig.host.customOpen(), true);
  rig.host.customKey(ESC);
  await browsing;
  assert.equal(rig.host.customOpen(), false);
  assert.equal(rig.host.customDisposals(), 1);
  assert.deepEqual(rig.host.sent(), []);
  assert.deepEqual(rig.host.userMessages(), []);
});

test("duplicate Profiles retain resolved terminal history and Resume grouping; latest retry wins and selection follows identity on re-entry", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [{ step: "fail", message: "broken" }],
      [
        { step: "await-gate", gate: "retry" },
        emitText("answer"),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const first = await start(rig, "first task");
  const second = await start(rig, "second task");
  await rig.settled(first.runId, second.runId);
  await rig.pump();
  for (const sent of rig.host.sent())
    await rig.host.messageStart({ role: "custom", ...sent.message });
  await rig.pump();
  assert.equal(rig.host.hasWidget(), false);
  const browsing = await open(rig);
  let text = screen(rig);
  assert.match(text, /Failed/);
  assert.doesNotMatch(text, /Needs attention|idle|explore/);
  assert.ok(text.indexOf("first task") < text.indexOf("second task"));
  for (const id of [first.subagentId, second.subagentId])
    assert.ok(!text.includes(id.replace(/^subagent-/, "")));
  rig.host.customKey(DOWN);
  rig.host.customKey(ENTER);
  await rig.pump();
  text = screen(rig);
  assert.match(text, /Subagent dashboard · run history · explore/);
  assert.match(text, /second task/);
  assert.ok(!text.includes(second.runId));
  assert.doesNotMatch(text, /private admission prompt|broken/);
  const retry = await resume(rig, second.subagentId, "retry task");
  await rig.pump();
  assert.doesNotMatch(screen(rig), /retry task/); // Static until re-entry.
  rig.host.customKey(ESC);
  await rig.pump();
  text = screen(rig);
  assert.ok(text.indexOf("retry task") < text.indexOf("first task"));
  assert.match(text, /› retry task +Running/);
  rig.host.customKey(ENTER);
  await rig.pump();
  text = screen(rig);
  assert.ok(text.indexOf("retry task") < text.indexOf("second task"));
  assert.match(text, /› second task +Failed/); // Old Run-ID selection is retained.
  await rig.release("retry");
  await rig.settled(retry);
  await rig.pump();
  rig.host.customKey(ESC);
  await rig.pump();
  text = screen(rig);
  assert.ok(text.indexOf("first task") < text.indexOf("retry task"));
  assert.match(text, /› retry task +Completed/);
  assert.ok(text.includes("retry task"));
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Failed/);
  assert.match(screen(rig), /Completed/);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Subagent dashboard · run inspection/);
  rig.host.customKey(ESC);
  await rig.pump();
  assert.match(screen(rig), /Subagent dashboard · run history/);
  rig.host.customKey(ESC);
  await rig.pump();
  await close(rig, browsing);
});

for (const reason of ["requested", "timeout"] as const) {
  test(`${reason} cancellation agrees while settling; terminal widget visibility follows hand-off`, async (t) => {
    const rig = hostRig(t, {
      testClock: true,
      policy: {
        ...RIG_POLICY,
        ...(reason === "timeout" ? { defaultRunTimeoutMillis: 100 } : {}),
      },
      resumableSteps: [
        [
          emitActivity("old activity"),
          { step: "gate-the-finalizer", gate: "cleanup" },
          { step: "hang" },
        ],
      ],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig, "cancel task");
    await rig.pump();
    const browsing = await open(rig);
    assert.match(screen(rig), /Running|Finalizing/);
    assert.doesNotMatch(screen(rig), /requested|timeout/);
    if (reason === "requested")
      await rig.text("agent_cancel", { ids: [work.runId] });
    else await rig.advanceClock(100);
    await rig.pump();
    const cancellingDashboard = screen(rig);
    assert.match(cancellingDashboard, /Cancelling +· —/);
    assert.doesNotMatch(cancellingDashboard, /old activity/);
    assert.doesNotMatch(cancellingDashboard, /Needs attention|Completed/);
    const cancellingWidget = rig.host.widgetLines(120);
    assert.match(
      cancellingWidget[1] ?? "",
      /cancel task {2}cancelling · — +\d+\.\ds$/,
    );
    assert.doesNotMatch(cancellingWidget.join("\n"), /old activity/);

    await rig.release("cleanup");
    await rig.pump();
    await rig.settled(work.runId);
    await rig.pump();
    const terminalDashboard = screen(rig);
    assert.match(terminalDashboard, /Cancelled/);
    assert.ok(terminalDashboard.includes(reason));

    // Terminal Runs intentionally collapse into aggregate widget counts, so
    // their reason and tone remain available in dashboard/presentation rows,
    // not in an individual widget row. The aggregate stays only until the
    // completion hand-off lands or the Result is consumed.
    const terminalWidget = rig.host.widgetLines(120);
    assert.deepEqual(terminalWidget, [" subagents   1 cancelled"]);
    assert.doesNotMatch(terminalWidget.join("\n"), /requested|timeout/);
    assert.deepEqual(rig.installation.sink.unlanded(), [work.runId]);

    const [notice] = rig.host.sent();
    assert.ok(notice);
    await rig.host.messageStart({ role: "custom", ...notice.message });
    await rig.pump();
    assert.equal(rig.host.hasWidget(), false);
    assert.deepEqual(rig.host.widgetLines(120), []);
    assert.ok(screen(rig).includes(reason));
    await close(rig, browsing);
  });
}

test("finalizing is Active; delivery failure, Conversation loss, and diagnostics do not turn successful work into Needs attention", async (t) => {
  const rig = hostRig(t, {
    sendFails: () => true,
    resumableSteps: [
      [
        emitActivity("old activity"),
        {
          step: "emit",
          observation: {
            kind: "diagnostic",
            diagnostic: { category: "other", message: "diagnostic text" },
          },
        },
        { step: "lose-conversation" },
        { step: "gate-the-finalizer", gate: "cleanup" },
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig, "successful task");
  await rig.pump();
  const browsing = await open(rig);
  assert.match(screen(rig), /Running|Finalizing/);
  assert.match(screen(rig), /Finalizing/);
  await rig.release("cleanup");
  await rig.settled(work.runId);
  await rig.pump();
  assert.match(
    await rig.text("agent_resume", {
      id: work.subagentId,
      description: "retry",
      prompt: "retry",
    }),
    /Conversation|conversation/,
  );
  assert.match(screen(rig), /Completed/);
  assert.match(screen(rig), /Completed/);
  assert.doesNotMatch(
    screen(rig),
    /Needs attention|diagnostic text|notification/,
  );
  await close(rig, browsing);
});

test("the overview header names the working directory and a live population", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [{ step: "fail", message: "broken" }],
      [{ step: "complete" }],
    ],
    oneShotSteps: [[{ step: "await-gate", gate: "still going" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const failed = await start(rig, "went wrong");
  await rig.settled(failed.runId);
  const retried = await start(rig, "went wrong once");
  await rig.settled(retried.runId);
  await rig.settled(await resume(rig, retried.subagentId, "and then worked"));
  const active = await start(rig, "still going", "once");
  await rig.pump();
  const browsing = await open(rig);
  const header = () =>
    rig.host.customLines(160, 60).map(stripVTControlCharacters);
  assert.match(header()[0], /^ ██████ {4}Subagent dashboard *$/);
  assert.match(header()[1], /^ ██ {2}██ {4}\/work *$/);
  assert.match(
    header()[2],
    /^ ████ {2}██ {2}1 active · 1 needs attention · 1 completed *$/,
  );
  assert.match(header()[3], /^ ██ {4}██ +$/);
  assert.match(header()[4], /^ +$/);
  // The population is the list's own, so settling a Run moves it a category.
  await rig.release("still going");
  await rig.settled(active.runId);
  await rig.pump();
  assert.match(header()[2], /0 active · 1 needs attention · 2 completed/);
  // The mark belongs to the overview; a deeper screen keeps its one-line title.
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(header()[0], /^ Subagent dashboard · run history/);
  assert.doesNotMatch(header().join("\n"), /█/);
  rig.host.customKey(ESC);
  await rig.pump();
  assert.match(header()[0], /^ ██████ {4}Subagent dashboard/);
  await close(rig, browsing);
});
