import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANCELLATION_REASONS,
  ILLEGAL_TRANSITION,
  isTerminalRunPhase,
  RUN_EVENTS,
  RUN_PHASES,
  RUN_TRANSITIONS,
  type RunPhase,
  recordCancellation,
  SUBAGENT_EVENTS,
  SUBAGENT_PHASES,
  SUBAGENT_TRANSITIONS,
  TERMINAL_RUN_PHASES,
  transitionRun,
  transitionSubagent,
} from "./phases.ts";

/** Every (phase, event) pair of a table, as a flat list of readable cells. */
function cells<P extends string, E extends string>(
  phases: readonly P[],
  events: readonly E[],
  read: (phase: P, event: E) => string,
): string[] {
  return phases.flatMap((phase) =>
    events.map((event) => `${phase} + ${event} -> ${read(phase, event)}`),
  );
}

test("the Subagent table names every legal change and nothing else", () => {
  assert.deepEqual(
    cells(
      SUBAGENT_PHASES,
      SUBAGENT_EVENTS,
      (phase, event) => SUBAGENT_TRANSITIONS[phase][event],
    ),
    [
      "running + run-settled -> idle",
      "running + resume-admitted -> illegal",
      "running + close -> closed",
      "idle + run-settled -> illegal",
      "idle + resume-admitted -> running",
      "idle + close -> closed",
      // A closed Subagent may still have a Run finishing its settlement, and
      // closing twice is idempotent. Neither leaves `closed`.
      "closed + run-settled -> closed",
      "closed + resume-admitted -> illegal",
      "closed + close -> closed",
    ],
  );
});

test("the Subagent function agrees with the table in every cell", () => {
  for (const phase of SUBAGENT_PHASES) {
    for (const event of SUBAGENT_EVENTS) {
      assert.equal(
        transitionSubagent(phase, event),
        SUBAGENT_TRANSITIONS[phase][event],
        `${phase} + ${event}`,
      );
    }
  }
});

test("a closed Subagent is absorbing: no event moves it anywhere else", () => {
  for (const event of SUBAGENT_EVENTS) {
    const next = transitionSubagent("closed", event);
    assert.ok(
      next === "closed" || next === ILLEGAL_TRANSITION,
      `closed + ${event} produced ${next}`,
    );
  }
});

test("the Run table names every legal change and nothing else", () => {
  assert.deepEqual(
    cells(
      RUN_PHASES,
      RUN_EVENTS,
      (phase, event) => RUN_TRANSITIONS[phase][event],
    ),
    [
      "running + execution-ended -> finalizing",
      "running + settled-answered -> illegal",
      "running + settled-failed -> illegal",
      "running + settled-cancelled -> illegal",
      "finalizing + execution-ended -> illegal",
      "finalizing + settled-answered -> completed",
      "finalizing + settled-failed -> failed",
      "finalizing + settled-cancelled -> cancelled",
      "completed + execution-ended -> illegal",
      "completed + settled-answered -> illegal",
      "completed + settled-failed -> illegal",
      "completed + settled-cancelled -> illegal",
      "failed + execution-ended -> illegal",
      "failed + settled-answered -> illegal",
      "failed + settled-failed -> illegal",
      "failed + settled-cancelled -> illegal",
      "cancelled + execution-ended -> illegal",
      "cancelled + settled-answered -> illegal",
      "cancelled + settled-failed -> illegal",
      "cancelled + settled-cancelled -> illegal",
    ],
  );
});

test("the Run function agrees with the table in every cell", () => {
  for (const phase of RUN_PHASES) {
    for (const event of RUN_EVENTS) {
      assert.equal(
        transitionRun(phase, event),
        RUN_TRANSITIONS[phase][event],
        `${phase} + ${event}`,
      );
    }
  }
});

test("a Run reaches a terminal phase only through finalizing", () => {
  assert.equal(transitionRun("running", "execution-ended"), "finalizing");
  assert.equal(transitionRun("finalizing", "settled-answered"), "completed");
  assert.equal(transitionRun("finalizing", "settled-failed"), "failed");
  assert.equal(transitionRun("finalizing", "settled-cancelled"), "cancelled");
  assert.equal(
    transitionRun("running", "settled-answered"),
    ILLEGAL_TRANSITION,
  );
});

test("every terminal Run phase is absorbing", () => {
  for (const phase of TERMINAL_RUN_PHASES) {
    for (const event of RUN_EVENTS) {
      assert.equal(
        transitionRun(phase, event),
        ILLEGAL_TRANSITION,
        `${phase} + ${event}`,
      );
    }
  }
});

test("terminality is a property of exactly three of the five Run phases", () => {
  assert.deepEqual(
    RUN_PHASES.filter((phase) => isTerminalRunPhase(phase)),
    [...TERMINAL_RUN_PHASES],
  );
});

test("no transition function throws on any pair, legal or not", () => {
  for (const phase of SUBAGENT_PHASES) {
    for (const event of SUBAGENT_EVENTS) {
      assert.doesNotThrow(() => transitionSubagent(phase, event));
    }
  }
  for (const phase of RUN_PHASES) {
    for (const event of RUN_EVENTS) {
      assert.doesNotThrow(() => transitionRun(phase, event));
    }
  }
});

test("recording a cancellation on an active Run leaves the phase alone", () => {
  for (const phase of ["running", "finalizing"] as const) {
    for (const reason of CANCELLATION_REASONS) {
      assert.deepEqual(recordCancellation(phase, undefined, reason), {
        outcome: "recorded",
        request: { reason },
      });
    }
  }
});

test("recording a cancellation twice is idempotent and the first reason wins", () => {
  const first = recordCancellation("running", undefined, "requested");
  assert.equal(first.outcome, "recorded");
  assert.ok("request" in first);

  const second = recordCancellation("running", first.request, "shutdown");

  assert.deepEqual(second, {
    outcome: "unchanged",
    request: { reason: "requested" },
  });
  const third = recordCancellation("finalizing", first.request, "timeout");
  assert.deepEqual(third, second);
});

test("recording a cancellation on a terminal Run is illegal", () => {
  for (const phase of TERMINAL_RUN_PHASES) {
    assert.deepEqual(recordCancellation(phase, undefined, "requested"), {
      outcome: ILLEGAL_TRANSITION,
      phase,
    });
  }
});

test("the cancellation reasons are request, shutdown, and timeout", () => {
  assert.deepEqual(
    [...CANCELLATION_REASONS],
    ["requested", "shutdown", "timeout"],
  );
});

test("phase lists have no duplicates and terminal phases are Run phases", () => {
  const unique = (values: readonly string[]): number => new Set(values).size;
  assert.equal(unique(SUBAGENT_PHASES), SUBAGENT_PHASES.length);
  assert.equal(unique(RUN_PHASES), RUN_PHASES.length);
  for (const phase of TERMINAL_RUN_PHASES) {
    assert.ok((RUN_PHASES as readonly RunPhase[]).includes(phase));
  }
});
