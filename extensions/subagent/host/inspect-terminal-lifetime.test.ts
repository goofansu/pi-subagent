import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Deferred, Effect, Layer } from "effect";
import { runId } from "../domain/index.ts";
import type { SessionRuntimeOptions } from "../runtime/composition.ts";
import { emitText } from "../testing/fakes/script.ts";
import {
  type HostRig,
  hostRig,
  RIG_POLICY,
  startedIds,
} from "../testing/host-rig.ts";

const ENTER = "\r";
const ESC = "\x1b";
const screen = (rig: HostRig) => rig.host.customLines(160, 100).join("\n");
async function start(rig: HostRig, agent = "explore") {
  return startedIds(
    await rig.text("agent_start", {
      agent,
      description: `old ${agent} Label`,
      prompt: "task",
    }),
  );
}
async function history(rig: HostRig) {
  const closed = rig.host.command("subagent", "dashboard");
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  return { closed };
}
async function back(rig: HostRig) {
  rig.host.customKey(ESC);
  await rig.pump();
}

for (const mode of [
  "Notification",
  "agent_result",
  "agent_wait",
  "agent_wait_all",
] as const) {
  test(`equivalent controlled ${mode} schedules with and without terminal inspection preserve delivery and lifecycle`, async (t) => {
    const results = [];
    for (const observing of [false, true]) {
      const trace: string[] = [];
      const rig = hostRig(t, {
        testClock: true,
        trace,
        resumableSteps: [
          [
            { step: "await-gate", gate: "answer" },
            emitText("first answer"),
            { step: "complete" },
          ],
        ],
        oneShotSteps: [
          [
            { step: "await-gate", gate: "other" },
            emitText("second answer"),
            { step: "complete" },
          ],
        ],
      });
      await rig.host.sessionStart();
      t.after(() => rig.installation.handle.release());
      const work = await start(rig);
      const other = await start(rig, "once");
      await rig.pump();
      const waiting = mode === "agent_wait" || mode === "agent_wait_all";
      const wait = waiting
        ? rig.text(
            mode,
            mode === "agent_wait" ? { ids: [work.runId, other.runId] } : {},
          )
        : undefined;
      await rig.pump();
      await rig.release("answer");
      await rig.settled(work.runId);
      await rig.pump();
      // Active work sorts first. Select the terminal Subagent after it.
      const dashboard = observing
        ? { closed: rig.host.command("subagent", "dashboard") }
        : undefined;
      if (dashboard) {
        await rig.pump();
        rig.host.customKey("\x1b[B");
        rig.host.customKey(ENTER);
        await rig.pump();
        rig.host.customKey(ENTER);
        await rig.pump();
        assert.match(screen(rig), /first answer/);
        for (const key of [
          "r",
          "R",
          "s",
          "c",
          ENTER,
          "\x1b[B",
          "\x1b[A",
          "\x1b[C",
          "\x1b[D",
        ])
          rig.host.customKey(key);
      }
      // Reading through the UI must not resolve the held or handed-off notice.
      assert.equal(rig.installation.sink.status(runId(work.runId)), "pending");
      if (!waiting) {
        await rig.host.turnEnd({ stopReason: "aborted" });
        if (mode === "agent_result") {
          const result = await rig.text("agent_result", { id: work.runId });
          assert.match(result, /first answer/);
          assert.equal(
            rig.installation.sink.status(runId(work.runId)),
            "resolved",
          );
          assert.equal(
            await rig.text("agent_result", { id: work.runId }),
            result,
          );
        }
        // A lost Notification re-pushes unless the parent (not UI) consumed it.
        await rig.host.agentSettled();
        const notices = rig.host.sent();
        assert.equal(notices.length, mode === "Notification" ? 2 : 1);
        await rig.host.messageStart({
          role: "custom",
          ...notices.at(-1)?.message,
        });
      } else assert.equal(rig.host.sent().length, 0);
      await rig.release("other");
      await rig.settled(other.runId);
      await rig.pump();
      const waited = await wait;
      if (waiting) {
        assert.match(waited ?? "", /first answer/);
        assert.match(waited ?? "", /second answer/);
        assert.equal(rig.host.sent().length, 0);
        assert.equal(
          rig.installation.sink.status(runId(work.runId)),
          "resolved",
        );
        const repeated = await rig.text("agent_wait", {
          ids: [work.runId, other.runId],
        });
        assert.match(repeated, /first answer/);
        assert.match(repeated, /second answer/);
      }
      if (dashboard) {
        await back(rig);
        await back(rig);
        await back(rig);
        await dashboard.closed;
      }
      assert.deepEqual(rig.host.userMessages(), []);
      const normalize = (value: unknown) =>
        JSON.stringify(value)
          .replaceAll(work.runId, "<first Run>")
          .replaceAll(work.subagentId, "<first Subagent>")
          .replaceAll(other.runId, "<second Run>")
          .replaceAll(other.subagentId, "<second Subagent>");
      results.push(
        normalize({
          notices: rig.host.sent(),
          counts: rig.installation.sink.counts(),
          handoff: rig.installation.sink.status(runId(work.runId)),
          probe: await rig.probe(),
          trace,
          resumable: rig.resumable.counters(),
          oneShot: rig.oneShot.counters(),
        }),
      );
      await rig.host.sessionShutdown();
      assert.equal(rig.noLeaks(), true);
    }
    assert.equal(results[1], results[0]);
  });
}

for (const condition of [
  "exhausted",
  "unannounceable",
  "Conversation loss",
] as const) {
  test(`captured ${condition} appears only in details and never refreshes itself`, async (t) => {
    const rig = hostRig(t, {
      testClock: true,
      sendFails: () => condition === "exhausted",
      ...(condition === "unannounceable"
        ? {
            resultEncoder: () => {
              throw new Error("cannot encode");
            },
          }
        : {}),
      policy: { ...RIG_POLICY, cleanupBudgetMillis: 100 },
      resumableSteps: [
        [
          emitText("answer"),
          ...(condition === "Conversation loss"
            ? [{ step: "gate-the-finalizer" as const, gate: "cleanup" }]
            : []),
          { step: "complete" },
        ],
      ],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig);
    await rig.pump();
    if (condition === "Conversation loss") await rig.advanceClock(101);
    await rig.settled(work.runId);
    await rig.pump();
    const closed = rig.host.command("subagent", "dashboard");
    await rig.pump();
    const overview = screen(rig);
    if (condition !== "unannounceable") {
      assert.match(overview, /Completed/);
      assert.doesNotMatch(overview, /Needs attention/);
    }
    assert.doesNotMatch(
      overview,
      /notification failed|Conversation unavailable|unannounceable/,
    );
    rig.host.customKey(ENTER);
    await rig.pump();
    rig.host.customKey(ENTER);
    await rig.pump();
    const captured = screen(rig);
    assert.match(
      captured,
      condition === "Conversation loss"
        ? /Conversation unavailable for resume/
        : condition === "exhausted"
          ? /notification failed \(exhausted\)/
          : /Completion hand-off: unannounceable/,
    );
    await rig.text("agent_result", { id: work.runId });
    await rig.advanceClock(1000);
    await rig.release("cleanup");
    await rig.pump();
    assert.equal(screen(rig), captured);
    await back(rig);
    await back(rig);
    await back(rig);
    await closed;
    await rig.probe();
    await rig.host.sessionShutdown();
    assert.equal(rig.noLeaks(), true);
  });
}

test("Conversation loss learned by ordinary Resume admission is visible without inspection probing the backend", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [emitText("answer"), { step: "lose-conversation" }, { step: "complete" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig);
  await rig.settled(work.runId);
  await rig.pump();
  const dashboard = await history(rig);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.doesNotMatch(screen(rig), /Conversation unavailable/);
  const response = await rig.text("agent_resume", {
    id: work.subagentId,
    description: "retry",
    prompt: "retry",
  });
  assert.match(response, /conversation lost|Conversation/);
  assert.doesNotMatch(screen(rig), /Conversation unavailable/); // Already captured.
  const controls = rig.resumable.counters();
  await back(rig);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Conversation unavailable for resume/);
  assert.match(screen(rig), /status: +completed/);
  assert.deepEqual(rig.resumable.counters(), controls);
  await back(rig);
  await back(rig);
  await back(rig);
  await dashboard.closed;
});

for (const action of ["close", "shutdown", "replacement"] as const) {
  for (const inFlight of [false, true])
    test(`${action} releases captured content and callbacks${inFlight ? " with a clock-gated read in flight" : " after capture"}`, async (t) => {
      const gate = Effect.runSync(Deferred.make<void>());
      let blockNext = false;
      let reading = 0;
      const native = Effect.runSync(Clock.Clock);
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => native.currentTimeMillisUnsafe(),
        currentTimeNanosUnsafe: () => native.currentTimeNanosUnsafe(),
        monotonicTimeNanosUnsafe: () => native.monotonicTimeNanosUnsafe(),
        currentTimeNanos: native.currentTimeNanos,
        monotonicTimeNanos: native.monotonicTimeNanos,
        sleep: (duration) => native.sleep(duration),
        currentTimeMillis: Effect.suspend(() => {
          if (!blockNext) return native.currentTimeMillis;
          blockNext = false;
          return Effect.acquireUseRelease(
            Effect.sync(() => {
              reading += 1;
            }),
            () =>
              Deferred.await(gate).pipe(
                Effect.andThen(native.currentTimeMillis),
              ),
            () =>
              Effect.sync(() => {
                reading -= 1;
              }),
          );
        }),
      };
      const rig = hostRig(t, {
        clock: Layer.succeed(
          Clock.Clock,
          clock,
        ) as SessionRuntimeOptions["clock"],
      });
      await rig.host.sessionStart();
      t.after(() => rig.installation.handle.release());
      const work = await start(rig);
      await rig.settled(work.runId);
      await rig.pump();
      const baseline = await rig.probe();
      // Repeat ordinary complete captures to expose accumulating UI resources.
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const dashboard = await history(rig);
        rig.host.customKey(ENTER);
        await rig.pump();
        assert.match(screen(rig), /the rig answered/);
        const callbacks = rig.host.captureCustom();
        await back(rig);
        await back(rig);
        await back(rig);
        await dashboard.closed;
        assert.deepEqual(callbacks?.render(100), []);
        assert.deepEqual(await rig.probe(), baseline);
      }
      const dashboard = await history(rig);
      blockNext = inFlight;
      rig.host.customKey(ENTER);
      await rig.pump();
      assert.equal(reading, inFlight ? 1 : 0);
      assert.match(
        screen(rig),
        inFlight ? /Capturing run snapshot/ : /the rig answered/,
      );
      const callbacks = rig.host.captureCustom();
      assert.ok(callbacks);
      if (action === "close") {
        await back(rig);
        await back(rig);
        await back(rig);
      } else if (action === "replacement") await rig.host.sessionStart();
      else await rig.host.sessionShutdown();
      await dashboard.closed;
      await rig.pump();
      assert.equal(
        reading,
        0,
        "disposal must interrupt the blocked read without releasing its gate",
      );
      assert.equal(rig.host.customOpen(), false);
      const requests = rig.host.customRenderRequests();
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      callbacks.handleInput?.(ENTER);
      callbacks.handleInput?.(ESC);
      assert.deepEqual(callbacks.render(100), []);
      await rig.pump();
      assert.equal(rig.host.customRenderRequests(), requests);
      if (action === "close") {
        assert.deepEqual(await rig.probe(), baseline);
        await rig.host.sessionShutdown();
      }
      assert.equal(rig.noLeaks(), true);
      if (action !== "replacement") await rig.host.sessionStart();
      const fresh = rig.host.command("subagent", "dashboard");
      await rig.pump();
      assert.match(screen(rig), /No subagents in this session/);
      assert.doesNotMatch(screen(rig), /old explore Label|the rig answered/);
      await back(rig);
      await fresh;
    });
}
