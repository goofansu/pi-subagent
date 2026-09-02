import assert from "node:assert/strict";
import { test } from "node:test";
import type { Equals, Expect } from "../testing/type-level.ts";
import { runId, subagentId } from "./ids.ts";
import {
  alreadyTerminal,
  CANCEL_OUTCOMES,
  type CancelOutcome,
  RESULT_OUTCOMES,
  RESUME_OUTCOMES,
  type ResultOutcome,
  type ResumeOutcome,
  START_OUTCOMES,
  STEER_OUTCOMES,
  type StartOutcome,
  type SteerOutcome,
  WAIT_OUTCOMES,
  type WaitOutcome,
} from "./outcomes.ts";
import { TERMINAL_RUN_PHASES } from "./phases.ts";

/** The discriminants of one outcome union. */
type Names<T extends { readonly outcome: string }> = T["outcome"];

/**
 * Each entry proves one union's member set is exactly the exported list of
 * names for it. Adding a member to a union without adding its name, or the
 * other way round, fails to compile — which is how the lists stay usable as
 * the thing tests and documents compare against.
 */
type OutcomeUnionsMatchTheirNameLists = [
  Expect<Equals<Names<StartOutcome>, (typeof START_OUTCOMES)[number]>>,
  Expect<Equals<Names<ResumeOutcome>, (typeof RESUME_OUTCOMES)[number]>>,
  Expect<Equals<Names<SteerOutcome>, (typeof STEER_OUTCOMES)[number]>>,
  Expect<Equals<Names<CancelOutcome>, (typeof CANCEL_OUTCOMES)[number]>>,
  Expect<Equals<Names<WaitOutcome>, (typeof WAIT_OUTCOMES)[number]>>,
  Expect<Equals<Names<ResultOutcome>, (typeof RESULT_OUTCOMES)[number]>>,
];

test("every outcome union has exactly the members its name list declares", () => {
  const proofs: OutcomeUnionsMatchTheirNameLists = [
    true,
    true,
    true,
    true,
    true,
    true,
  ];

  assert.equal(proofs.length, 6);
});

test("start rejects with the six reasons the semantics document lists", () => {
  assert.deepEqual(
    START_OUTCOMES.filter((name) => name !== "started"),
    [
      "unknown agent",
      "invalid profile",
      "at capacity",
      "shutting down",
      "delegation-depth exceeded",
      // The one rejection that happens after admission, because opening a
      // BackendAgent is the one part of starting that talks to a provider.
      "backend unavailable",
    ],
  );
});

test("resume has no backend-unavailable outcome, because resume opens nothing", () => {
  assert.equal(RESUME_OUTCOMES.includes("backend unavailable" as never), false);
});

test("resume rejects with the six reasons the semantics document lists", () => {
  assert.deepEqual(
    RESUME_OUTCOMES.filter((name) => name !== "started"),
    [
      "unknown Subagent",
      "Subagent already running",
      "resume unsupported",
      "conversation lost",
      "at capacity",
      "shutting down",
    ],
  );
});

test("steer answers with the seven mailbox outcomes plus shutting down", () => {
  assert.deepEqual(
    [...STEER_OUTCOMES],
    [
      "accepted",
      "mailbox full",
      "invalid",
      "unsupported",
      "mailbox closed",
      "already completed",
      "already failed",
      "already cancelled",
      "unknown Run",
      "shutting down",
    ],
  );
});

test("`already <status>` expands to exactly one name per terminal status", () => {
  assert.deepEqual(
    TERMINAL_RUN_PHASES.map((status) => alreadyTerminal(status)),
    ["already completed", "already failed", "already cancelled"],
  );
  for (const status of TERMINAL_RUN_PHASES) {
    assert.ok(STEER_OUTCOMES.includes(alreadyTerminal(status)));
    assert.ok(CANCEL_OUTCOMES.includes(alreadyTerminal(status)));
  }
});

test("cancel answers about request admission, not about having stopped", () => {
  assert.deepEqual(
    CANCEL_OUTCOMES.filter((name) => !name.startsWith("already ")),
    ["admitted", "idempotent", "unknown Run"],
  );
});

test("wait reports terminality, patience, or an unknown id", () => {
  assert.deepEqual(
    [...WAIT_OUTCOMES],
    ["terminal", "still running", "unknown Run"],
  );
});

test("result distinguishes an evicted output from a wrong identifier", () => {
  assert.deepEqual(
    [...RESULT_OUTCOMES],
    ["result", "ResultExpired", "RunNotTerminal", "unknown Run"],
  );
});

test("an outcome value carries the identity the caller needs to act on it", () => {
  const steered: SteerOutcome = {
    outcome: "mailbox full",
    runId: runId("run-9"),
  };
  const resumed: ResumeOutcome = {
    outcome: "Subagent already running",
    subagentId: subagentId("subagent-9"),
  };
  const expired: ResultOutcome = {
    outcome: "ResultExpired",
    runId: runId("run-9"),
    subagentId: subagentId("subagent-9"),
    status: "completed",
  };

  assert.equal(steered.runId, "run-9");
  assert.equal(resumed.subagentId, "subagent-9");
  assert.equal(expired.outcome, "ResultExpired");
});
