import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlGate } from "./control-mailbox.ts";
import { createEmptyResult, settleResultLifecycle } from "./run.ts";
import type { RegistryClock } from "./runs.ts";
import { createSubagentRuns } from "./runs.ts";
import type { SingleResult } from "./types.ts";

interface FakeClock extends RegistryClock {
  advance(ms: number): void;
}

/** A clock the test drives by hand. */
function fakeClock(): FakeClock {
  let current = 0;

  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function sequentialIds(): () => string {
  let n = 0;
  return () => `run-${++n}`;
}

function runningResult(agent = "explore"): SingleResult {
  return createEmptyResult(agent, "look around", 0);
}

test("list returns tracked runs in insertion order", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();
  const second = runningResult("reviewer");

  const handle = runs.track(result, () => {});
  const secondHandle = runs.track(second, () => {});
  clock.advance(2_500);

  assert.equal(handle.id, "run-1");
  assert.equal(secondHandle.id, "run-2");
  assert.deepEqual(
    runs.list().map((run) => run.id),
    ["run-1", "run-2"],
  );
  assert.deepEqual(runs.list()[0], {
    id: "run-1",
    agent: "explore",
    harness: "pi",
    description: "look around",
    status: "running",
    elapsedMs: 2_500,
    turns: 0,
  });
});

test("a settled run stops accruing elapsed time", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});

  clock.advance(1_000);
  settleResultLifecycle(result, { ending: "answered" }, clock.now());
  clock.advance(10_000);

  assert.equal(runs.list()[0].status, "completed");
  assert.equal(runs.list()[0].elapsedMs, 1_000);
});

test("turns are projected from folded usage", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});

  result.usage.turns = 2;

  assert.equal(runs.list()[0].turns, 2);
});

test("a released run leaves the registry", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const handle = runs.track(runningResult(), () => {});

  assert.equal(runs.list().length, 1);
  runs.release(handle.id);

  assert.equal(runs.list().length, 0);
  assert.deepEqual(runs.list(), []);
});

test("releasing an unknown run changes nothing", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  runs.track(runningResult(), () => {});
  let notifications = 0;
  runs.subscribe(() => notifications++);

  runs.release("never-existed");

  assert.equal(runs.list().length, 1);
  assert.equal(notifications, 0);
});

test("subscribers hear about tracking, changes and delivery", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  let notifications = 0;
  const unsubscribe = runs.subscribe(() => notifications++);

  const handle = runs.track(runningResult(), () => {});
  handle.changed();
  runs.release(handle.id);

  assert.equal(notifications, 3);

  unsubscribe();
  runs.track(runningResult(), () => {});
  assert.equal(notifications, 3);
});

test("cancelling a run calls its canceller and reports what it stopped", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  let cancelled = 0;
  runs.track(runningResult(), () => cancelled++);

  assert.deepEqual(runs.cancel(["run-1"], "requested"), ["run-1"]);
  assert.equal(cancelled, 1);
});

test("cancellation records its reason and closes Control admission before aborting executor work", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const gate = createControlGate(["steer"]);
  const handle = runs.track(
    runningResult(),
    () => {
      assert.deepEqual(gate.state(), {
        supportedControls: ["steer"],
        closed: true,
        cancellationReason: "requested",
      });
      assert.equal(
        runs.offer(handle.id, { type: "steer", text: "too late" }),
        "not steerable",
      );
    },
    gate,
  );

  assert.equal(
    runs.offer(handle.id, { type: "steer", text: "before cancellation" }),
    "accepted",
  );
  assert.deepEqual(runs.cancel([handle.id], "requested"), [handle.id]);
});

test("settled and unknown Runs refuse Control admission deterministically", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const gate = createControlGate(["steer"]);
  const result = runningResult();
  const handle = runs.track(result, () => {}, gate);

  assert.equal(
    runs.offer("missing", { type: "steer", text: "guidance" }),
    "unknown",
  );
  settleResultLifecycle(result, { ending: "answered" }, clock.now());
  assert.equal(
    runs.offer(handle.id, { type: "steer", text: "too late" }),
    "already completed",
  );
  assert.equal(gate.state().closed, true);
});

test("the first cancellation reason wins across repeated requests", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  let cancelled = 0;
  const handle = runs.track(runningResult(), () => cancelled++);

  assert.deepEqual(runs.cancel([handle.id], "shutdown"), [handle.id]);
  assert.deepEqual(runs.cancel([handle.id], "requested"), []);
  assert.equal(cancelled, 1);
  assert.equal(handle.cancellationReason(), "shutdown");
});

test("cancelRunning stops only running runs without using projections", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  let runningCancelled = 0;
  let settledCancelled = 0;
  runs.track(runningResult("running"), () => runningCancelled++);
  const settled = runningResult("settled");
  runs.track(settled, () => settledCancelled++);
  settleResultLifecycle(settled, { ending: "answered" }, clock.now());

  assert.deepEqual(runs.cancelRunning("shutdown"), ["run-1"]);
  assert.equal(runningCancelled, 1);
  assert.equal(settledCancelled, 0);
});

test("cancelling an unknown or already-settled run is a no-op", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();
  let cancelled = 0;
  runs.track(result, () => cancelled++);
  settleResultLifecycle(result, { ending: "answered" }, clock.now());

  assert.deepEqual(runs.cancel(["run-1", "nonexistent"], "requested"), []);
  assert.equal(cancelled, 0);
});

// ── Robustness ───────────────────────────────────────────────────────────────

test("one broken listener silences neither the change nor the others", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  let laterListenerHeard = 0;
  runs.subscribe(() => {
    throw new Error("a stale widget");
  });
  runs.subscribe(() => laterListenerHeard++);

  assert.doesNotThrow(() => runs.track(runningResult(), () => {}));
  assert.equal(laterListenerHeard, 1);
});

test("INV-1: run ids are stable and never reused within a session", () => {
  const drawn = ["dup", "dup", "fresh"];
  const runs = createSubagentRuns(fakeClock(), () => {
    const next = drawn.shift();
    assert.ok(next, "ran out of ids");
    return next;
  });

  const first = runs.track(runningResult(), () => {});
  runs.release(first.id);
  const second = runs.track(runningResult(), () => {});

  assert.equal(first.id, "dup");
  assert.equal(second.id, "fresh");
  assert.equal(runs.list().length, 1);
});

test("live activity takes precedence over folded activity and settles quiet", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});
  result.activity = "grep: TODO";
  result.liveActivity = "Reading files";

  assert.equal(runs.list()[0].activity, "Reading files");
  delete result.liveActivity;
  assert.equal(runs.list()[0].activity, "grep: TODO");

  settleResultLifecycle(result, { ending: "answered" }, clock.now());
  assert.equal(result.liveActivity, undefined);
  assert.equal(runs.list()[0].activity, undefined);
});

test("a run's recorded activity is projected, and nothing else is derived", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});

  assert.equal(runs.list()[0].activity, undefined);

  // The dispatcher's fold records activity on the run; the registry projects
  // the field without looking inside the transcript.
  result.activity = "grep: TODO";
  result.liveActivity = "Thinking…";
  assert.equal(runs.list()[0].activity, "Thinking…");

  delete result.liveActivity;
  assert.equal(runs.list()[0].activity, "grep: TODO");
});
