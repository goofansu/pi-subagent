import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { PushedReport, SubagentDelivery } from "./delivery.ts";
import { createSessionPush, createSubagentDelivery } from "./delivery.ts";
import { REPORT_CHARACTER_LIMIT } from "./presentation.ts";
import { createEmptyResult } from "./run.ts";
import { createSubagentRuns } from "./runs.ts";
import type { SingleResult } from "./types.ts";

function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] } as Message;
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
      result.status = "completed";
      result.exitCode = 0;
      result.finishedAt = 10;
      resolve(result);
    },
    cancel() {
      result.status = "aborted";
      result.exitCode = 1;
      result.stopReason = "aborted";
      result.finishedAt = 10;
      resolve(result);
    },
  };
}

/** Let every queued microtask and immediate run before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness() {
  const reports: PushedReport[] = [];
  // The text that reached the model, which is what most assertions care about.
  const pushed: string[] = [];
  const runs = createSubagentRuns();
  // Pushes land immediately here, as in an idle session. Tests about the
  // pushed-but-not-landed gap build their own delivery with a push that
  // never lands.
  let delivery: SubagentDelivery;
  const push = (report: PushedReport): void => {
    reports.push(report);
    pushed.push(report.text);
    delivery.reportLanded(report.id);
  };
  delivery = createSubagentDelivery({ push, runs });
  return { reports, pushed, runs, delivery };
}

test("an unclaimed run pushes its report when it settles", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();

  delivery.register("run-1", run.settled);
  run.finish("found three call sites");
  await flush();

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /explore \(run-1\) finished/);
  assert.match(pushed[0], /found three call sites/);
});

test("a claimed run returns through the wait and never pushes", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  const waiting = delivery.wait(["run-1"]);
  run.finish("the answer");
  const outcome = await waiting;

  assert.equal(outcome.reports.length, 1);
  assert.match(outcome.reports[0], /the answer/);
  assert.deepEqual(outcome.stillRunning, []);
  assert.deepEqual(pushed, [], "a waited-on run must not also push");
});

test("a wait that times out leaves the run to push on its own", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  const outcome = await delivery.wait(["run-1"], { timeoutMs: 5 });

  assert.deepEqual(outcome.reports, []);
  assert.deepEqual(outcome.stillRunning, ["run-1"]);
  assert.deepEqual(pushed, [], "nothing to report yet");

  run.finish("late answer");
  await flush();

  assert.equal(pushed.length, 1, "the abandoned claim falls back to a push");
  assert.match(pushed[0], /late answer/);
});

test("an abandoned wait releases its claim to the push path", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);
  const controller = new AbortController();

  const waiting = delivery.wait(["run-1"], { signal: controller.signal });
  controller.abort();
  await waiting;

  run.finish();
  await flush();

  assert.equal(pushed.length, 1);
});

test("delivery happens exactly once when a wait and a settle race", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  const waiting = delivery.wait(["run-1"], { timeoutMs: 0 });
  run.finish();
  const outcome = await waiting;
  await flush();

  const deliveries = outcome.reports.length + pushed.length;
  assert.equal(deliveries, 1, "one delivery, whichever path won");
});

test("waiting on several runs returns once all of them settle", async () => {
  const { pushed, delivery } = harness();
  const first = deferredRun("explore");
  const second = deferredRun("reviewer");
  delivery.register("run-1", first.settled);
  delivery.register("run-2", second.settled);

  const waiting = delivery.wait(["run-1", "run-2"]);
  first.finish("first answer");
  second.finish("second answer");
  const outcome = await waiting;

  assert.equal(outcome.reports.length, 2);
  assert.match(outcome.reports[0], /first answer/);
  assert.match(outcome.reports[1], /second answer/);
  assert.deepEqual(pushed, []);
});

test("waiting on an already-delivered run reports nothing rather than failing", async () => {
  const { delivery } = harness();

  const outcome = await delivery.wait(["never-existed"]);

  assert.deepEqual(outcome.reports, []);
  assert.deepEqual(outcome.stillRunning, []);
});

test("a cancelled run pushes a cancellation notice when nobody asked", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  run.cancel();
  await flush();

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /was cancelled/);
});

test("a cancel stops the run and suppresses its push", async () => {
  const { pushed, delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.settled);

  const outcome = delivery.cancel([handle.id]);
  await flush();

  assert.deepEqual(outcome.cancelled, [handle.id]);
  assert.deepEqual(pushed, [], "the tool result already said so");
  assert.equal(delivery.has(handle.id), false);
  assert.equal(runs.size(), 0, "the cancel is the delivery");
});

test("a cancelled run's outcome is still recallable once its child dies", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.settled);

  delivery.cancel([handle.id]);
  await flush();

  assert.deepEqual(delivery.recall(handle.id), {
    id: handle.id,
    agent: "explore",
    status: "aborted",
    output: "",
  });
});

test("a cancelled run's id keeps answering while its child dies", async () => {
  const { pushed, delivery, runs } = harness();
  const run = deferredRun();
  // A child that takes its time dying: the cancel never settles the run.
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.settled);

  delivery.cancel([handle.id]);

  // Between the cancel and the settle the id must not read as a stranger.
  assert.equal(delivery.has(handle.id), true, "still a known run");
  const again = delivery.cancel([handle.id]);
  assert.deepEqual(again.cancelled, [handle.id], "cancelling is idempotent");
  assert.deepEqual(again.unknown, []);
  const outcome = await delivery.wait([handle.id]);
  assert.deepEqual(outcome.alreadyDelivered, [handle.id]);
  assert.deepEqual(outcome.unknown, []);

  run.cancel();
  await flush();
  assert.equal(delivery.recall(handle.id)?.status, "aborted");
  assert.deepEqual(pushed, [], "the cancel stays the only delivery");
});

test("a cancel tells a finished run apart from an id that never existed", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.settled);
  run.finish();
  await flush();

  const outcome = delivery.cancel([handle.id, "never-existed"]);

  assert.deepEqual(outcome.cancelled, []);
  assert.deepEqual(outcome.finished, [handle.id]);
  assert.deepEqual(outcome.unknown, ["never-existed"]);
});

// ── Shutdown ─────────────────────────────────────────────────────────────────

test("shutdown stops what is running and delivers nothing anywhere", async () => {
  const { pushed, delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.settled);

  delivery.shutdown();
  await flush();

  assert.deepEqual(pushed, [], "no notice follows into the next session");
  assert.equal(runs.size(), 0, "the registry starts the next session empty");
  assert.equal(delivery.has(handle.id), false);
  assert.equal(
    delivery.recall(handle.id),
    undefined,
    "a run the session never heard from is not recallable in the next one",
  );
});

test("shutdown clears retention: a report belongs to the session that asked", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  const handle = runs.track(run.result, run.cancel);
  delivery.register(handle.id, run.settled);
  run.finish("the answer");
  await flush();
  assert.ok(delivery.recall(handle.id), "delivered, so recallable");

  delivery.shutdown();

  assert.equal(delivery.recall(handle.id), undefined);
});

test("a pushed report keeps its run listed until the message lands", async () => {
  const runs = createSubagentRuns();
  const pushed: PushedReport[] = [];
  const delivery = createSubagentDelivery({
    push: (report) => pushed.push(report),
    runs,
  });
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.settled);

  // The parent model is mid-turn: pi queues the follow-up, nothing lands.
  run.finish();
  await flush();

  assert.equal(pushed.length, 1, "the report was pushed");
  assert.equal(runs.size(), 1, "done, waiting to report — still listed");

  delivery.reportLanded(handle.id);

  assert.equal(runs.size(), 0, "released when the message entered");
});

test("landing an unknown id changes nothing", () => {
  const { delivery, runs } = harness();

  delivery.reportLanded("never-existed");

  assert.equal(runs.size(), 0);
});

// ── Reports an interrupt threw out of the queue ──────────────────────────────

/** A delivery whose pushes never land on their own, as when pi queues them. */
function queuedHarness() {
  const pushed: PushedReport[] = [];
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: (report) => pushed.push(report),
    runs,
  });
  return { pushed, runs, delivery };
}

test("a report the interrupt discarded is pushed again once the agent settles", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.settled);
  run.finish("the answer");
  await flush();
  assert.equal(pushed.length, 1, "queued behind the model's turn");

  // The operator interrupts: pi clears its queue, the report with it.
  delivery.turnAborted();
  delivery.agentSettled();

  assert.equal(pushed.length, 2, "the discarded report is pushed again");
  assert.equal(pushed[1].text, pushed[0].text, "the same report, verbatim");
  assert.equal(runs.size(), 1, "still listed until the retry lands");

  delivery.reportLanded(handle.id);
  assert.equal(runs.size(), 0);
});

test("a report that landed before the settle is not pushed twice", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.settled);
  run.finish();
  await flush();

  delivery.turnAborted();
  // Pi's continuation drained the surviving queue: the report landed.
  delivery.reportLanded(handle.id);
  delivery.agentSettled();

  assert.equal(pushed.length, 1, "a landed report is never doubled");
});

test("a settle with no preceding abort pushes nothing again", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.settled);
  run.finish();
  await flush();

  delivery.agentSettled();

  assert.equal(pushed.length, 1);
});

test("a report pushed after the abort is left to land on its own", async () => {
  const { pushed, runs, delivery } = queuedHarness();
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.settled);

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
  delivery.register(handle.id, run.settled);
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
  delivery.register(handle.id, run.settled);
  run.finish();
  await flush();

  delivery.turnAborted();
  delivery.shutdown();
  delivery.agentSettled();

  assert.equal(pushed.length, 1, "nothing re-pushes into the next session");
  assert.equal(runs.size(), 0);
});

test("shutdown releases runs whose pushed reports never landed", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({ push: () => {}, runs });
  const run = deferredRun();
  const handle = runs.track(run.result, () => {});
  delivery.register(handle.id, run.settled);
  run.finish();
  await flush();
  assert.equal(runs.size(), 1, "queued behind a session that is ending");

  delivery.shutdown();

  assert.equal(runs.size(), 0);
});

test("a delivered run is released from the registry", async () => {
  const { delivery, runs } = harness();
  const run = deferredRun();
  runs.track(run.result, () => {});
  const [tracked] = runs.list();
  delivery.register(tracked.id, run.settled);

  assert.equal(runs.size(), 1);
  run.finish();
  await flush();

  assert.equal(runs.size(), 0);
});

// ── Retention ────────────────────────────────────────────────────────────────

test("a delivered run's whole output stays readable by id", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  run.finish("the whole answer");
  await flush();

  assert.deepEqual(delivery.recall("run-1"), {
    id: "run-1",
    agent: "explore",
    status: "completed",
    output: "the whole answer",
  });
});

test("retention keeps what the pushed report had to trim", async () => {
  const { reports, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);
  const huge = "x".repeat(REPORT_CHARACTER_LIMIT + 5_000);

  run.finish(huge);
  await flush();

  assert.equal(reports[0].truncated, true);
  assert.ok(reports[0].text.length < huge.length, "the message is capped");
  assert.equal(
    delivery.recall("run-1")?.output,
    huge,
    "the run's whole answer survives the cap",
  );
});

test("a report that fits is not marked as trimmed", async () => {
  const { reports, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  run.finish("short answer");
  await flush();

  assert.equal(reports[0].truncated, false);
});

test("a run collected by a wait is still readable afterwards", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  const waiting = delivery.wait(["run-1"]);
  run.finish("waited answer");
  await waiting;

  assert.equal(delivery.recall("run-1")?.output, "waited answer");
});

test("an unknown id recalls nothing rather than throwing", () => {
  const { delivery } = harness();

  assert.equal(delivery.recall("never-existed"), undefined);
});

test("retention past its budget evicts the oldest output, which still answers", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: () => {},
    runs,
    retentionBudget: 20,
  });
  const first = deferredRun();
  const second = deferredRun("reviewer");
  delivery.register("run-1", first.settled);
  delivery.register("run-2", second.settled);

  first.finish("x".repeat(15));
  await flush();
  second.finish("y".repeat(15));
  await flush();

  assert.deepEqual(delivery.recall("run-1"), {
    id: "run-1",
    agent: "explore",
    status: "completed",
    output: "",
    evicted: true,
  });
  assert.equal(
    delivery.recall("run-2")?.output,
    "y".repeat(15),
    "the newest output survives",
  );
});

test("a single over-budget output survives until something newer lands", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: () => {},
    runs,
    retentionBudget: 20,
  });
  const huge = deferredRun();
  delivery.register("run-1", huge.settled);
  huge.finish("x".repeat(50));
  await flush();

  assert.equal(
    delivery.recall("run-1")?.output,
    "x".repeat(50),
    "the newest entry is never evicted, even alone over budget",
  );

  const next = deferredRun("reviewer");
  delivery.register("run-2", next.settled);
  next.finish("small");
  await flush();

  assert.equal(delivery.recall("run-1")?.evicted, true);
  assert.equal(delivery.recall("run-2")?.output, "small");
});

// ── Id diagnostics ───────────────────────────────────────────────────────────

test("a wait tells a delivered report apart from an id that never existed", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);
  run.finish();
  await flush();

  const outcome = await delivery.wait(["run-1", "never-existed"]);

  assert.deepEqual(outcome.alreadyDelivered, ["run-1"]);
  assert.deepEqual(outcome.unknown, ["never-existed"]);
  assert.deepEqual(outcome.reports, []);
});

test("an id named twice is one claim and one report", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  const waiting = delivery.wait(["run-1", "run-1"]);
  run.finish("the answer");
  const outcome = await waiting;

  assert.equal(outcome.reports.length, 1);
});

test("a timeout past setTimeout's ceiling waits instead of firing at once", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

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
  assert.equal(outcome.reports.length, 1);
});

test("a wait entered with a cancelled turn gives up immediately", async () => {
  const { delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);
  const controller = new AbortController();
  controller.abort();

  const outcome = await delivery.wait(["run-1"], {
    signal: controller.signal,
  });

  assert.deepEqual(outcome.stillRunning, ["run-1"]);
});

// ── A push target that fails ─────────────────────────────────────────────────

test("a throwing push loses neither the process nor the report", async () => {
  const runs = createSubagentRuns();
  const delivery = createSubagentDelivery({
    push: () => {
      throw new Error("session torn down");
    },
    runs,
  });
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  run.finish("survives");
  await flush();

  assert.equal(delivery.recall("run-1")?.output, "survives");
});

// ── The session push ─────────────────────────────────────────────────────────

function report(id: string): PushedReport {
  return {
    id,
    agent: "explore",
    status: "completed",
    text: id,
    truncated: false,
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
