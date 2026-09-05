import assert from "node:assert/strict";
import { test } from "node:test";
import { DIAGNOSTIC_MESSAGE_MAX_BYTES, runDiagnostic } from "./diagnostics.ts";
import { answeredEnding, cancelledEnding, failedEnding } from "./endings.ts";
import { backendId, runId, subagentId } from "./ids.ts";
import type { RunObservation } from "./observations.ts";
import {
  createRunProjection,
  DEFAULT_PROJECTION_BOUNDS,
  type ProjectionBounds,
  type RunProjection,
} from "./projection.ts";
import {
  RECONCILED_FIELDS,
  reconcileRun,
  reconciliationDifference,
} from "./reconcile-run.ts";
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

/* ---- what the snapshot changed ---- */

test("a snapshot that restates everything streamed reports no change", () => {
  const before = streamed();

  const outcome = reconcileRun(before, {
    transcript: before.transcript,
    finalOutput: before.finalOutput,
    usage: before.usage.totals,
    context: before.usage.context,
    turns: before.usage.turns,
    model: before.model,
  });

  assert.deepEqual(outcome.changed, []);
  assert.deepEqual(outcome.projection, before);
});

test("an empty snapshot reports no change", () => {
  assert.deepEqual(reconcileRun(streamed(), {}).changed, []);
});

test("each field is reported changed on its own", () => {
  const before = streamed();
  const cases: readonly (readonly [TerminalReconciliation, string])[] = [
    [
      {
        transcript: [
          { role: "assistant", parts: [{ kind: "text", text: "healed" }] },
        ],
      },
      "transcript",
    ],
    [{ finalOutput: "the real answer" }, "finalOutput"],
    [{ usage: { input: 12 } }, "usage"],
    [{ context: contextGauge(2_500) }, "context"],
    [{ turns: 5 }, "turns"],
    [{ model: "model-b" }, "model"],
  ];

  for (const [reconciliation, field] of cases) {
    assert.deepEqual(reconcileRun(before, reconciliation).changed, [field]);
  }
});

test("the change set is reported in a stable order", () => {
  const before = streamed();

  const outcome = reconcileRun(before, {
    model: "model-b",
    turns: 5,
    context: contextGauge(2_500),
    usage: { input: 12 },
    finalOutput: "the real answer",
    transcript: [
      { role: "assistant", parts: [{ kind: "text", text: "healed" }] },
    ],
  });

  assert.deepEqual(outcome.changed, [
    "transcript",
    "finalOutput",
    "usage",
    "context",
    "turns",
    "model",
  ]);
});

test("replaying a reconciliation over its own result reports no change", () => {
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
  const once = reconcileRun(streamed(), reconciliation);

  const twice = reconcileRun(once.projection, reconciliation);

  assert.deepEqual(once.changed, [
    "transcript",
    "finalOutput",
    "usage",
    "context",
    "turns",
    "model",
  ]);
  assert.deepEqual(twice.changed, []);
});

test("re-truncating identical content is not a change", () => {
  const tight: ProjectionBounds = {
    ...DEFAULT_PROJECTION_BOUNDS,
    maxTranscriptItems: 1,
  };
  const before = fold(
    [assistant("one"), assistant("two"), assistant("three")],
    tight,
  );
  assert.equal(before.truncation.droppedTranscriptItems, 2);

  // The same three items again: bounding keeps the same one item, so the
  // transcript the projection ends up holding is the one it already held.
  const outcome = reconcileRun(
    before,
    {
      transcript: [
        { role: "assistant", parts: [{ kind: "text", text: "one" }] },
        { role: "assistant", parts: [{ kind: "text", text: "two" }] },
        { role: "assistant", parts: [{ kind: "text", text: "three" }] },
      ],
    },
    tight,
  );

  assert.deepEqual(outcome.projection.transcript, before.transcript);
  assert.deepEqual(outcome.changed, []);
});

test("an unusable gauge and an unlifted turn count are not reported changed", () => {
  const before = streamed();

  assert.deepEqual(
    reconcileRun(before, { context: { tokens: -1 } as ContextGauge }).changed,
    [],
  );
  assert.deepEqual(
    reconcileRun(before, { context: { tokens: Number.NaN } as ContextGauge })
      .changed,
    [],
  );
  // Two observed turns already; a lower or unusable total raises nothing.
  assert.deepEqual(reconcileRun(before, { turns: 1 }).changed, []);
  assert.deepEqual(reconcileRun(before, { turns: 2 }).changed, []);
  assert.deepEqual(reconcileRun(before, { turns: 1.5 }).changed, []);
});

test("a usage patch restating one field and changing another reports usage once", () => {
  const before = streamed();

  assert.deepEqual(
    reconcileRun(before, { usage: { input: 10, output: 99 } }).changed,
    ["usage"],
  );
  assert.deepEqual(reconcileRun(before, { usage: { input: 10 } }).changed, []);
});

test("the reduce report for a reconciliation carries the change set", () => {
  const before = streamed();

  const changedStep = reduceRun(before, {
    kind: "reconciliation",
    reconciliation: { finalOutput: "the real answer" },
  });
  const unchangedStep = reduceRun(before, {
    kind: "reconciliation",
    reconciliation: { finalOutput: before.finalOutput },
  });

  assert.equal(changedStep.report.report, "applied");
  assert.deepEqual(
    changedStep.report.report === "applied"
      ? changedStep.report.changed
      : undefined,
    ["finalOutput"],
  );
  assert.deepEqual(
    unchangedStep.report.report === "applied"
      ? unchangedStep.report.changed
      : undefined,
    [],
  );
});

/* ---- the diagnostic a difference produces ---- */

test("a reconciliation that changed something appends one diagnostic", () => {
  const before = streamed();

  const step = reduceRun(before, {
    kind: "reconciliation",
    reconciliation: { finalOutput: "the real answer", turns: 5 },
  });

  assert.deepEqual(step.projection.diagnostics, [
    {
      category: "reconciliation-difference",
      message: "terminal snapshot changed finalOutput, turns",
    },
  ]);
});

test("a reconciliation that changed nothing appends no diagnostic", () => {
  const before = streamed();

  const step = reduceRun(before, {
    kind: "reconciliation",
    reconciliation: {
      finalOutput: before.finalOutput,
      usage: before.usage.totals,
      turns: before.usage.turns,
      model: before.model,
    },
  });

  assert.deepEqual(step.projection.diagnostics, []);
});

test("the difference diagnostic is bounded like any other", () => {
  const tight: ProjectionBounds = {
    ...DEFAULT_PROJECTION_BOUNDS,
    maxDiagnostics: 1,
  };
  const before = reduceRun(
    streamed(),
    {
      kind: "diagnostic",
      diagnostic: runDiagnostic("other", "an earlier one"),
    },
    tight,
  ).projection;

  const step = reduceRun(
    before,
    {
      kind: "reconciliation",
      reconciliation: { finalOutput: "the real answer" },
    },
    tight,
  );

  // The bound holds, the oldest went, and the drop was reported rather than
  // being silently lossy.
  assert.deepEqual(step.projection.diagnostics, [
    {
      category: "reconciliation-difference",
      message: "terminal snapshot changed finalOutput",
    },
  ]);
  assert.equal(step.projection.truncation.droppedDiagnostics, 1);
  assert.equal(step.report.report, "applied-with-truncation");
});

test("the difference message stays inside the diagnostic bound", () => {
  const message = reconciliationDifference([...RECONCILED_FIELDS]).message;

  assert.equal(
    message,
    "terminal snapshot changed transcript, finalOutput, usage, context, turns, model",
  );
  assert.ok(
    new TextEncoder().encode(message).length <= DIAGNOSTIC_MESSAGE_MAX_BYTES,
  );
});

test("a settled Run with a difference reports it in its result", () => {
  const reconciled = reduceRun(streamed(), {
    kind: "reconciliation",
    reconciliation: { finalOutput: "the real answer" },
  }).projection;
  const ending = answeredEnding();
  const settled = reduceRun(reconciled, { kind: "ending", ending }).projection;

  const result = toRunResult({
    identity: {
      runId: runId("run-1"),
      subagentId: subagentId("subagent-1"),
      backendId: backendId("fake"),
      agent: "reviewer",
      description: "review",
    },
    projection: settled,
    ending,
    startedAt: 1,
    settledAt: 2,
  });

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.category),
    ["reconciliation-difference"],
  );
});
