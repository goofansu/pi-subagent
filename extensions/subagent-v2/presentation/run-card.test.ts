import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelledEnding, failedEnding } from "../domain/index.ts";
import {
  FIXTURE_NOW,
  fixtureResult,
  fixtureRow,
  fixtureUsage,
} from "../testing/presentation-fixtures.ts";
import { runCard, runCardLines } from "./run-card.ts";

test("a live card comes from a snapshot and carries no output", () => {
  const card = runCard({
    from: "live",
    row: fixtureRow({ usage: fixtureUsage({ turns: 3, input: 1_200 }) }),
    now: FIXTURE_NOW,
  });

  assert.deepEqual(card, {
    runId: "run-1",
    subagentId: "subagent-1",
    agent: "explore",
    description: "look around",
    backendId: "pi",
    status: "running",
    tone: "warning",
    accounting: "1.2k in · 3 turns",
  });
  // The published index does not carry output, so a live card cannot claim to.
  assert.equal(card.output, undefined);
});

test("a live card of a finalizing Run says finalizing, not completed", () => {
  const card = runCard({
    from: "live",
    row: fixtureRow({ phase: "finalizing" }),
    now: FIXTURE_NOW,
  });

  assert.equal(card.status, "finalizing");
  assert.equal(card.tone, "warning");
});

test("a terminal card comes from the stored Result and carries the answer", () => {
  const card = runCard({
    from: "result",
    result: fixtureResult({
      finalOutput: "done",
      usage: fixtureUsage({ input: 12_300, output: 4_500, turns: 3 }),
      model: "claude-sonnet-4-6",
    }),
  });

  assert.deepEqual(card, {
    runId: "run-1",
    subagentId: "subagent-1",
    agent: "explore",
    description: "look around",
    backendId: "pi",
    status: "completed in 12.4s",
    tone: "success",
    accounting: "12.3k in / 4.5k out · 3 turns · claude-sonnet-4-6",
    output: "done",
  });
});

test("a terminal card carries the failed and cancelled tones and bodies", () => {
  const failed = runCard({
    from: "result",
    result: fixtureResult({ ending: failedEnding("boom") }),
  });
  const cancelled = runCard({
    from: "result",
    result: fixtureResult({ ending: cancelledEnding("requested") }),
  });

  assert.equal(failed.tone, "error");
  assert.equal(failed.status, "failed after 12.4s");
  assert.match(failed.output ?? "", /^This Run failed before completing\./);
  assert.equal(cancelled.tone, "error");
  assert.equal(cancelled.status, "cancelled after 12.4s");
  assert.match(cancelled.output ?? "", /^The Run was cancelled/);
});

test("a card with nothing to account for omits the accounting line", () => {
  assert.equal(
    runCard({ from: "result", result: fixtureResult({}) }).accounting,
    undefined,
  );
});

test("card lines put identity first and the answer last, with air between", () => {
  assert.deepEqual(
    runCardLines(
      runCard({
        from: "result",
        result: fixtureResult({
          finalOutput: "done",
          usage: fixtureUsage({ turns: 2 }),
        }),
      }),
    ),
    [
      "explore (subagent subagent-1), run run-1",
      "look around · pi · completed in 12.4s",
      "2 turns",
      "",
      "done",
    ],
  );
});

test("a live card's lines stop at the header, because there is no body", () => {
  assert.deepEqual(
    runCardLines(
      runCard({ from: "live", row: fixtureRow({}), now: FIXTURE_NOW }),
    ),
    [
      "explore (subagent subagent-1), run run-1",
      "look around · pi · running",
      "3 turns",
    ],
  );
});
