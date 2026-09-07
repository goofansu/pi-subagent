import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelledEnding, failedEnding } from "../domain/index.ts";
import {
  type FixtureResultOptions,
  fixtureNotification,
  fixtureResult,
} from "../testing/presentation-fixtures.ts";
import {
  completionViewOfNotification,
  completionViewOfResult,
} from "./completion-view.ts";

/**
 * The two derivations, held to each other.
 *
 * The property is the whole reason the view exists: one Run read from its
 * stored Result and from its completion notice is *the same Run*, and two
 * surfaces that format through these cannot print two durations for it. The
 * last time presentation picked the wrong source, a widget row and a result
 * card disagreed about how long a Run took.
 *
 * The published row was a third derivation here until duration got one rule.
 * The row now reads `runElapsedMillis` directly, which is where that defect is
 * guarded against for every surface rather than for the three that happened to
 * share this view; `status.test.ts` holds the rule itself.
 */

/** One Run, built both ways from the shared fixtures. */
function bothWays(options: FixtureResultOptions = {}) {
  return {
    result: completionViewOfResult(fixtureResult(options)),
    notice: completionViewOfNotification(fixtureNotification(options)),
  };
}

test("one Run derived from the Result and from the notice is one value", () => {
  const { result, notice } = bothWays({ finalOutput: "done" });

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

test("the two agree for a failed and for a cancelled Run too", () => {
  for (const ending of [failedEnding("boom"), cancelledEnding("timeout")]) {
    const { result, notice } = bothWays({ ending });
    assert.deepEqual(result, notice, ending.ending);
  }
});
