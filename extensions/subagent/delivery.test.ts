import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlGate } from "./control-source.ts";
import type {
  DeliveryOptions,
  PushedNotification,
  SubagentDelivery,
} from "./delivery.ts";
import {
  createSubagentDelivery as createProductionDelivery,
  createSessionPush,
} from "./delivery.ts";
import { NOTIFICATION_PREVIEW_CHARACTER_LIMIT } from "./presentation.ts";
import type { Fact } from "./run.ts";
import { createEmptyResult } from "./run.ts";
import { createSubagentRuns } from "./runs.ts";
import type { SingleResult } from "./types.ts";

type TestDelivery = Omit<SubagentDelivery, "register"> & {
  register(
    id: string,
    agent: string,
    settled: Promise<SingleResult>,
    subagentId?: string,
  ): void;
};

/** Keep direct delivery tests concise while production registration requires an owner. */
function createSubagentDelivery(options: DeliveryOptions): TestDelivery {
  const delivery = createProductionDelivery(options);
  return {
    ...delivery,
    register(id, agent, settled, subagentId = "subagent-test") {
      delivery.register(id, agent, settled, subagentId);
    },
  };
}

function assistantText(text: string): Fact {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

/** A run the test settles by hand. */
function deferredRun(agent = "explore"): {
  result: SingleResult;
  settled: Promise<SingleResult>;
  finish(output?: string): void;
  cancel(): void;
} {
  const result = createEmptyResult(agent, "look around", 0);
  let resolve: (value: SingleResult) => void = () => {};
  const settled = new Promise<SingleResult>((r) => {
    resolve = r;
  });
  return {
    result,
    settled,
    finish(output = "the answer") {
      result.messages.push(assistantText(output));
      result.lifecycle = { phase: "completed", finishedAt: 10 };
      resolve(result);
    },
    cancel() {
      result.lifecycle = {
        phase: "cancelled",
        finishedAt: 10,
        reason: "requested",
      };
      resolve(result);
    },
  };
}

/** Let every queued microtask and immediate run before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness() {
  const reports: PushedNotification[] = [];
  // The text that reached the model, which is what most assertions care about.
  const pushed: string[] = [];
  const runs = createSubagentRuns();
  // Pushes land immediately here, as in an idle session. Tests about the
  // pushed-but-not-landed gap build their own delivery with a push that
  // never lands.
  let delivery: TestDelivery;
  const push = (report: PushedNotification): void => {
    reports.push(report);
    pushed.push(report.text);
    delivery.notificationLanded(report.id);
  };
  delivery = createSubagentDelivery({ push, runs });
  return { reports, pushed, runs, delivery };
}

test("an unobserved run pushes its notification when it settles", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);
  run.finish("found three call sites");
  await flush();
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /explore \(subagent-test\), run run-1 completed/);
});

test("INV-5: wait observes terminality without suppressing notification", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);
  const waiting = delivery.wait(["run-1"]);
  run.finish("the answer");
  const outcome = await waiting;
  await flush();
  assert.deepEqual(outcome.terminal, [
    { id: "run-1", agent: "explore", phase: "completed" },
  ]);
  assert.equal(pushed.length, 1);
  assert.doesNotMatch(JSON.stringify(outcome), /the answer/);
});

test("INV-5: wait is repeatable for an already-terminal run", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);
  run.finish();
  await flush();
  assert.deepEqual(
    await delivery.wait(["run-1"]),
    await delivery.wait(["run-1"]),
  );
});

test("INV-5: timeout and unknown ids are the only special wait cases", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);
  assert.deepEqual(
    await delivery.wait(["run-1", "missing"], { timeoutMs: 0 }),
    {
      terminal: [],
      stillRunning: ["run-1"],
      unknown: ["missing"],
    },
  );
});

test("a cancelled run pushes a cancellation notice when nobody asked", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);

  run.cancel();
  await flush();

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /was cancelled/);
});

test("a cancel stops the run without suppressing its notification", async () => {
  const { pushed, delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.result.agent, run.settled);

  const outcome = delivery.cancel([handle.id]);
  await flush();

  assert.deepEqual(outcome.cancelled, [handle.id]);
  assert.equal(pushed.length, 1);
  assert.equal(
    delivery.has(handle.id),
    true,
    "the stored result remains known",
  );
  assert.equal(
    runs.list().length,
    0,
    "the landed notification releases the run",
  );
});

test("notification state is committed before a push can re-enter", async () => {
  const runs = createSubagentRuns();
  let delivery: TestDelivery;
  const push = (notification: PushedNotification): void => {
    // The host may synchronously report the message as landed while push is
    // still on the stack. Swapping delivery's state write below this call
    // would leave the run listed forever.
    delivery.notificationLanded(notification.id);
  };
  delivery = createSubagentDelivery({ push, runs });
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);

  run.finish();
  await flush();

  assert.equal(runs.list().length, 0);
});

test("a cancelled run's outcome is still recallable once its child dies", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.result.agent, run.settled);

  delivery.cancel([handle.id]);
  await flush();

  assert.deepEqual(delivery.result(handle.id), {
    id: handle.id,
    subagentId: "subagent-test",
    agent: "explore",
    status: "cancelled",
    reason: "requested",
    output: "The run was cancelled before producing output.",
  });
});

test("INV-6: repeated cancellation is safe and terminal state is unchanged", async () => {
  const { pushed, delivery, runs } = harness();
  const run = deferredRun();
  // A child that takes its time dying: the cancel never settles the run.
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);

  delivery.cancel([handle.id]);

  // Between the cancel and the settle the id must not read as a stranger.
  assert.equal(delivery.has(handle.id), true, "still a known run");
  const again = delivery.cancel([handle.id]);
  assert.deepEqual(again.cancelled, []);
  assert.deepEqual(again.alreadySettling, [handle.id]);
  assert.deepEqual(again.unknown, []);
  const outcome = await delivery.wait([handle.id], { timeoutMs: 0 });
  assert.deepEqual(outcome.stillRunning, [handle.id]);
  assert.deepEqual(outcome.unknown, []);

  run.cancel();
  await flush();
  assert.equal(delivery.result(handle.id)?.status, "cancelled");
  assert.equal(pushed.length, 1, "cancellation still produces a notification");
});

test("a cancel tells a finished run apart from an id that never existed", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish();
  await flush();

  const outcome = delivery.cancel([handle.id, "never-existed"]);

  assert.deepEqual(outcome.cancelled, []);
  assert.deepEqual(outcome.alreadySettling, []);
  assert.deepEqual(outcome.finished, [handle.id]);
  assert.deepEqual(outcome.unknown, ["never-existed"]);
});

test("steering validates before Run lookup and preserves admitted text exactly", async () => {
  const { delivery, runs } = harness();

  assert.equal(delivery.steer("missing", " \n\t"), "invalid");
  assert.equal(delivery.steer("missing", "🙂".repeat(4_097)), "invalid");
  assert.equal(delivery.steer("missing", "guidance"), "unknown run");

  const run = deferredRun();
  const gate = createControlGate(["steer"]);
  const handle = runs.track(run.result, run.cancel, gate);
  delivery.register(handle.id, run.result.agent, run.settled);
  let admission:
    | Parameters<Parameters<typeof gate.controls.subscribe>[0]>[0]
    | undefined;
  gate.controls.subscribe((next) => {
    admission = next;
  });
  const exact = "  preserve\nthis text \t";

  assert.equal(delivery.steer(handle.id, exact), "accepted");
  assert.deepEqual(admission?.control, { type: "steer", text: exact });
  admission?.acknowledge();
});

test("steering outcomes follow settled, cancelling, unsupported, and backpressure precedence", async () => {
  const { delivery, runs } = harness();

  const unsupported = deferredRun();
  const unsupportedHandle = runs.track(
    unsupported.result,
    unsupported.cancel,
    createControlGate([]),
  );
  delivery.register(
    unsupportedHandle.id,
    unsupported.result.agent,
    unsupported.settled,
  );
  assert.equal(delivery.steer(unsupportedHandle.id, "guidance"), "unsupported");

  const full = deferredRun();
  const fullHandle = runs.track(
    full.result,
    full.cancel,
    createControlGate(["steer"]),
  );
  delivery.register(fullHandle.id, full.result.agent, full.settled);
  for (let index = 0; index < 16; index++) {
    assert.equal(delivery.steer(fullHandle.id, "guidance"), "accepted");
  }
  assert.equal(delivery.steer(fullHandle.id, "guidance"), "queue full");

  const cancelling = deferredRun();
  const cancellingHandle = runs.track(
    cancelling.result,
    () => {},
    createControlGate(["steer"]),
  );
  delivery.register(
    cancellingHandle.id,
    cancelling.result.agent,
    cancelling.settled,
  );
  delivery.cancel([cancellingHandle.id]);
  assert.equal(
    delivery.steer(cancellingHandle.id, "guidance"),
    "not steerable",
  );

  unsupported.finish();
  await flush();
  assert.equal(
    delivery.steer(unsupportedHandle.id, "guidance"),
    "already completed",
  );

  const cancelled = deferredRun();
  const cancelledHandle = runs.track(cancelled.result, cancelled.cancel);
  delivery.register(
    cancelledHandle.id,
    cancelled.result.agent,
    cancelled.settled,
  );
  cancelled.cancel();
  await flush();
  assert.equal(
    delivery.steer(cancelledHandle.id, "guidance"),
    "already cancelled",
  );

  const failed = createEmptyResult("reviewer", "task", 0);
  failed.lifecycle = { phase: "failed", finishedAt: 10 };
  delivery.register("failed-run", failed.agent, Promise.resolve(failed));
  await flush();
  assert.equal(delivery.steer("failed-run", "guidance"), "already failed");
});

test("terminal Run identity remains steer-classifiable until Session shutdown clears it", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel, createControlGate([]));
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish();
  await flush();

  assert.equal(runs.list().length, 0);
  assert.equal(delivery.steer(handle.id, "late guidance"), "already completed");

  delivery.shutdown();
  assert.equal(delivery.steer(handle.id, "late guidance"), "unknown run");
});

// ── Shutdown ─────────────────────────────────────────────────────────────────

test("shutdown stops what is running and delivers nothing anywhere", async () => {
  const { pushed, delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.result.agent, run.settled);

  delivery.shutdown();
  await flush();

  assert.deepEqual(pushed, [], "no notice follows into the next session");
  assert.equal(
    runs.list().length,
    0,
    "the registry starts the next session empty",
  );
  assert.equal(delivery.has(handle.id), false);
  assert.equal(
    delivery.result(handle.id),
    undefined,
    "a run the session never heard from is not recallable in the next one",
  );
});

test("Session shutdown closes a controlled Run source without waiting for queued Controls", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const gate = createControlGate(["steer"]);
  const handle = runs.track(run.result, () => {}, gate);
  delivery.register(handle.id, run.result.agent, run.settled);
  assert.equal(delivery.steer(handle.id, "discard on shutdown"), "accepted");

  delivery.shutdown();

  let closed = false;
  gate.controls.subscribe(
    () => assert.fail("shutdown delivered a discarded Control"),
    () => {
      closed = true;
    },
  );
  assert.equal(closed, true);
  assert.equal(delivery.steer(handle.id, "after shutdown"), "unknown run");
});

test("shutdown clears retention: a report belongs to the session that asked", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish("the answer");
  await flush();
  assert.ok(delivery.result(handle.id), "delivered, so recallable");

  delivery.shutdown();

  assert.equal(delivery.result(handle.id), undefined);
});

test("a pushed report keeps its run listed until the message lands", async () => {
  const runs = createSubagentRuns();
  const pushed: PushedNotification[] = [];
  const delivery = createSubagentDelivery({
    push: (report) => pushed.push(report),
    runs,
  });
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);

  // The parent model is mid-turn: pi queues the follow-up, nothing lands.
  run.finish();
  await flush();

  assert.equal(pushed.length, 1, "the report was pushed");
  assert.equal(runs.list().length, 1, "done, waiting to report — still listed");

  delivery.notificationLanded(handle.id);

  assert.equal(runs.list().length, 0, "released when the message entered");
});

test("landing an unknown id changes nothing", () => {
  const { delivery, runs } = harness();

  delivery.notificationLanded("never-existed");

  assert.equal(runs.list().length, 0);
});

// ── Reports an interrupt threw out of the queue ──────────────────────────────

/** A delivery whose pushes never land on their own, as when pi queues them. */
function queuedHarness() {
  const pushed: PushedNotification[] = [];
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: (report) => pushed.push(report),
    runs,
  });
  return { pushed, runs, delivery };
}

test("INV-9: an interrupt-discarded follow-up is pushed again after settle", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish("the answer");
  await flush();
  assert.equal(pushed.length, 1, "queued behind the model's turn");

  // The operator interrupts: pi clears its queue, the report with it.
  delivery.turnAborted();
  delivery.agentSettled();

  assert.equal(pushed.length, 2, "the discarded report is pushed again");
  assert.equal(pushed[1].text, pushed[0].text, "the same report, verbatim");
  assert.equal(runs.list().length, 1, "still listed until the retry lands");

  delivery.notificationLanded(handle.id);
  assert.equal(runs.list().length, 0);
});

test("one landing per run: re-push never double-delivers", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish();
  await flush();

  delivery.turnAborted();
  // Pi's continuation drained the surviving queue: the report landed.
  delivery.notificationLanded(handle.id);
  delivery.agentSettled();

  assert.equal(pushed.length, 1, "a landed report is never doubled");
});

test("a settle with no preceding abort pushes nothing again", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish();
  await flush();

  delivery.agentSettled();

  assert.equal(pushed.length, 1);
});

test("a report pushed after the abort is left to land on its own", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);

  // The abort precedes the push: this report was never in the cleared queue.
  delivery.turnAborted();
  run.finish();
  await flush();
  delivery.agentSettled();

  assert.equal(pushed.length, 1, "pi's own draining will land it");
});

test("a retry the interrupt discards again is pushed once more", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish();
  await flush();

  delivery.turnAborted();
  delivery.agentSettled();
  delivery.turnAborted();
  delivery.agentSettled();

  assert.equal(pushed.length, 3, "the report keeps trying until it lands");
});

test("shutdown forgets what an abort snapshotted", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish();
  await flush();

  delivery.turnAborted();
  delivery.shutdown();
  delivery.agentSettled();

  assert.equal(pushed.length, 1, "nothing re-pushes into the next session");
  assert.equal(runs.list().length, 0);
});

test("shutdown releases runs whose pushed reports never landed", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({ push: () => {}, runs });
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.result.agent, run.settled);
  run.finish();
  await flush();
  assert.equal(runs.list().length, 1, "queued behind a session that is ending");

  delivery.shutdown();

  assert.equal(runs.list().length, 0);
});

test("a delivered run is released from the registry", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  runs.track(run.result, () => {});
  const [tracked] = runs.list();
  delivery.register(tracked.id, run.result.agent, run.settled);

  assert.equal(runs.list().length, 1);
  run.finish();
  await flush();

  assert.equal(runs.list().length, 0);
});

// ── Retention ────────────────────────────────────────────────────────────────

test("INV-4: a stored result is durable and repeatable", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);

  run.finish("the whole answer");
  await flush();

  const expected = {
    id: "run-1",
    subagentId: "subagent-test",
    agent: "explore",
    status: "completed" as const,
    output: "the whole answer",
  };
  assert.deepEqual(delivery.result("run-1"), expected);
  assert.deepEqual(delivery.result("run-1"), expected);
});

test("retention keeps what the pushed report had to trim", async () => {
  const { reports, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);
  const huge = "x".repeat(NOTIFICATION_PREVIEW_CHARACTER_LIMIT + 5_000);

  run.finish(huge);
  await flush();
  assert.ok(reports[0].text.length < huge.length, "the message is capped");
  assert.equal(
    delivery.result("run-1")?.output,
    huge,
    "the run's whole answer survives the cap",
  );
});

test("a run collected by a wait is still readable afterwards", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);

  const waiting = delivery.wait(["run-1"]);
  run.finish("waited answer");
  await waiting;

  assert.equal(delivery.result("run-1")?.output, "waited answer");
});

test("an unknown id recalls nothing rather than throwing", () => {
  const { delivery } = harness();

  assert.equal(delivery.result("never-existed"), undefined);
});

test("INV-4: result-store eviction follows insertion order, not retrieval order", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: () => {},
    runs,
    resultBudget: 20,
  });
  const first = deferredRun();
  const second = deferredRun("reviewer");
  delivery.register("run-1", first.result.agent, first.settled);
  delivery.register("run-2", second.result.agent, second.settled);

  first.finish("x".repeat(15));
  await flush();
  assert.equal(delivery.result("run-1")?.output, "x".repeat(15));
  assert.equal(delivery.result("run-1")?.output, "x".repeat(15));

  second.finish("y".repeat(15));
  await flush();

  assert.deepEqual(delivery.result("run-1"), {
    id: "run-1",
    subagentId: "subagent-test",
    agent: "explore",
    status: "completed",
    output: "",
    evicted: true,
  });
  assert.equal(
    delivery.result("run-2")?.output,
    "y".repeat(15),
    "the newest output survives",
  );
});

test("a single over-budget output survives until something newer lands", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: () => {},
    runs,
    resultBudget: 20,
  });
  const huge = deferredRun();
  delivery.register("run-1", huge.result.agent, huge.settled);
  huge.finish("x".repeat(50));
  await flush();

  assert.equal(
    delivery.result("run-1")?.output,
    "x".repeat(50),
    "the newest entry is never evicted, even alone over budget",
  );

  const next = deferredRun("reviewer");
  delivery.register("run-2", next.result.agent, next.settled);
  next.finish("small");
  await flush();

  assert.equal(delivery.result("run-1")?.evicted, true);
  assert.equal(delivery.result("run-2")?.output, "small");
});

// ── Id diagnostics ───────────────────────────────────────────────────────────

test("a wait tells a delivered report apart from an id that never existed", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);
  run.finish();
  await flush();

  const outcome = await delivery.wait(["run-1", "never-existed"]);

  assert.deepEqual(
    outcome.terminal.map((run) => run.id),
    ["run-1"],
  );
  assert.deepEqual(outcome.unknown, ["never-existed"]);
});

test("an id named twice produces one wait observation", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);

  const waiting = delivery.wait(["run-1", "run-1"]);
  run.finish("the answer");
  const outcome = await waiting;

  assert.equal(outcome.terminal.length, 1);
});

test("a timeout past setTimeout's ceiling waits instead of firing at once", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);

  // Un-clamped, a delay past 2^31-1 ms fires after one millisecond and the
  // wait would give up while the run was still going.
  const waiting = delivery.wait(["run-1"], { timeoutMs: 2 ** 32 });
  const winner = await Promise.race([
    waiting.then(() => "gave up"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
  ]);
  assert.equal(winner, "still waiting");

  run.finish("patient answer");
  const outcome = await waiting;
  assert.equal(outcome.terminal.length, 1);
});

test("a wait entered with a cancelled turn gives up immediately", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);
  const controller = new AbortController();
  controller.abort();

  const outcome = await delivery.wait(["run-1"], {
    signal: controller.signal,
  });

  assert.deepEqual(outcome.stillRunning, ["run-1"]);
});

// ── A push target that fails ─────────────────────────────────────────────────

test("an unexpected executor rejection remains observable by wait and retrievable", async () => {
  const { delivery, pushed } = harness();
  delivery.register(
    "run-1",
    "explore",
    Promise.reject(new Error("executor bug")),
  );
  await flush();

  assert.deepEqual((await delivery.wait(["run-1"])).terminal, [
    { id: "run-1", agent: "explore", phase: "failed" },
  ]);
  assert.match(delivery.result("run-1")?.output ?? "", /executor bug/);
  assert.match(
    pushed[0] ?? "",
    /Subagent explore \(subagent-test\), run run-1 failed: executor bug/,
  );
});

test("INV-9: notification failure cannot invalidate the stored result", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: () => {
      throw new Error("session torn down");
    },
    runs,
  });
  const run = deferredRun();
  delivery.register("run-1", run.result.agent, run.settled);

  run.finish("survives");
  await flush();

  assert.equal(delivery.result("run-1")?.output, "survives");
});

// ── The session push ─────────────────────────────────────────────────────────

function report(id: string): PushedNotification {
  return {
    id,
    subagentId: "subagent-test",
    agent: "explore",
    status: "completed",
    text: id,
  };
}

test("a report with no session bound is dropped, not queued for the next one", () => {
  const sessionPush = createSessionPush();
  const delivered: string[] = [];

  sessionPush.push(report("orphan"));

  sessionPush.bind((pushed) => delivered.push(pushed.id));
  assert.deepEqual(delivered, [], "the orphan belongs to no conversation");

  sessionPush.push(report("current"));
  assert.deepEqual(delivered, ["current"]);
});

test("a session that went stale drops the report instead of crashing", () => {
  const sessionPush = createSessionPush();
  const delivered: string[] = [];

  sessionPush.bind(() => {
    throw new Error("this extension ctx is stale");
  });
  assert.doesNotThrow(() => sessionPush.push(report("orphan")));

  sessionPush.bind((pushed) => delivered.push(pushed.id));
  sessionPush.push(report("current"));
  assert.deepEqual(delivered, ["current"], "the orphan never resurfaces");
});

test("unbinding drops what settles between sessions", () => {
  const sessionPush = createSessionPush();
  const delivered: string[] = [];
  sessionPush.bind((pushed) => delivered.push(pushed.id));

  sessionPush.unbind();
  sessionPush.push(report("between"));

  sessionPush.bind((pushed) => delivered.push(pushed.id));
  assert.deepEqual(delivered, [], "nothing crosses the session divide");
});
