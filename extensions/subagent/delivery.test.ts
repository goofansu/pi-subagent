import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { PushedReport } from "./delivery.ts";
import {
  createSubagentDelivery,
  FAILURE_REASON_LIMIT,
  formatReport,
  REPORT_CHARACTER_LIMIT,
} from "./delivery.ts";
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
  const delivery = createSubagentDelivery({
    push: (report) => {
      reports.push(report);
      pushed.push(report.text);
    },
    runs,
  });
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

test("deliverInline suppresses the push for runs the model cancelled itself", async () => {
  const { pushed, delivery } = harness();
  const run = deferredRun();
  delivery.register("run-1", run.settled);

  delivery.deliverInline(["run-1"]);
  run.cancel();
  await flush();

  assert.deepEqual(pushed, [], "the tool result already said so");
  assert.equal(delivery.has("run-1"), false);
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

// ── Report shape ─────────────────────────────────────────────────────────────

test("a report carries the final output and names the run", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("three call sites"));
  result.status = "completed";

  const report = formatReport("a1b2c3d4", result);

  assert.match(report, /^Subagent explore \(a1b2c3d4\) finished:/);
  assert.match(report, /three call sites/);
});

test("a thorough report passes through whole", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("x".repeat(10_000)));
  result.status = "completed";

  const report = formatReport("a1b2c3d4", result);

  assert.match(report, /x{10000}/, "a real answer is never cut");
  assert.doesNotMatch(report, /incomplete/);
});

test("a runaway report is cut, and says how much went missing", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.messages.push(assistantText("x".repeat(REPORT_CHARACTER_LIMIT + 500)));
  result.status = "completed";

  const report = formatReport("a1b2c3d4", result);

  assert.match(report, /500 more characters dropped/);
  assert.match(report, /this report is incomplete/);
});

test("a failure reason keeps its tail, where the diagnosis is", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.status = "failed";
  result.stderr = `${"noise\n".repeat(2_000)}FATAL: the actual cause`;

  const report = formatReport("a1", result);

  assert.match(report, /FATAL: the actual cause$/);
  assert.match(report, /earlier characters dropped/);
  assert.ok(report.length < FAILURE_REASON_LIMIT + 200);
});

test("a failed report names the reason", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.status = "failed";
  result.errorMessage = "model refused";

  assert.match(formatReport("a1", result), /failed: model refused/);
});

test("a finished run with no output says so rather than looking empty", () => {
  const result = createEmptyResult("explore", "look", 0);
  result.status = "completed";

  assert.match(formatReport("a1", result), /finished without output/);
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
