import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backendId,
  CANCELLATION_REASONS,
  type CancellationReason,
  isTerminalRunPhase,
  RUN_PHASES,
  type RunPhase,
  type RunSummary,
  runId,
  subagentId,
} from "../domain/index.ts";
import {
  FIXTURE_NOW,
  FIXTURE_STARTED_AT,
  fixtureResult,
  fixtureRow,
} from "../testing/presentation-fixtures.ts";
import {
  type RunPresentation,
  runElapsed,
  runPresentationFromRow,
  runPresentationFromSummary,
} from "./run-presentation.ts";

/** The Run summary the fixture row describes, field for field. */
function fixtureSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: runId("run-1"),
    subagentId: subagentId("subagent-1"),
    profile: "explore",
    backend: backendId("pi"),
    label: "look around",
    phase: "running",
    turns: 3,
    startedAt: FIXTURE_STARTED_AT,
    ...(isTerminalRunPhase(overrides.phase ?? "running")
      ? { settledAt: FIXTURE_NOW }
      : {}),
    ...overrides,
  };
}

/** Both doors, given one Run, for every phase and cancellation. */
function bothShapes(
  phase: RunPhase,
  cancellationReason?: CancellationReason,
  activity?: string,
): readonly (readonly [string, RunPresentation])[] {
  return [
    [
      "published index row",
      runPresentationFromRow(
        fixtureRow({
          phase,
          ...(cancellationReason === undefined
            ? {}
            : { cancellation: { reason: cancellationReason } }),
          ...(activity === undefined ? {} : { activity }),
        }),
      ),
    ],
    [
      "domain Run summary",
      runPresentationFromSummary(
        fixtureSummary({
          phase,
          ...(cancellationReason === undefined ? {} : { cancellationReason }),
          ...(activity === undefined ? {} : { activity }),
        }),
      ),
    ],
  ];
}

test("both source shapes resolve one Run the same way, in every phase", () => {
  for (const phase of RUN_PHASES) {
    for (const cancellationReason of [undefined, ...CANCELLATION_REASONS]) {
      const [[, row], [, summary]] = bothShapes(
        phase,
        cancellationReason,
        "bash: npm test",
      );
      assert.deepEqual(row, summary, `${phase} / ${cancellationReason}`);
    }
  }
});

test("every phase and reason resolves to one status word in one tone", () => {
  // The whole matrix, spelled out rather than derived: a phase table read
  // twice proves nothing, and the tones are what a reader acts on. A recorded
  // reason is what says a cancellation was requested, so the phases that are
  // not yet terminal read `cancelling` whichever reason it was.
  const expected = (
    phase: RunPhase,
    reason: CancellationReason | undefined,
  ): { readonly text: string; readonly tone: string } => {
    if (reason !== undefined && !isTerminalRunPhase(phase))
      return { text: "cancelling", tone: "warning" };
    if (phase === "cancelled")
      return reason === "timeout" || reason === undefined
        ? { text: "cancelled", tone: "error" }
        : { text: "cancelled", tone: "muted" };
    return {
      text: phase,
      tone: {
        running: "warning",
        finalizing: "warning",
        completed: "success",
        failed: "error",
      }[phase],
    };
  };

  for (const phase of RUN_PHASES)
    for (const reason of [undefined, ...CANCELLATION_REASONS])
      for (const [shape, presentation] of bothShapes(phase, reason)) {
        assert.equal(presentation.phase, phase, shape);
        assert.deepEqual(
          presentation.status,
          expected(phase, reason),
          `${shape} ${phase} ${reason}`,
        );
        assert.equal(presentation.cancellationReason, reason);
      }
});

test("a live Run's activity is what it is doing; a terminal Run's is why it stopped", () => {
  for (const phase of RUN_PHASES)
    for (const [shape, presentation] of bothShapes(phase, undefined, "grep: x"))
      assert.equal(
        presentation.activity,
        phase === "running" ? "grep: x" : "—",
        `${shape} ${phase}`,
      );
  // A cancellation recorded on a live Run has not stopped it yet, and a
  // terminal Run's retained tool activity is history, not its result.
  for (const reason of CANCELLATION_REASONS)
    for (const phase of RUN_PHASES)
      for (const [shape, presentation] of bothShapes(phase, reason, "grep: x"))
        assert.equal(
          presentation.activity,
          isTerminalRunPhase(phase) ? reason : "—",
          `${shape} ${phase} ${reason}`,
        );
});

test("current activity stays separate from the retained summary", () => {
  const lastActivity = { summary: "read earlier", changedAt: 100 };
  for (const [shape, presentation] of [
    [
      "published index row",
      runPresentationFromRow(
        fixtureRow({ activity: "writing now", lastActivity }),
      ),
    ],
    [
      "domain Run summary",
      runPresentationFromSummary(
        fixtureSummary({ activity: "writing now", lastActivity }),
      ),
    ],
  ] as const) {
    assert.equal(presentation.currentActivity, "writing now", shape);
    assert.deepEqual(presentation.lastActivity, lastActivity, shape);
  }
  assert.equal(
    runPresentationFromRow(fixtureRow({ lastActivity })).currentActivity,
    undefined,
  );
  // Only a running, uncancelled Run is doing something now. Blank activity is
  // nothing rather than something, and the retained summary never stands in.
  for (const overrides of [
    { activity: "old", cancellation: { reason: "requested" as const } },
    { activity: "old", phase: "finalizing" as const },
    { activity: "  " },
  ]) {
    const presentation = runPresentationFromRow(
      fixtureRow({ ...overrides, lastActivity }),
    );
    assert.equal(presentation.currentActivity, undefined);
    assert.deepEqual(presentation.lastActivity, lastActivity);
  }
});

test("only a failed Run and a timed-out cancellation ask for attention", () => {
  for (const phase of RUN_PHASES)
    for (const reason of [undefined, ...CANCELLATION_REASONS])
      for (const [shape, presentation] of bothShapes(phase, reason))
        assert.equal(
          presentation.executionNeedsAttention,
          phase === "failed" || (phase === "cancelled" && reason === "timeout"),
          `${shape} ${phase} ${reason}`,
        );
});

test("elapsed time runs to the instant it is read at and freezes at settlement", () => {
  // Read well past settlement, the only instant that tells a frozen duration
  // from a live one.
  const late = FIXTURE_NOW + 60_000;
  for (const phase of RUN_PHASES) {
    const expected = isTerminalRunPhase(phase) ? "12.4s" : "1m 12s";
    for (const [shape, presentation] of bothShapes(phase)) {
      assert.equal(
        presentation.startedAt,
        FIXTURE_STARTED_AT,
        `${shape} ${phase}`,
      );
      assert.equal(
        presentation.settledAt !== undefined,
        isTerminalRunPhase(phase),
        `${shape} settles exactly when terminal: ${phase}`,
      );
      assert.equal(
        runElapsed(presentation, FIXTURE_NOW),
        "12.4s",
        `${shape} ${phase}`,
      );
      assert.equal(
        runElapsed(presentation, late),
        expected,
        `${shape} ${phase} late`,
      );
    }
  }
  // A terminal Run with no settlement instant has no duration to report.
  for (const presentation of [
    runPresentationFromRow(
      fixtureRow({ phase: "completed", settledAt: undefined }),
    ),
    runPresentationFromSummary({
      ...fixtureSummary({ phase: "completed" }),
      settledAt: undefined,
    }),
  ])
    assert.equal(runElapsed(presentation, FIXTURE_NOW), "—");
});

test("the Label comes from whichever shape carries it", () => {
  assert.equal(
    runPresentationFromRow(
      fixtureRow({ identity: { description: "read the diff" } }),
    ).label,
    "read the diff",
  );
  assert.equal(
    runPresentationFromSummary(fixtureSummary({ label: "read the diff" }))
      .label,
    "read the diff",
  );
});

test("a stored Result outranks the summary the capture raced", () => {
  const summary = fixtureSummary({
    phase: "running",
    label: "stale label",
    activity: "bash: npm test",
  });
  const presentation = runPresentationFromSummary(
    summary,
    fixtureResult({
      identity: { description: "settled label" },
      settledAt: FIXTURE_NOW,
    }),
  );
  assert.equal(presentation.label, "settled label");
  assert.equal(presentation.phase, "completed");
  assert.equal(presentation.status.text, "completed");
  assert.equal(presentation.activity, "—");
  assert.equal(presentation.settledAt, FIXTURE_NOW);
  assert.equal(runElapsed(presentation, FIXTURE_NOW + 60_000), "12.4s");
  // Without the Result, the same summary still reads as the live index says.
  const live = runPresentationFromSummary(summary);
  assert.equal(live.phase, "running");
  assert.equal(live.label, "stale label");
  assert.equal(live.activity, "bash: npm test");
});
