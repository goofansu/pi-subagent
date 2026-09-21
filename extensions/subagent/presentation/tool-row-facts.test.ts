import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CancelOutcome,
  ResultOutcome,
  ResumeOutcome,
  StartOutcome,
  SteerOutcome,
  WaitOutcome,
} from "../domain/index.ts";
import { runId, subagentId } from "../domain/index.ts";
import { fixtureResult } from "../testing/presentation-fixtures.ts";
import {
  formatResumeOutcome,
  formatStartOutcome,
  formatSteerOutcome,
} from "./prose.ts";
import {
  cancelToolRowFacts,
  decodeToolRowFacts,
  encodeToolRowFacts,
  noActiveWaitAllToolRowFacts,
  RESUME_OUTCOME_PRESENTATION,
  resultToolRowFacts,
  resumeToolRowFacts,
  START_OUTCOME_PRESENTATION,
  STEER_OUTCOME_PRESENTATION,
  startToolRowFacts,
  steerToolRowFacts,
  waitAllToolRowFacts,
  waitToolRowFacts,
} from "./tool-row-facts.ts";

const rid = runId("run-test-1");
const sid = subagentId("subagent-test-1");
const result = fixtureResult({ finalOutput: "answer" });
const startOutcomes: readonly StartOutcome[] = [
  { outcome: "started", subagentId: sid, runId: rid },
  { outcome: "unknown agent", agent: "ghost" },
  { outcome: "invalid profile", diagnostics: [] },
  { outcome: "empty label" },
  { outcome: "at capacity" },
  { outcome: "shutting down" },
  { outcome: "delegation-depth exceeded", depth: 2 },
  {
    outcome: "backend unavailable",
    diagnostic: { category: "backend-failure", message: "unavailable" },
  },
];

const resumeOutcomes: readonly ResumeOutcome[] = [
  { outcome: "started", subagentId: sid, runId: rid },
  { outcome: "unknown Subagent", subagentId: sid },
  { outcome: "Subagent already running", subagentId: sid },
  { outcome: "empty label" },
  { outcome: "resume unsupported" },
  { outcome: "conversation lost" },
  { outcome: "at capacity" },
  { outcome: "shutting down" },
];

const steerOutcomes: readonly SteerOutcome[] = [
  { outcome: "accepted", runId: rid },
  { outcome: "mailbox full", runId: rid },
  { outcome: "invalid", reason: "empty" },
  { outcome: "unsupported", runId: rid },
  { outcome: "mailbox closed", runId: rid },
  { outcome: "already completed", runId: rid },
  { outcome: "already failed", runId: rid },
  { outcome: "already cancelled", runId: rid },
  { outcome: "unknown Run", runId: rid },
  { outcome: "shutting down" },
];

const cancelOutcomes: readonly CancelOutcome[] = [
  { outcome: "admitted", runId: rid },
  { outcome: "idempotent", runId: rid },
  { outcome: "already completed", runId: rid },
  { outcome: "already failed", runId: rid },
  { outcome: "already cancelled", runId: rid },
  { outcome: "unknown Run", runId: rid },
];

const waitOutcomes: readonly WaitOutcome[] = [
  { outcome: "terminal", runId: result.runId, status: "completed", result },
  { outcome: "terminal", runId: rid, status: "failed" },
  { outcome: "still running", runId: rid },
  { outcome: "unknown Run", runId: rid },
];

const resultOutcomes: readonly ResultOutcome[] = [
  { outcome: "result", result },
  {
    outcome: "ResultExpired",
    runId: rid,
    subagentId: sid,
    status: "cancelled",
  },
  { outcome: "RunNotTerminal", runId: rid },
  { outcome: "unknown Run", runId: rid },
];

test("pass-through table keys construct and round-trip every domain outcome", () => {
  const cases = [
    [
      START_OUTCOME_PRESENTATION,
      startOutcomes,
      (outcome: StartOutcome) => startToolRowFacts("explore", outcome),
      (outcome: StartOutcome) =>
        formatStartOutcome("explore", outcome, ["explore"]),
    ],
    [
      RESUME_OUTCOME_PRESENTATION,
      resumeOutcomes,
      (outcome: ResumeOutcome) => resumeToolRowFacts(outcome),
      (outcome: ResumeOutcome) => formatResumeOutcome(sid, outcome),
    ],
    [
      STEER_OUTCOME_PRESENTATION,
      steerOutcomes,
      (outcome: SteerOutcome) => steerToolRowFacts(rid, outcome),
      (outcome: SteerOutcome) => formatSteerOutcome(rid, outcome),
    ],
  ] as const;

  for (const [table, outcomes, construct, formatSentence] of cases) {
    const keys = Object.keys(table);
    assert.deepEqual(
      keys.sort(),
      outcomes.map(({ outcome }) => outcome).sort(),
    );
    for (const key of keys) {
      const outcome = outcomes.find((candidate) => candidate.outcome === key);
      assert.ok(outcome, `missing fixture for ${key}`);
      const facts = construct(outcome as never);
      assert.deepEqual(decodeToolRowFacts(encodeToolRowFacts(facts)), facts);
      assert.ok(facts.rowPhrase.trim().length > 0);
      assert.ok(formatSentence(outcome as never).trim().length > 0);
    }
  }
});

test("named aggregate facts construction round-trips", () => {
  const facts = [
    ...cancelOutcomes.map((outcome) => cancelToolRowFacts([outcome])),
    waitToolRowFacts(waitOutcomes),
    waitAllToolRowFacts(waitOutcomes),
    noActiveWaitAllToolRowFacts(),
    ...resultOutcomes.map(resultToolRowFacts),
  ];

  for (const value of facts) {
    assert.deepEqual(decodeToolRowFacts(encodeToolRowFacts(value)), value);
  }
  assert.deepEqual(
    facts.map((value) =>
      value.kind === "collection" ? `${value.kind}:${value.scope}` : value.kind,
    ),
    [
      ...cancelOutcomes.map(() => "cancel"),
      "collection:named",
      "collection:all-active",
      "collection:all-active",
      ...resultOutcomes.map(() => "result"),
    ],
  );
});

test("Result Tool-row facts summarize final-output interpretation without carrying output", () => {
  const cases = [
    [fixtureResult(), { kind: "none" }],
    [fixtureResult({ finalOutput: " \n\t " }), { kind: "none" }],
    [
      fixtureResult({
        finalOutput: "",
        truncation: { truncatedOutputBytes: 23 },
      }),
      { kind: "removed" },
    ],
    [
      fixtureResult({ finalOutput: "answer" }),
      { kind: "visible", characters: 6 },
    ],
    [
      fixtureResult({
        finalOutput: "prefix",
        truncation: { truncatedOutputBytes: 23 },
      }),
      { kind: "visible", characters: 6 },
    ],
  ] as const;

  for (const [fixture, output] of cases) {
    const facts = resultToolRowFacts({ outcome: "result", result: fixture });
    assert.equal(facts.outcome, "available");
    if (facts.outcome === "available") {
      assert.deepEqual(facts.run.output, output);
    }
  }
});

test("schema-backed facts reject extra keys at every depth and wrong field types", () => {
  const collection = waitToolRowFacts(waitOutcomes);
  const cancellation = cancelToolRowFacts(cancelOutcomes);
  const available = resultToolRowFacts({ outcome: "result", result });

  const encodedCollection = encodeToolRowFacts(collection) as Record<
    string,
    unknown
  >;
  const encodedCancellation = encodeToolRowFacts(cancellation) as {
    readonly outcomes: readonly Record<string, unknown>[];
  };
  const encodedAvailable = encodeToolRowFacts(available) as {
    readonly run: {
      readonly output: Record<string, unknown>;
    };
  };

  assert.equal(
    decodeToolRowFacts({ ...encodedCollection, extra: true }),
    undefined,
  );
  assert.equal(
    decodeToolRowFacts({
      ...encodedCancellation,
      outcomes: [{ ...encodedCancellation.outcomes[0], extra: true }],
    }),
    undefined,
  );
  assert.equal(
    decodeToolRowFacts({
      ...encodedAvailable,
      run: {
        ...encodedAvailable.run,
        output: { ...encodedAvailable.run.output, extra: true },
      },
    }),
    undefined,
  );
  assert.equal(
    decodeToolRowFacts({
      ...encodedAvailable,
      run: {
        ...encodedAvailable.run,
        output: { kind: "visible", characters: "6" },
      },
    }),
    undefined,
  );
});

test("the Tool-row facts decoder accepts all terminal phases and nested cancellation outcomes", () => {
  for (const phase of ["completed", "failed", "cancelled"] as const) {
    const facts = {
      kind: "cancel",
      outcomes: [{ kind: "already terminal", runId: rid, phase }],
    };
    assert.deepEqual(decodeToolRowFacts(facts), facts);
  }

  assert.deepEqual(
    decodeToolRowFacts(resultToolRowFacts({ outcome: "result", result })),
    {
      kind: "result",
      outcome: "available",
      run: {
        runId: result.runId,
        agent: "explore",
        status: "completed",
        output: { kind: "visible", characters: 6 },
      },
    },
  );
});

test("the Tool-row facts decoder returns absence and never throws for malformed, foreign, and legacy values", () => {
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("host getter failed");
      },
    },
  );
  const malformed: readonly unknown[] = [
    undefined,
    null,
    "facts",
    throwing,
    { kind: "foreign", outcome: "started" },
    { kind: "wait", runs: [] },
    { agent: "explore", subagentId: "subagent-legacy", runId: "run-legacy" },
    { kind: "start", outcome: "started", agent: "explore", runId: rid },
    {
      kind: "start",
      outcome: "started",
      agent: "explore",
      subagentId: "bad id",
      runId: rid,
    },
    {
      kind: "start",
      outcome: "delegation-depth exceeded",
      agent: "x",
      depth: Number.NaN,
    },
    { kind: "resume", outcome: "started", subagentId: sid, runId: "" },
    { kind: "steer", outcome: "accepted", runId: rid, excess: true },
    { kind: "cancel", outcomes: [{ kind: "requested", runId: "bad id" }] },
    {
      kind: "cancel",
      outcomes: [{ kind: "already terminal", runId: rid, phase: "running" }],
    },
    {
      kind: "cancel",
      outcomes: [{ kind: "already terminal", runId: rid, phase: "finalizing" }],
    },
    {
      kind: "collection",
      scope: "named",
      runs: "not-an-array",
      stillRunning: 0,
      unknown: 0,
      unavailable: 0,
      noActiveRuns: false,
    },
    {
      kind: "collection",
      scope: "named",
      runs: [],
      stillRunning: -1,
      unknown: 0,
      unavailable: 0,
      noActiveRuns: false,
    },
    {
      kind: "collection",
      scope: "named",
      runs: [],
      stillRunning: 0,
      unknown: 0,
      unavailable: 0,
      noActiveRuns: true,
    },
    {
      kind: "collection",
      scope: "all-active",
      runs: [],
      stillRunning: 1,
      unknown: 0,
      unavailable: 0,
      noActiveRuns: true,
    },
    {
      kind: "collection",
      scope: "all-active",
      runs: [
        {
          runId: rid,
          agent: "explore",
          status: "running",
          output: { kind: "visible", characters: 1 },
        },
      ],
      stillRunning: 0,
      unknown: 0,
      unavailable: 0,
      noActiveRuns: false,
    },
    {
      kind: "result",
      outcome: "available",
      run: {
        runId: rid,
        agent: "explore",
        status: "completed",
        output: { kind: "visible", characters: Infinity },
      },
    },
    {
      kind: "result",
      outcome: "available",
      run: {
        runId: rid,
        agent: "explore",
        status: "completed",
        output: { kind: "removed", characters: 1 },
      },
    },
    {
      kind: "result",
      outcome: "unavailable",
      runId: rid,
      status: "finalizing",
    },
  ];

  for (const value of malformed) {
    assert.doesNotThrow(() => decodeToolRowFacts(value));
    assert.equal(decodeToolRowFacts(value), undefined);
  }
});
