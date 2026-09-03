import assert from "node:assert/strict";
import { test } from "node:test";
import { answeredEnding, cancelledEnding, failedEnding } from "./endings.ts";
import { backendId, runId, subagentId } from "./ids.ts";
import type { RunObservation } from "./observations.ts";
import {
  createRunProjection,
  DEFAULT_PROJECTION_BOUNDS,
  type ProjectionBounds,
  type RunProjection,
} from "./projection.ts";
import { reconcileRun } from "./reconcile-run.ts";
import type { TerminalReconciliation } from "./reconciliation.ts";
import { reduceRun } from "./reduce-run.ts";
import { toRunResult } from "./result.ts";
import {
  type ContextGauge,
  contextGauge,
  EMPTY_USAGE_SNAPSHOT,
  usageDelta,
} from "./usage.ts";

function fold(
  observations: readonly RunObservation[],
  bounds: ProjectionBounds = DEFAULT_PROJECTION_BOUNDS,
): RunProjection {
  let projection = createRunProjection();
  for (const observation of observations) {
    projection = reduceRun(projection, observation, bounds).projection;
  }
  return projection;
}

const assistant = (text: string): RunObservation => ({
  kind: "message",
  role: "assistant",
  parts: [{ kind: "text", text }],
});

/** A Run that streamed a bit of everything, so drift has somewhere to hide. */
function streamed(): RunProjection {
  return fold([
    assistant("a partial answer"),
    {
      kind: "message",
      role: "assistant",
      parts: [{ kind: "tool_call", name: "grep", callId: "c1" }],
    },
    {
      kind: "usage",
      usage: usageDelta({ input: 10, output: 20, turns: 2, cost: 1 }),
    },
    { kind: "context", context: contextGauge(1_000, 200_000) },
    { kind: "model", model: "model-a" },
  ]);
}

test("applying a reconciliation twice is the same as applying it once", () => {
  const reconciliation: TerminalReconciliation = {
    transcript: [
      { role: "assistant", parts: [{ kind: "text", text: "healed" }] },
    ],
    finalOutput: "healed",
    usage: { input: 12, output: 21 },
    context: contextGauge(1_100),
    turns: 3,
    model: "model-b",
  };
  const once = reconcileRun(streamed(), reconciliation).projection;

  const twice = reconcileRun(once, reconciliation).projection;

  assert.deepEqual(twice, once);
});

test("replaying a reconciliation that truncated is still idempotent", () => {
  const tight: ProjectionBounds = {
    ...DEFAULT_PROJECTION_BOUNDS,
    maxTranscriptItems: 1,
  };
  const reconciliation: TerminalReconciliation = {
    transcript: [
      { role: "assistant", parts: [{ kind: "text", text: "one" }] },
      { role: "assistant", parts: [{ kind: "text", text: "two" }] },
      { role: "assistant", parts: [{ kind: "text", text: "three" }] },
    ],
  };

  const once = reconcileRun(streamed(), reconciliation, tight).projection;
  const twice = reconcileRun(once, reconciliation, tight).projection;

  assert.equal(once.truncation.droppedTranscriptItems, 2);
  assert.deepEqual(twice, once);
});

test("a present transcript replaces and an absent one retains", () => {
  const before = streamed();
  const replacement = [
    {
      role: "assistant" as const,
      parts: [{ kind: "text" as const, text: "healed" }],
    },
  ];

  assert.deepEqual(
    reconcileRun(before, { transcript: replacement }).projection.transcript,
    replacement,
  );
  assert.deepEqual(
    reconcileRun(before, {}).projection.transcript,
    before.transcript,
  );
});

test("a present final output replaces and an absent one retains", () => {
  const before = streamed();

  assert.equal(
    reconcileRun(before, { finalOutput: "the real answer" }).projection
      .finalOutput,
    "the real answer",
  );
  assert.equal(
    reconcileRun(before, {}).projection.finalOutput,
    before.finalOutput,
  );
});

test("present usage totals replace field by field and absent ones retain", () => {
  const before = streamed();

  const healed = reconcileRun(before, { usage: { input: 12 } }).projection;

  assert.deepEqual(healed.usage.totals, {
    input: 12,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 1,
  });
  assert.deepEqual(reconcileRun(before, {}).projection.usage, before.usage);
});

test("reconciled usage replaces rather than adds, so drift never double counts", () => {
  const before = streamed();

  const healed = reconcileRun(before, {
    usage: { input: 11, output: 22, cost: 1.5 },
  }).projection;

  assert.equal(healed.usage.totals.input, 11);
  assert.notEqual(healed.usage.totals.input, before.usage.totals.input + 11);
});

test("a present gauge replaces and an absent one leaves the streamed gauge", () => {
  const before = streamed();

  assert.deepEqual(
    reconcileRun(before, { context: contextGauge(2_500) }).projection.usage
      .context,
    { tokens: 2_500 },
  );
  // A gauge never resets to zero because a snapshot did not mention it.
  assert.deepEqual(reconcileRun(before, {}).projection.usage.context, {
    tokens: 1_000,
    window: 200_000,
  });
});

test("a present turn count raises and an absent one retains", () => {
  const before = streamed();

  assert.equal(reconcileRun(before, { turns: 5 }).projection.usage.turns, 5);
  assert.equal(reconcileRun(before, {}).projection.usage.turns, 2);
});

test("a turn count lower than what was observed is ignored", () => {
  const before = streamed();

  assert.equal(reconcileRun(before, { turns: 1 }).projection.usage.turns, 2);
  assert.equal(reconcileRun(before, { turns: 0 }).projection.usage.turns, 2);
});

test("an unusable turn count is ignored rather than erasing progress", () => {
  const before = streamed();

  for (const turns of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      reconcileRun(before, { turns }).projection.usage.turns,
      2,
      String(turns),
    );
  }
});

test("a present model replaces and an absent one retains", () => {
  const before = streamed();

  assert.equal(
    reconcileRun(before, { model: "model-b" }).projection.model,
    "model-b",
  );
  assert.equal(reconcileRun(before, {}).projection.model, "model-a");
});

test("an empty reconciliation changes nothing at all", () => {
  const before = streamed();

  const outcome = reconcileRun(before, {});

  assert.deepEqual(outcome.projection, before);
  assert.deepEqual(outcome.dropped, []);
});

test("reconciliation does not settle the Run; the ending that follows does", () => {
  const before = streamed();

  const reconciled = reconcileRun(before, { finalOutput: "healed" }).projection;

  assert.equal(reconciled.terminal, false);
  assert.equal(
    reduceRun(reconciled, { kind: "ending", ending: answeredEnding() })
      .projection.terminal,
    true,
  );
});

test("a backend with no snapshot leaves its streamed projection authoritative", () => {
  const before = streamed();

  const settled = reduceRun(before, {
    kind: "ending",
    ending: answeredEnding(),
  }).projection;

  assert.equal(settled.finalOutput, "a partial answer");
  assert.deepEqual(settled.usage.totals, {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 1,
  });
});

test("a tool left running is marked when the ending is applied after healing", () => {
  const reconciled = reconcileRun(streamed(), {
    finalOutput: "healed",
  }).projection;

  const settled = reduceRun(reconciled, {
    kind: "ending",
    ending: cancelledEnding("requested"),
  }).projection;

  assert.deepEqual(
    settled.tools.map((entry) => entry.status),
    ["cancelled"],
  );
});

test("a Run with no observations settles as a valid cancelled or failed Run", () => {
  const identity = {
    runId: runId("run-1"),
    subagentId: subagentId("subagent-1"),
    backendId: backendId("fake"),
    agent: "reviewer",
    description: "review",
  };

  for (const ending of [cancelledEnding("requested"), failedEnding()]) {
    const reconciled = reconcileRun(createRunProjection(), {}).projection;
    const settled = reduceRun(reconciled, {
      kind: "ending",
      ending,
    }).projection;
    const result = toRunResult({
      identity,
      projection: settled,
      ending,
      startedAt: 1,
      settledAt: 2,
    });

    assert.equal(result.finalOutput, "");
    assert.deepEqual(result.transcript, []);
    assert.deepEqual(result.usage, EMPTY_USAGE_SNAPSHOT);
    assert.equal(
      result.status,
      ending.ending === "failed" ? "failed" : "cancelled",
    );
  }
});

test("an unusable gauge is ignored without discarding the rest of the snapshot", () => {
  const before = streamed();

  // A snapshot the domain cannot read one field of must still heal the fields
  // it can: rejecting the whole reconciliation would throw away the transcript,
  // the output, and the usage it also carried.
  const healed = reconcileRun(before, {
    finalOutput: "the real answer",
    usage: { input: 12 },
    context: { tokens: -1 } as ContextGauge,
  }).projection;

  assert.equal(healed.finalOutput, "the real answer");
  assert.equal(healed.usage.totals.input, 12);
  assert.deepEqual(healed.usage.context, { tokens: 1_000, window: 200_000 });
});

test("an unusable gauge does not make the reconciliation observation invalid", () => {
  const before = streamed();

  const step = reduceRun(before, {
    kind: "reconciliation",
    reconciliation: {
      finalOutput: "the real answer",
      context: { tokens: Number.NaN } as ContextGauge,
    },
  });

  assert.equal(step.report.report, "applied");
  assert.equal(step.projection.finalOutput, "the real answer");
  assert.deepEqual(step.projection.usage.context, {
    tokens: 1_000,
    window: 200_000,
  });
});
