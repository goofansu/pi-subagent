import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmptyResult, settleResultLifecycle } from "./run.ts";
import type { RegistryClock } from "./runs.ts";
import { createSubagentRuns, TICK_INTERVAL_MS } from "./runs.ts";
import type { SingleResult } from "./types.ts";

interface FakeClock extends RegistryClock {
  advance(ms: number): void;
  /** Run the scheduled callback once, as a real interval would. */
  fire(): void;
  /** How many intervals have ever been started. */
  scheduled(): number;
  /** Whether an interval is currently live. */
  running(): boolean;
  lastIntervalMs(): number;
}

/** A clock the test drives by hand, recording every schedule and cancel. */
function fakeClock(): FakeClock {
  let current = 0;
  let scheduledCount = 0;
  let callback: (() => void) | null = null;
  let intervalMs = 0;

  return {
    now: () => current,
    schedule(fn, ms) {
      scheduledCount++;
      callback = fn;
      intervalMs = ms;
      return () => {
        callback = null;
      };
    },
    advance(ms) {
      current += ms;
    },
    fire() {
      callback?.();
    },
    scheduled: () => scheduledCount,
    running: () => callback !== null,
    lastIntervalMs: () => intervalMs,
  };
}

function sequentialIds(): () => string {
  let n = 0;
  return () => `run-${++n}`;
}

function runningResult(agent = "explore"): SingleResult {
  return createEmptyResult(agent, "look around", 0);
}

test("a tracked run is listed with its identity and elapsed time", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();

  const handle = runs.track(result, () => {});
  clock.advance(2_500);

  assert.equal(handle.id, "run-1");
  assert.deepEqual(runs.list(), [
    {
      id: "run-1",
      agent: "explore",
      description: "look around",
      status: "running",
      elapsedMs: 2_500,
      turns: 0,
      cost: 0,
    },
  ]);
});

test("a settled run stops accruing elapsed time", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});

  clock.advance(1_000);
  result.exitCode = 0;
  settleResultLifecycle(result, clock.now());
  clock.advance(10_000);

  assert.equal(runs.list()[0].status, "completed");
  assert.equal(runs.list()[0].elapsedMs, 1_000);
});

test("the model appears once the child reports one", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});

  assert.equal(runs.list()[0].model, undefined);

  result.model = "openai-codex/gpt-5.6-sol";

  assert.equal(runs.list()[0].model, "openai-codex/gpt-5.6-sol");
});

test("turns count what the child has said", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});

  assert.equal(runs.list()[0].turns, 0);

  result.usage.turns = 3;

  assert.equal(runs.list()[0].turns, 3);
});

test("cost tracks what the run has spent", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const result = runningResult();
  runs.track(result, () => {});

  result.usage.cost = 0.0142;

  assert.equal(runs.list()[0].cost, 0.0142);
});

test("a released run leaves the registry", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  const handle = runs.track(runningResult(), () => {});

  assert.equal(runs.size(), 1);
  runs.release(handle.id);

  assert.equal(runs.size(), 0);
  assert.deepEqual(runs.list(), []);
});

test("releasing an unknown run changes nothing", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  runs.track(runningResult(), () => {});
  let notifications = 0;
  runs.subscribe(() => notifications++);

  runs.release("never-existed");

  assert.equal(runs.size(), 1);
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

test("the tick runs only while a run is unfinished", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();

  assert.equal(clock.running(), false);

  const handle = runs.track(result, () => {});
  assert.equal(clock.running(), true);
  assert.equal(clock.scheduled(), 1);

  // A second run must not start a second interval.
  const other = runs.track(runningResult(), () => {});
  assert.equal(clock.scheduled(), 1);

  result.exitCode = 0;
  settleResultLifecycle(result, clock.now());
  handle.changed();
  assert.equal(clock.running(), true, "the other run is still going");

  runs.release(other.id);
  handle.changed();
  assert.equal(clock.running(), false);
});

test("a tick republishes without any state change", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  let notifications = 0;

  runs.track(runningResult(), () => {});
  runs.subscribe(() => notifications++);

  clock.advance(TICK_INTERVAL_MS);
  clock.fire();

  assert.equal(notifications, 1);
  assert.equal(clock.lastIntervalMs(), TICK_INTERVAL_MS);
});

test("cancelling a run calls its canceller and reports what it stopped", () => {
  const runs = createSubagentRuns(fakeClock(), sequentialIds());
  let cancelled = 0;
  runs.track(runningResult(), () => cancelled++);

  assert.deepEqual(runs.cancel(["run-1"]), ["run-1"]);
  assert.equal(cancelled, 1);
});

test("cancelling an unknown or already-settled run is a no-op", () => {
  const clock = fakeClock();
  const runs = createSubagentRuns(clock, sequentialIds());
  const result = runningResult();
  let cancelled = 0;
  runs.track(result, () => cancelled++);

  result.exitCode = 0;
  settleResultLifecycle(result, clock.now());

  assert.deepEqual(runs.cancel(["run-1", "nonexistent"]), []);
  assert.equal(cancelled, 0);
});
