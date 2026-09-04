import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelledEnding, failedEnding } from "../domain/index.ts";
import {
  FIXTURE_NOW,
  type FixtureResultOptions,
  fixtureNotification,
  fixtureResult,
  fixtureRow,
} from "../testing/presentation-fixtures.ts";
import {
  completionViewOfNotification,
  completionViewOfResult,
  completionViewOfSnapshot,
} from "./completion-view.ts";

/**
 * The three derivations, held to each other.
 *
 * The property is the whole reason the view exists: one Run read from the
 * published snapshot, from its stored Result, and from its completion notice
 * is *the same Run*, and three surfaces that format through these cannot print
 * two durations for it. The last time presentation picked the wrong source, a
 * widget row and a result card disagreed about how long a Run took.
 */

/** One Run, built three ways from the shared fixtures. */
function threeWays(options: FixtureResultOptions = {}) {
  const result = fixtureResult(options);
  return {
    snapshot: completionViewOfSnapshot(
      fixtureRow({ phase: result.status }),
      FIXTURE_NOW,
    ),
    result: completionViewOfResult(result),
    notice: completionViewOfNotification(fixtureNotification(options)),
  };
}

test("one Run derived from the snapshot, the Result and the notice is one value", () => {
  const { snapshot, result, notice } = threeWays({ finalOutput: "done" });

  assert.deepEqual(snapshot, result);
  assert.deepEqual(result, notice);
  assert.deepEqual(result, {
    runId: "run-1",
    subagentId: "subagent-1",
    agent: "explore",
    label: "look around",
    status: "completed",
    durationMillis: 12_400,
  });
});

test("the three agree for a failed and for a cancelled Run too", () => {
  for (const ending of [failedEnding("boom"), cancelledEnding("timeout")]) {
    const { snapshot, result, notice } = threeWays({ ending });
    assert.deepEqual(snapshot, result, ending.ending);
    assert.deepEqual(result, notice, ending.ending);
  }
});

test("a Run that has not settled has no completion to describe", () => {
  // `undefined` rather than a guess: a running row prints `running` and no
  // duration at all, and a view that invented a status would invite one to be
  // printed.
  assert.equal(
    completionViewOfSnapshot(fixtureRow({ phase: "running" }), FIXTURE_NOW),
    undefined,
  );
  assert.equal(
    completionViewOfSnapshot(fixtureRow({ phase: "finalizing" }), FIXTURE_NOW),
    undefined,
  );
});

test("the duration is the Run's, not the draw's", () => {
  // The defect the view exists to prevent: a settled row redrawn a minute
  // later must report what the Run cost, not how long ago it started.
  const later = completionViewOfSnapshot(
    fixtureRow({ phase: "completed" }),
    FIXTURE_NOW + 60_000,
  );

  assert.equal(later?.durationMillis, 12_400);
});
