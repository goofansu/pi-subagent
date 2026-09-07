import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Deferred, Effect, Layer } from "effect";
import { inspectRun } from "../application/observation.ts";
import { runId } from "../domain/index.ts";
import type { SessionRuntimeOptions } from "../runtime/composition.ts";
import { ResultStore } from "../runtime/result-store.ts";
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
      description: "active Label",
      prompt: "task",
    }),
  );
}
async function key(rig: HostRig, input: string) {
  rig.host.customKey(input);
  await rig.pump();
}

for (const mode of [
  "Notification",
  "agent_result",
  "agent_wait",
  "agent_wait_all",
] as const)
  test(`active capture/refresh does not interfere with controlled ${mode}, steering and cancellation schedules`, async (t) => {
    const outcomes = [];
    for (const observing of [false, true]) {
      const trace: string[] = [];
      const rig = hostRig(t, {
        testClock: true,
        trace,
        resumableSteps: [
          [
            emitText("first"),
            { step: "await-control", confirm: true },
            { step: "await-gate", gate: "answer" },
            emitText("answer"),
            { step: "complete" },
          ],
        ],
        oneShotSteps: [[emitText("partial"), { step: "hang" }]],
      });
      await rig.host.sessionStart();
      t.after(() => rig.installation.handle.release());
      const work = await start(rig);
      const other = await start(rig, "once");
      await rig.pump();
      const dashboard = observing
        ? rig.host.command("subagent", "dashboard")
        : undefined;
      if (dashboard) {
        await rig.pump();
        await key(rig, ENTER);
        await key(rig, ENTER);
        assert.match(screen(rig), /active snapshot/);
        for (const input of ["R", "r", "c", "s", ENTER, "\x1b[C", "\x1b[D"])
          await key(rig, input);
        assert.equal((await rig.probe()).unresolvedWaiters, 0);
        assert.equal(rig.host.sent().length, 0);
      }
      // Only the ordinary tool sends this Control, not any inspector key.
      const steer = await rig.text("agent_steer", {
        id: work.runId,
        message: "real guidance",
      });
      const waiting = mode === "agent_wait" || mode === "agent_wait_all";
      const wait = waiting
        ? rig.text(
            mode,
            mode === "agent_wait" ? { ids: [work.runId, other.runId] } : {},
          )
        : undefined;
      await rig.pump();
      if (dashboard) {
        await key(rig, "R");
        assert.match(screen(rig), /real guidance/);
      }
      await rig.release("answer");
      await rig.settled(work.runId);
      await rig.pump();
      const pinsBefore = await rig.installation.handle.run(
        Effect.flatMap(ResultStore, (store) => store.pinsOf(runId(work.runId))),
        [],
      );
      if (dashboard) {
        assert.match(screen(rig), /active snapshot/);
        await key(rig, "R");
        assert.match(screen(rig), /terminal snapshot/);
        assert.match(screen(rig), /answer/);
      }
      assert.deepEqual(
        await rig.installation.handle.run(
          Effect.flatMap(ResultStore, (store) =>
            store.pinsOf(runId(work.runId)),
          ),
          [],
        ),
        pinsBefore,
      );
      assert.equal(rig.installation.sink.status(runId(work.runId)), "pending");
      if (!waiting) {
        await rig.host.turnEnd({ stopReason: "aborted" });
        if (mode === "agent_result")
          assert.match(
            await rig.text("agent_result", { id: work.runId }),
            /answer/,
          );
        await rig.host.agentSettled();
        assert.equal(rig.host.sent().length, mode === "Notification" ? 2 : 1);
        await rig.host.messageStart({
          role: "custom",
          ...rig.host.sent().at(-1)?.message,
        });
      } else assert.equal(rig.host.sent().length, 0);
      await rig.text("agent_cancel", { ids: [other.runId] });
      await rig.settled(other.runId);
      await rig.pump();
      const waited = await wait;
      if (waiting) {
        assert.match(waited ?? "", /answer/);
        assert.match(waited ?? "", /partial/);
        assert.equal(rig.host.sent().length, 0);
      }
      if (dashboard) {
        for (let i = 0; i < 3; i += 1) await key(rig, ESC);
        await dashboard;
      }
      assert.deepEqual(rig.host.userMessages(), []);
      const result = await rig.installation.handle.run(
        inspectRun(runId(work.runId)),
        undefined,
      );
      const normalize = (value: unknown) =>
        JSON.stringify(value)
          .replaceAll(work.runId, "<Run>")
          .replaceAll(work.subagentId, "<Subagent>")
          .replaceAll(other.runId, "<other Run>")
          .replaceAll(other.subagentId, "<other Subagent>");
      outcomes.push(
        normalize({
          steer,
          trace,
          notices: rig.host.sent(),
          counts: rig.installation.sink.counts(),
          probe: await rig.probe(),
          backend: rig.resumable.counters(),
          other: rig.oneShot.counters(),
          result,
        }),
      );
      await rig.host.sessionShutdown();
      assert.equal(rig.noLeaks(), true);
    }
    assert.equal(outcomes[1], outcomes[0]);
  });

for (const action of ["back", "close", "shutdown", "replacement"] as const)
  for (const depth of [
    "overview",
    "history",
    "active",
    "read",
    "refresh",
  ] as const)
    test(`${action} releases active dashboard resources at ${depth} depth, including pending captures`, async (t) => {
      const gate = Effect.runSync(Deferred.make<void>());
      const native = Effect.runSync(Clock.Clock);
      let blockNext = false;
      let reading = 0;
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
        resumableSteps: [[emitText("old active content"), { step: "hang" }]],
      });
      await rig.host.sessionStart();
      t.after(() => rig.installation.handle.release());
      await start(rig);
      await rig.pump();
      const baseline = await rig.probe();
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const dashboard = rig.host.command("subagent", "dashboard");
        await rig.pump();
        await key(rig, ENTER);
        await key(rig, ENTER);
        await key(rig, "R");
        assert.match(screen(rig), /old active content/);
        const stale = rig.host.captureCustom();
        for (let i = 0; i < 3; i += 1) await key(rig, ESC);
        await dashboard;
        assert.deepEqual(stale?.render(100), []);
        assert.deepEqual(await rig.probe(), baseline);
      }
      const dashboard = rig.host.command("subagent", "dashboard");
      await rig.pump();
      if (depth !== "overview") await key(rig, ENTER);
      if (["active", "read", "refresh"].includes(depth)) {
        blockNext = depth === "read";
        await key(rig, ENTER);
        if (depth === "refresh") {
          blockNext = true;
          await key(rig, "R");
        }
      }
      assert.equal(reading, depth === "read" || depth === "refresh" ? 1 : 0);
      const stale = rig.host.captureCustom();
      assert.ok(stale);
      if (action === "shutdown") await rig.host.sessionShutdown();
      else if (action === "replacement") await rig.host.sessionStart();
      else {
        await key(rig, ESC);
        if (action === "back") {
          assert.equal(
            reading,
            0,
            "leaving capture must interrupt a pending read even while dashboard stays open",
          );
          assert.equal(
            (await rig.probe()).repositorySubscriptions,
            baseline.repositorySubscriptions + (depth === "history" ? 1 : 0),
          );
        }
        while (rig.host.customOpen()) await key(rig, ESC);
      }
      await dashboard;
      await rig.pump();
      assert.equal(reading, 0);
      const requests = rig.host.customRenderRequests();
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      stale.handleInput?.("R");
      stale.handleInput?.(ENTER);
      assert.deepEqual(stale.render(100), []);
      await rig.pump();
      assert.equal(rig.host.customRenderRequests(), requests);
      if (action === "close" || action === "back") {
        assert.deepEqual(await rig.probe(), baseline);
        await rig.host.sessionShutdown();
      }
      assert.equal(rig.noLeaks(), true);
      if (action !== "replacement") await rig.host.sessionStart();
      const fresh = rig.host.command("subagent", "dashboard");
      await rig.pump();
      assert.match(screen(rig), /No subagents in this session/);
      assert.doesNotMatch(screen(rig), /old active content/);
      await key(rig, ESC);
      await fresh;
    });

for (const expire of [false, true])
  test(`settlement ${expire ? "and eviction " : ""}during a host refresh is resolved by the capture query`, async (t) => {
    const gate = Effect.runSync(Deferred.make<void>());
    const native = Effect.runSync(Clock.Clock);
    let blockNext = false;
    let reading = false;
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
        reading = true;
        return Deferred.await(gate).pipe(
          Effect.andThen(native.currentTimeMillis),
        );
      }),
    };
    const rig = hostRig(t, {
      clock: Layer.succeed(
        Clock.Clock,
        clock,
      ) as SessionRuntimeOptions["clock"],
      policy: { ...RIG_POLICY, maxResultBytes: 4096, resultStoreBytes: 4096 },
      resumableSteps: [
        [
          emitText("streamed content"),
          { step: "await-gate", gate: "finish" },
          {
            step: "complete",
            reconciliation: { finalOutput: "authoritative answer" },
          },
        ],
      ],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig);
    await rig.pump();
    const dashboard = rig.host.command("subagent", "dashboard");
    await rig.pump();
    await key(rig, ENTER);
    await key(rig, ENTER);
    assert.match(screen(rig), /streamed content/);
    blockNext = true;
    await key(rig, "R");
    assert.equal(reading, true);
    assert.match(screen(rig), /Capturing run snapshot/);
    await rig.release("finish");
    await rig.settled(work.runId);
    await rig.pump();
    if (expire) {
      const other = await start(rig, "once");
      await rig.settled(other.runId);
      await rig.pump();
    }
    assert.match(screen(rig), /Capturing run snapshot/);
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await rig.pump();
    const terminal = screen(rig);
    assert.match(terminal, /Run status: completed/);
    assert.match(
      terminal,
      expire ? /Result expired: output is gone/ : /authoritative answer/,
    );
    assert.doesNotMatch(terminal, /r refresh/);
    for (let i = 0; i < 3; i += 1) await key(rig, ESC);
    await dashboard;
    await rig.probe();
    await rig.host.sessionShutdown();
    assert.equal(rig.noLeaks(), true);
  });
