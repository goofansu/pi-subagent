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
  type RunFacts,
  runElapsed,
  runFactsFromRow,
  runFactsFromSummary,
} from "./run-facts.ts";

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
): readonly (readonly [string, RunFacts])[] {
  return [
    [
      "published index row",
      runFactsFromRow(
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
      runFactsFromSummary(
        fixtureSummary({
          phase,
          ...(cancellationReason === undefined ? {} : { cancellationReason }),
          ...(activity === undefined ? {} : { activity }),
        }),
      ),
    ],
  ];
}

test("both source shapes resolve one Run to the same facts, in every phase", () => {
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

test("every Run phase gets a status word, and a cancellation in flight says cancelling", () => {
  for (const phase of RUN_PHASES)
    for (const [shape, facts] of bothShapes(phase)) {
      assert.equal(facts.phase, phase, shape);
      assert.equal(facts.status.text, phase, `${shape} ${phase}`);
      assert.ok(facts.status.tone.length > 0);
      assert.equal(facts.cancellationReason, undefined);
    }
  for (const phase of RUN_PHASES)
    for (const [shape, facts] of bothShapes(phase, "requested")) {
      assert.equal(
        facts.status.text,
        isTerminalRunPhase(phase) ? phase : "cancelling",
        `${shape} ${phase}`,
      );
      assert.equal(facts.cancellationReason, "requested");
    }
});

test("a live Run's activity is what it is doing; a terminal Run's is why it stopped", () => {
  for (const phase of RUN_PHASES)
    for (const [shape, facts] of bothShapes(phase, undefined, "grep: x"))
      assert.equal(
        facts.activity,
        phase === "running" ? "grep: x" : "—",
        `${shape} ${phase}`,
      );
  // A cancellation recorded on a live Run has not stopped it yet, and a
  // terminal Run's retained tool activity is history, not its result.
  for (const reason of CANCELLATION_REASONS)
    for (const phase of RUN_PHASES)
      for (const [shape, facts] of bothShapes(phase, reason, "grep: x"))
        assert.equal(
          facts.activity,
          isTerminalRunPhase(phase) ? reason : "—",
          `${shape} ${phase} ${reason}`,
        );
});

test("current activity stays separate from the retained summary", () => {
  const lastActivity = { summary: "read earlier", changedAt: 100 };
  for (const [shape, facts] of [
    [
      "published index row",
      runFactsFromRow(fixtureRow({ activity: "writing now", lastActivity })),
    ],
    [
      "domain Run summary",
      runFactsFromSummary(
        fixtureSummary({ activity: "writing now", lastActivity }),
      ),
    ],
  ] as const) {
    assert.equal(facts.currentActivity, "writing now", shape);
    assert.deepEqual(facts.lastActivity, lastActivity, shape);
  }
  assert.equal(
    runFactsFromRow(fixtureRow({ lastActivity })).currentActivity,
    undefined,
  );
});

test("only a failed Run and a timed-out cancellation ask for attention", () => {
  for (const phase of RUN_PHASES)
    for (const reason of [undefined, ...CANCELLATION_REASONS])
      for (const [shape, facts] of bothShapes(phase, reason))
        assert.equal(
          facts.executionNeedsAttention,
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
    for (const [shape, facts] of bothShapes(phase)) {
      assert.equal(facts.startedAt, FIXTURE_STARTED_AT, `${shape} ${phase}`);
      assert.equal(
        facts.settledAt !== undefined,
        isTerminalRunPhase(phase),
        `${shape} settles exactly when terminal: ${phase}`,
      );
      assert.equal(
        runElapsed(facts, FIXTURE_NOW),
        "12.4s",
        `${shape} ${phase}`,
      );
      assert.equal(runElapsed(facts, late), expected, `${shape} ${phase} late`);
    }
  }
  // A terminal Run with no settlement instant has no duration to report.
  for (const facts of [
    runFactsFromRow(fixtureRow({ phase: "completed", settledAt: undefined })),
    runFactsFromSummary({
      ...fixtureSummary({ phase: "completed" }),
      settledAt: undefined,
    }),
  ])
    assert.equal(runElapsed(facts, FIXTURE_NOW), "—");
});

test("the Label comes from whichever shape carries it", () => {
  assert.equal(
    runFactsFromRow(fixtureRow({ identity: { description: "read the diff" } }))
      .label,
    "read the diff",
  );
  assert.equal(
    runFactsFromSummary(fixtureSummary({ label: "read the diff" })).label,
    "read the diff",
  );
});

test("a stored Result outranks the summary the capture raced", () => {
  const summary = fixtureSummary({
    phase: "running",
    label: "stale label",
    activity: "bash: npm test",
  });
  const facts = runFactsFromSummary(
    summary,
    fixtureResult({
      identity: { description: "settled label" },
      settledAt: FIXTURE_NOW,
    }),
  );
  assert.equal(facts.label, "settled label");
  assert.equal(facts.phase, "completed");
  assert.equal(facts.status.text, "completed");
  assert.equal(facts.activity, "—");
  assert.equal(facts.settledAt, FIXTURE_NOW);
  assert.equal(runElapsed(facts, FIXTURE_NOW + 60_000), "12.4s");
  // Without the Result, the same summary still reads as the live index says.
  const live = runFactsFromSummary(summary);
  assert.equal(live.phase, "running");
  assert.equal(live.label, "stale label");
  assert.equal(live.activity, "bash: npm test");
});
