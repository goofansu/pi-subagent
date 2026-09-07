import assert from "node:assert/strict";
import { test } from "node:test";
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

test("both lists scroll and clamp after resize, retain selected identities, and clip Unicode Labels safely", async (t) => {
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
  assert.doesNotMatch(rig.host.customLines(80, 10).join("\n"), /任务11/);
  rig.host.customKey("\x1b[6~");
  assert.match(rig.host.customLines(80, 10).join("\n"), /任务3/);
  rig.host.customKey("\x1b[5~");
  assert.match(rig.host.customLines(80, 10).join("\n"), /任务0/);
  for (let i = 0; i < 11; i += 1) rig.host.customKey(DOWN);
  assert.match(rig.host.customLines(80, 10).join("\n"), /任务11/);
  for (const width of [0, 1, 2, 8, 20, 40, 80]) {
    const lines = rig.host.customLines(width, 10);
    assert.ok(lines.length <= 8);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !line.includes("\ufffd")));
  }
  assert.match(rig.host.customLines(20, 10).join("\n"), /任务11/);
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
    /> explore {2}completed/,
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
      const browsing = rig.host.command("subagent", "runs");
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
      assert.match(screen(rig), /No Subagents in this Session/);
      assert.doesNotMatch(screen(rig), /old Session task/);
      await close(rig, fresh);
    });
  }
}

for (const waiting of [false, true]) {
  test(`browser observation leaves ${waiting ? "wait delivery" : "Notification and retrieval"} and Controls unchanged`, async (t) => {
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
      const browser = browsing ? await open(rig) : undefined;
      if (browser) {
        rig.host.customKey(ENTER);
        await rig.pump();
        for (const key of [ENTER, "r", "c", "s", DOWN, UP])
          rig.host.customKey(key);
      }
      await rig.release("finish");
      await rig.settled(work.runId);
      await rig.pump();
      const waited = await waiter;
      if (browser) {
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
        await close(rig, browser);
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

test("activity and Turns update live without reordering; history remains entry-only", async (t) => {
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
  const second = await start(rig, "second Label");
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
  assert.ok(screen(rig).includes(second.subagentId));
  rig.host.customKey(ESC);
  await rig.pump();
  const after = screen(rig);
  assert.match(after, /changed activity/);
  assert.match(after, /1 turn/);
  assert.ok(after.indexOf("first Label") < after.indexOf("second Label"));
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.ok(screen(rig).includes(second.subagentId));
  rig.host.customKey(ESC);
  await rig.pump();
  await close(rig, browsing);
});

test("Escape during an entry read closes immediately and late reads cannot redraw", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const browsing = rig.host.command("subagent", "runs");
  rig.host.customKey(ESC);
  const requests = rig.host.customRenderRequests();
  await browsing;
  await rig.pump();
  assert.equal(rig.host.customOpen(), false);
  assert.equal(rig.host.customRenderRequests(), requests);
});

const ESC = "\x1b";
const ENTER = "\r";
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
  const closed = rig.host.command("subagent", "runs");
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
  assert.match(screen(refused), /No Subagents in this Session/);
  await close(refused, empty);
});

const screen = (rig: HostRig) => rig.host.customLines(160, 60).join("\n");
async function close(rig: HostRig, browsing: { closed: Promise<void> }) {
  rig.host.customKey(ESC);
  await browsing.closed;
}

test("runs reuses no-Session response; a live empty Session opens and closes an explicit overview", async (t) => {
  const rig = hostRig(t);
  await rig.host.command("subagent", "runs");
  assert.equal(
    rig.host.notices().at(-1)?.message,
    "No subagent Session is running.",
  );
  assert.equal(rig.host.customOpen(), false);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const browsing = rig.host.command("subagent", "runs");
  await rig.pump();
  assert.equal(rig.host.customOpen(), true);
  assert.match(
    rig.host.customLines().join("\n"),
    /No Subagents in this Session/,
  );
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
  assert.match(text, /Needs attention/);
  assert.match(text, /idle · failed/);
  assert.ok(text.indexOf("first task") < text.indexOf("second task"));
  for (const id of [first.subagentId, second.subagentId])
    assert.ok(text.includes(id.replace(/^subagent-/, "")));
  rig.host.customKey(DOWN);
  rig.host.customKey(ENTER);
  await rig.pump();
  text = screen(rig);
  assert.ok(text.includes(second.subagentId));
  assert.ok(text.includes(second.runId));
  assert.doesNotMatch(text, /private admission prompt|broken/);
  const retry = await resume(rig, second.subagentId, "retry task");
  await rig.pump();
  assert.doesNotMatch(screen(rig), /retry task/); // Static until re-entry.
  rig.host.customKey(ESC);
  await rig.pump();
  text = screen(rig);
  assert.ok(text.indexOf("Active") < text.indexOf("Needs attention"));
  assert.match(text, /> explore {2}running · running/);
  rig.host.customKey(ENTER);
  await rig.pump();
  text = screen(rig);
  assert.ok(text.indexOf(retry) < text.indexOf(second.runId));
  assert.match(text, /> explore {2}failed/); // Old Run-ID selection is retained.
  await rig.release("retry");
  await rig.settled(retry);
  await rig.pump();
  rig.host.customKey(ESC);
  await rig.pump();
  text = screen(rig);
  assert.ok(text.indexOf("Needs attention") < text.indexOf("Completed"));
  assert.match(text, /> explore {2}idle · completed/);
  assert.ok(text.includes("retry task"));
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /failed/);
  assert.match(screen(rig), /completed/);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Run inspection/);
  rig.host.customKey(ESC);
  await rig.pump();
  assert.match(screen(rig), /Run history/);
  rig.host.customKey(ESC);
  await rig.pump();
  await close(rig, browsing);
});

for (const reason of ["requested", "timeout"] as const) {
  test(`${reason} cancellation stays Active through settling and shows the recorded reason at terminality`, async (t) => {
    const rig = hostRig(t, {
      testClock: true,
      policy: {
        ...RIG_POLICY,
        ...(reason === "timeout" ? { defaultRunTimeoutMillis: 100 } : {}),
      },
      resumableSteps: [
        [{ step: "gate-the-finalizer", gate: "cleanup" }, { step: "hang" }],
      ],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig, "cancel task");
    await rig.pump();
    const browsing = await open(rig);
    assert.match(screen(rig), /Active/);
    assert.doesNotMatch(screen(rig), /requested|timeout/);
    if (reason === "requested")
      await rig.text("agent_cancel", { ids: [work.runId] });
    else await rig.advanceClock(100);
    await rig.pump();
    assert.match(screen(rig), /Active/);
    assert.doesNotMatch(screen(rig), /Needs attention|Completed/);
    assert.ok(screen(rig).includes(`(${reason})`));
    await rig.release("cleanup");
    await rig.pump();
    await rig.settled(work.runId);
    await rig.pump();
    assert.match(
      screen(rig),
      reason === "timeout" ? /Needs attention/ : /Completed/,
    );
    assert.ok(screen(rig).includes(`cancelled (${reason})`));
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
  assert.match(screen(rig), /Active/);
  assert.match(screen(rig), /running · finalizing/);
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
  assert.match(screen(rig), /idle · completed/);
  assert.doesNotMatch(
    screen(rig),
    /Needs attention|diagnostic text|notification/,
  );
  await close(rig, browsing);
});
