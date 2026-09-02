import assert from "node:assert/strict";
import { test } from "node:test";
import {
  delayedUsage,
  duplicateToolProgress,
  FIXTURE_GENERATORS,
  lateAfterEnding,
  reorderedAtBoundary,
} from "../testing/fixtures/observations.ts";
import { runDiagnostic } from "./diagnostics.ts";
import { answeredEnding, cancelledEnding, failedEnding } from "./endings.ts";
import { resultLink } from "./links.ts";
import type { RunObservation } from "./observations.ts";
import {
  createRunProjection,
  DEFAULT_PROJECTION_BOUNDS,
  type ProjectionBounds,
  type RunProjection,
} from "./projection.ts";
import {
  type AppliedReport,
  missingCallIdNote,
  reduceRun,
} from "./reduce-run.ts";
import { byteLength } from "./text.ts";
import { contextGauge, usageDelta } from "./usage.ts";

/** Fold a whole sequence, keeping every report. */
function fold(
  observations: readonly RunObservation[],
  bounds: ProjectionBounds = DEFAULT_PROJECTION_BOUNDS,
  from: RunProjection = createRunProjection(),
): { projection: RunProjection; reports: AppliedReport[] } {
  let projection = from;
  const reports: AppliedReport[] = [];
  for (const observation of observations) {
    const step = reduceRun(projection, observation, bounds);
    projection = step.projection;
    reports.push(step.report);
  }
  return { projection, reports };
}

const assistant = (text: string): RunObservation => ({
  kind: "message",
  role: "assistant",
  parts: [{ kind: "text", text }],
});

const call = (name: string, callId?: string): RunObservation => ({
  kind: "message",
  role: "assistant",
  parts: [{ kind: "tool_call", name, ...(callId ? { callId } : {}) }],
});

/* -------------------------------------------------------------- */
/* Determinism                                                     */
/* -------------------------------------------------------------- */

test("folding the same sequence twice yields deep-equal projections and reports", () => {
  for (const generator of FIXTURE_GENERATORS) {
    const { observations } = generator.generate(7);

    assert.deepEqual(fold(observations), fold(observations), generator.name);
  }
});

test("the reducer never mutates the projection it was given", () => {
  const before = createRunProjection();
  const snapshot = structuredClone(before);

  reduceRun(before, assistant("hello"));
  reduceRun(before, { kind: "usage", usage: usageDelta({ input: 1 }) });

  assert.deepEqual(before, snapshot);
});

/* -------------------------------------------------------------- */
/* Transcript and final output                                     */
/* -------------------------------------------------------------- */

test("messages are appended in the order they were reduced", () => {
  const { projection, reports } = fold([
    { kind: "message", role: "user", parts: [{ kind: "text", text: "go" }] },
    assistant("on it"),
    assistant("done"),
  ]);

  assert.deepEqual(
    projection.transcript.map((item) => [item.role, item.parts]),
    [
      ["user", [{ kind: "text", text: "go" }]],
      ["assistant", [{ kind: "text", text: "on it" }]],
      ["assistant", [{ kind: "text", text: "done" }]],
    ],
  );
  assert.deepEqual(
    reports.map((report) => report.report),
    ["applied", "applied", "applied"],
  );
});

test("the final output is the most recent assistant text", () => {
  assert.equal(
    fold([assistant("first"), assistant("second")]).projection.finalOutput,
    "second",
  );
});

test("an assistant message that only calls tools leaves the answer standing", () => {
  const { projection } = fold([assistant("the answer"), call("grep", "c1")]);

  assert.equal(projection.finalOutput, "the answer");
});

test("a user message never becomes the final output", () => {
  const { projection } = fold([
    assistant("the answer"),
    {
      kind: "message",
      role: "user",
      parts: [{ kind: "text", text: "no, this" }],
    },
  ]);

  assert.equal(projection.finalOutput, "the answer");
});

test("a model on a message is authoritative for the Run", () => {
  const { projection } = fold([
    { kind: "model", model: "model-a" },
    { kind: "message", role: "assistant", parts: [], model: "model-b" },
  ]);

  assert.equal(projection.model, "model-b");
});

/* -------------------------------------------------------------- */
/* Tools merge by call id                                          */
/* -------------------------------------------------------------- */

test("a tool call and its progress become one entry", () => {
  const { projection } = fold([
    call("read_file", "c1"),
    {
      kind: "tool_progress",
      callId: "c1",
      status: "completed",
      outputSummary: "42 lines",
    },
  ]);

  assert.deepEqual(projection.tools, [
    {
      callId: "c1",
      name: "read_file",
      status: "completed",
      outputSummary: "42 lines",
    },
  ]);
});

test("progress that overtakes its call creates a placeholder the call fills", () => {
  const fixture = reorderedAtBoundary(11);

  const { projection, reports } = fold(fixture.observations);

  assert.equal(projection.tools.length, 1);
  assert.equal(projection.tools[0].status, "completed");
  assert.equal(projection.tools[0].outputSummary, "12 hits");
  assert.ok(projection.tools[0].name, "the later call filled in the name");
  assert.ok(
    reports.every((report) => report.report === "applied"),
    "nothing was ignored",
  );
});

test("duplicate progress for one call id merges rather than duplicating", () => {
  const fixture = duplicateToolProgress(3);

  const { projection } = fold(fixture.observations);

  assert.equal(projection.tools.length, 1);
  assert.equal(projection.tools[0].status, "completed");
});

test("the tool list never holds two entries for one call id", () => {
  const { projection } = fold([
    call("grep", "c1"),
    call("grep", "c1"),
    { kind: "tool_progress", callId: "c1", status: "running" },
    call("grep", "c1"),
  ]);

  assert.equal(projection.tools.length, 1);
});

test("a tool call with no call id is a distinct entry, and is reported", () => {
  const { projection, reports } = fold([
    call("grep"),
    call("grep"),
    call("grep", "c1"),
  ]);

  assert.deepEqual(projection.tools, [
    { name: "grep", status: "running" },
    { name: "grep", status: "running" },
    { callId: "c1", name: "grep", status: "running" },
  ]);
  assert.deepEqual(reports[0], {
    report: "applied",
    notes: [missingCallIdNote("grep")],
  });
  assert.deepEqual(reports[2], { report: "applied" });
});

/* -------------------------------------------------------------- */
/* Usage                                                           */
/* -------------------------------------------------------------- */

test("usage deltas are summed and the gauge is replaced, however they arrive", () => {
  const fixture = delayedUsage(5);

  const { projection } = fold(fixture.observations);

  const deltas = fixture.observations.filter(
    (observation) => observation.kind === "usage",
  );
  const expectedInput = deltas.reduce(
    (total, observation) =>
      total +
      (observation.kind === "usage" ? (observation.usage.input ?? 0) : 0),
    0,
  );
  assert.equal(projection.usage.totals.input, expectedInput);
  assert.equal(projection.usage.turns, 2);
  // The gauge is the last value seen, not the sum of the two.
  assert.deepEqual(projection.usage.context, {
    tokens: 2_000,
    window: 200_000,
  });
});

/** Ported from v1's fold: the five additive counters and the one gauge. */
test("the additive counters and the gauge fold as v1's fold folded them", () => {
  const { projection } = fold([
    { kind: "usage", usage: usageDelta({ input: 1, output: 2, turns: 1 }) },
    { kind: "context", context: contextGauge(500) },
    {
      kind: "usage",
      usage: usageDelta({ cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 }),
    },
    { kind: "context", context: contextGauge(700) },
  ]);

  assert.deepEqual(projection.usage, {
    totals: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
    context: { tokens: 700 },
    turns: 2,
  });
});

/* -------------------------------------------------------------- */
/* Activity                                                        */
/* -------------------------------------------------------------- */

test("activity is one latest-wins field", () => {
  const { projection } = fold([
    { kind: "activity", activity: "reading" },
    { kind: "activity", activity: "writing" },
  ]);

  assert.equal(projection.activity, "writing");
});

test("activity is cleared by an explicit clear and by whitespace", () => {
  for (const cleared of [undefined, "", "   "]) {
    const { projection } = fold([
      { kind: "activity", activity: "reading" },
      { kind: "activity", activity: cleared },
    ]);

    assert.equal("activity" in projection, false, String(cleared));
  }
});

test("an over-long activity is cut and the cut is reported", () => {
  const { projection, reports } = fold(
    [{ kind: "activity", activity: "reading a very long file name" }],
    tight,
  );

  assert.equal(projection.activity, "reading ");
  assert.deepEqual(reports[0], {
    report: "applied-with-truncation",
    dropped: [{ of: "activity", amount: 21 }],
  });
  // Not added to the cumulative record: there is only ever one activity.
  assert.equal(projection.truncation.truncatedTranscriptBytes, 0);
});

test("the ending clears activity, so a settled Run is quiet", () => {
  const { projection } = fold([
    { kind: "activity", activity: "reading" },
    { kind: "ending", ending: answeredEnding() },
  ]);

  assert.equal("activity" in projection, false);
});

/* -------------------------------------------------------------- */
/* Settlement is absorbing                                         */
/* -------------------------------------------------------------- */

test("after the ending every observation is ignored as late", () => {
  const fixture = lateAfterEnding(2);

  const { projection, reports } = fold(fixture.observations);
  const endingAt = fixture.observations.findIndex(
    (observation) => observation.kind === "ending",
  );

  assert.equal(projection.terminal, true);
  assert.deepEqual(
    reports.slice(endingAt + 1).map((report) => report.report),
    Array(reports.length - endingAt - 1).fill("ignored-late"),
  );
  // Including the second ending and the reconciliation.
  assert.equal(projection.finalOutput, "the answer");
  assert.equal(projection.usage.totals.input, 10);
  assert.deepEqual(
    projection.ending,
    fixture.observations[endingAt].kind === "ending"
      ? (fixture.observations[endingAt] as { ending: unknown }).ending
      : undefined,
  );
});

test("a late observation leaves the projection identical, not merely similar", () => {
  const settled = fold([
    assistant("done"),
    { kind: "ending", ending: answeredEnding() },
  ]).projection;

  const step = reduceRun(settled, assistant("late"));

  assert.equal(step.projection, settled, "the same object, not a copy");
  assert.deepEqual(step.report, { report: "ignored-late", kind: "message" });
});

test("a tool left running is marked with the Run's terminal outcome", () => {
  const cases = [
    [answeredEnding(), "unfinished"],
    [failedEnding("boom"), "failed"],
    [cancelledEnding("requested"), "cancelled"],
  ] as const;

  for (const [ending, expected] of cases) {
    const { projection } = fold([
      call("read_file", "c1"),
      call("grep", "c2"),
      { kind: "tool_progress", callId: "c2", status: "completed" },
      { kind: "ending", ending },
    ]);

    assert.deepEqual(
      projection.tools.map((entry) => entry.status),
      [expected, "completed"],
      String(expected),
    );
  }
});

/* -------------------------------------------------------------- */
/* Malformed observations                                          */
/* -------------------------------------------------------------- */

test("a malformed observation is ignored and the reason is reported", () => {
  const cases: readonly [RunObservation, string][] = [
    [
      { kind: "message", role: "system" as "user", parts: [] },
      "unknown message role 'system'",
    ],
    [
      { kind: "tool_progress", callId: "", status: "running" },
      "tool progress carries no call id",
    ],
    [
      { kind: "tool_progress", callId: "c1", status: "pending" as "running" },
      "unknown tool status 'pending'",
    ],
    [{ kind: "usage", usage: { input: -1 } }, "input is negative"],
    [{ kind: "context", context: { tokens: 1.5 } }, "tokens is not an integer"],
    [
      {
        kind: "diagnostic",
        diagnostic: { category: "nope" as "other", message: "m" },
      },
      "unknown diagnostic category 'nope'",
    ],
    [
      {
        kind: "link",
        link: { kind: "socket" as "url", label: "l", target: "t" },
      },
      "unknown link kind 'socket'",
    ],
    [{ kind: "model", model: "" }, "model is empty"],
    [
      { kind: "ending", ending: { ending: "done" as "answered" } },
      "unknown ending 'done'",
    ],
    [
      {
        kind: "ending",
        ending: { ending: "cancelled", reason: "why" as "requested" },
      },
      "unknown cancellation reason 'why'",
    ],
  ];

  for (const [observation, reason] of cases) {
    const step = reduceRun(createRunProjection(), observation);

    assert.deepEqual(
      step.report,
      { report: "ignored-invalid", kind: observation.kind, reason },
      reason,
    );
    assert.deepEqual(step.projection, createRunProjection());
  }
});

test("a malformed observation after the ending is reported as late, not invalid", () => {
  const settled = fold([
    { kind: "ending", ending: answeredEnding() },
  ]).projection;

  assert.deepEqual(reduceRun(settled, { kind: "model", model: "" }).report, {
    report: "ignored-late",
    kind: "model",
  });
});

/* -------------------------------------------------------------- */
/* Bounds                                                          */
/* -------------------------------------------------------------- */

const tight: ProjectionBounds = {
  maxTranscriptItems: 2,
  maxToolEntries: 2,
  maxDiagnostics: 2,
  maxLinks: 2,
  maxTextPartBytes: 8,
  maxFinalOutputBytes: 6,
};

test("an overflowing transcript drops its oldest items and records the count", () => {
  const { projection, reports } = fold(
    [assistant("one"), assistant("two"), assistant("three")],
    tight,
  );

  assert.deepEqual(
    projection.transcript.map((item) => item.parts),
    [[{ kind: "text", text: "two" }], [{ kind: "text", text: "three" }]],
  );
  assert.equal(projection.truncation.droppedTranscriptItems, 1);
  assert.deepEqual(reports[2], {
    report: "applied-with-truncation",
    dropped: [{ of: "transcript", amount: 1 }],
  });
});

test("an overflowing tool list drops its oldest entries and records the count", () => {
  const { projection } = fold(
    [call("a", "c1"), call("b", "c2"), call("c", "c3")],
    tight,
  );

  assert.deepEqual(
    projection.tools.map((entry) => entry.callId),
    ["c2", "c3"],
  );
  assert.equal(projection.truncation.droppedToolEntries, 1);
});

test("an overflowing diagnostic list drops its oldest entries", () => {
  const { projection, reports } = fold(
    ["one", "two", "three"].map((message) => ({
      kind: "diagnostic" as const,
      diagnostic: runDiagnostic("other", message),
    })),
    tight,
  );

  assert.deepEqual(
    projection.diagnostics.map((diagnostic) => diagnostic.message),
    ["two", "three"],
  );
  assert.equal(projection.truncation.droppedDiagnostics, 1);
  assert.deepEqual(reports[2], {
    report: "applied-with-truncation",
    dropped: [{ of: "diagnostics", amount: 1 }],
  });
});

test("an overflowing link list drops its oldest entries", () => {
  const { projection } = fold(
    ["one", "two", "three"].map((label) => ({
      kind: "link" as const,
      link: resultLink("log", label, `/tmp/${label}`),
    })),
    tight,
  );

  assert.deepEqual(
    projection.links.map((link) => link.label),
    ["two", "three"],
  );
  assert.equal(projection.truncation.droppedLinks, 1);
});

test("an over-long text part is cut at a character boundary and recorded", () => {
  const { projection, reports } = fold([assistant("ééééé")], tight);

  // Five two-byte characters against an eight-byte bound keeps four of them.
  assert.deepEqual(projection.transcript[0].parts, [
    { kind: "text", text: "éééé" },
  ]);
  assert.equal(byteLength("éééé"), 8);
  assert.equal(projection.truncation.truncatedTranscriptBytes, 2);
  assert.ok(reports[0].report === "applied-with-truncation");
  assert.deepEqual(reports[0].dropped, [
    { of: "transcript-text", amount: 2 },
    { of: "final-output", amount: 2 },
  ]);
});

test("an over-long final output is cut and recorded separately", () => {
  const { projection } = fold([assistant("abcdefgh")], tight);

  // The text part bound applies first, then the tighter output bound.
  assert.equal(projection.transcript[0].parts[0].kind, "text");
  assert.equal(projection.finalOutput, "abcdef");
  assert.equal(projection.truncation.truncatedOutputBytes, 2);
});

test("an over-long tool output summary is cut and recorded separately", () => {
  const { projection } = fold(
    [
      call("grep", "c1"),
      {
        kind: "tool_progress",
        callId: "c1",
        status: "completed",
        outputSummary: "a very long summary",
      },
    ],
    tight,
  );

  assert.equal(projection.tools[0].outputSummary, "a very l");
  assert.equal(projection.truncation.truncatedToolOutputBytes, 11);
});

test("the default bounds are generous enough that a normal Run never notices", () => {
  assert.deepEqual(DEFAULT_PROJECTION_BOUNDS, {
    maxTranscriptItems: 500,
    maxToolEntries: 200,
    maxDiagnostics: 50,
    maxLinks: 20,
    maxTextPartBytes: 16 * 1024,
    maxFinalOutputBytes: 64 * 1024,
  });
});
