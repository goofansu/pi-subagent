import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import type { RunDiagnostic } from "../domain/index.ts";
import { emitText, type FakeStep } from "../testing/fakes/script.ts";
import {
  rigRequest as request,
  type SessionOutcome,
  startedRun,
  untilTerminal,
  withSession,
} from "../testing/session-rig.ts";
import type { SupervisorCounters } from "./counters.ts";

/**
 * What a terminal snapshot that *disagreed* produces, and what one that agreed
 * does not.
 *
 * `reconciliationDifferences` used to count arrivals: every Run on a backend
 * that always sends a snapshot raised it, so the counter read as a count of
 * answered Runs and said nothing about the backend. These tests hold it to its
 * name on both paths a snapshot can arrive by — inside the terminal bundle,
 * and announced through the intake when a cancel reaches a Run that had
 * already finished — and hold the per-Run diagnostic to the same rule.
 *
 * Nothing here sleeps.
 */

/** What one Run of a script left behind, for every test below to assert on. */
interface Answered {
  readonly counters: SupervisorCounters;
  readonly finalOutput: string;
  readonly diagnostics: readonly RunDiagnostic[];
}

/**
 * Drive one Run of one script to settlement and read what it produced.
 *
 * Every test here is the same Run — start, settle, read the result — differing
 * only in the script. Extracting it keeps each test's script the only thing on
 * screen, which is the thing the test is about.
 */
function answered(
  steps: readonly FakeStep[],
): Promise<SessionOutcome<Answered>> {
  return withSession({ steps: [steps] }, (rig) =>
    Effect.gen(function* () {
      const run = startedRun(yield* rig.supervisor.start(request()));
      yield* untilTerminal(rig, run.runId);
      const read = yield* rig.supervisor.result(run.runId);
      return {
        counters: rig.counters.counters(),
        finalOutput: read.outcome === "result" ? read.result.finalOutput : "",
        diagnostics: read.outcome === "result" ? read.result.diagnostics : [],
      };
    }),
  );
}

/** The one diagnostic a difference produces, or `undefined` when there is none. */
function difference(diagnostics: readonly RunDiagnostic[]): string | undefined {
  const found = diagnostics.filter(
    (diagnostic) => diagnostic.category === "reconciliation-difference",
  );
  assert.ok(found.length <= 1, "a Run carried more than one difference");
  return found[0]?.message;
}

test("a snapshot that restates the stream is not a difference and says nothing", async () => {
  const { value, noLeaks } = await answered([
    emitText("the answer"),
    { step: "cumulative-usage", total: { input: 40, output: 10 } },
    // Exactly what was streamed: one turn, the same totals.
    {
      step: "complete",
      reconciliation: { usage: { input: 40, output: 10 }, turns: 1 },
    },
  ]);

  assert.ok(noLeaks);
  assert.equal(value.counters.reconciliationDifferences, 0);
  // An ordinary answered Run still settles with an empty diagnostic list.
  assert.deepEqual(value.diagnostics, []);
});

test("a snapshot that changed several fields counts one difference and names them all", async () => {
  const { value, noLeaks } = await answered([
    emitText("a partial answer"),
    { step: "cumulative-usage", total: { input: 40, output: 10 } },
    {
      step: "complete",
      reconciliation: {
        finalOutput: "the real answer",
        usage: { input: 50, output: 12 },
        turns: 3,
        model: "model-b",
      },
    },
  ]);

  assert.ok(noLeaks);
  // Four fields changed; one Run disagreed. The counter counts Runs.
  assert.equal(value.counters.reconciliationDifferences, 1);
  assert.equal(
    difference(value.diagnostics),
    "terminal snapshot changed finalOutput, usage, turns, model",
  );
});

test("a reconciliation announced through the intake is counted like one in the bundle", async () => {
  // The seam an adapter uses when a cancel reaches a Run whose work already
  // finished: it emits the snapshot and the ending it implies through the
  // intake rather than returning them in a terminal bundle. Before this, the
  // intake path was not counted at all.
  const { value, noLeaks } = await answered([
    emitText("a partial answer"),
    {
      step: "emit",
      observation: {
        kind: "reconciliation",
        reconciliation: { finalOutput: "the real answer" },
      },
    },
    { step: "complete" },
  ]);

  assert.ok(noLeaks);
  assert.equal(value.finalOutput, "the real answer");
  assert.equal(value.counters.reconciliationDifferences, 1);
  assert.equal(
    difference(value.diagnostics),
    "terminal snapshot changed finalOutput",
  );
});

test("a reconciliation announced through the intake that agrees is not counted", async () => {
  const { value, noLeaks } = await answered([
    emitText("the answer"),
    {
      step: "emit",
      observation: {
        kind: "reconciliation",
        reconciliation: { finalOutput: "the answer" },
      },
    },
    { step: "complete" },
  ]);

  assert.ok(noLeaks);
  assert.equal(value.counters.reconciliationDifferences, 0);
  assert.equal(difference(value.diagnostics), undefined);
});

test("a reconciliation the reducer ignored as late is not counted", async () => {
  const { value, noLeaks } = await answered([
    emitText("the answer"),
    // The ending closes the projection. Everything after it is late.
    { step: "announce-ending", ending: { ending: "answered" } },
    {
      step: "emit",
      observation: {
        kind: "reconciliation",
        reconciliation: { finalOutput: "too late to matter" },
      },
    },
    { step: "complete" },
  ]);

  assert.ok(noLeaks);
  assert.equal(value.finalOutput, "the answer");
  assert.ok(value.counters.lateObservations >= 1);
  assert.equal(value.counters.reconciliationDifferences, 0);
  assert.equal(difference(value.diagnostics), undefined);
});

test("a hundred identical answered Runs read zero on this counter", async () => {
  // The shape a stress run has: the same Run over and over, each with a
  // snapshot that restates what it streamed. The counter is exempt from the
  // stress policy's must-stay-zero list because a *genuine* disagreement is
  // not a defect — not because a busy Session is expected to raise it.
  const RUNS = 100;
  const script: readonly FakeStep[] = [
    emitText("the answer"),
    { step: "complete", reconciliation: { finalOutput: "the answer" } },
  ];
  const { value, noLeaks } = await withSession(
    { steps: Array.from({ length: RUNS }, () => script) },
    (rig) =>
      Effect.gen(function* () {
        const diagnostics: number[] = [];
        for (let index = 0; index < RUNS; index += 1) {
          const run = startedRun(yield* rig.supervisor.start(request()));
          yield* untilTerminal(rig, run.runId);
          const read = yield* rig.supervisor.result(run.runId);
          diagnostics.push(
            read.outcome === "result" ? read.result.diagnostics.length : -1,
          );
        }
        return { counters: rig.counters.counters(), diagnostics };
      }),
  );

  assert.ok(noLeaks);
  assert.equal(value.counters.reconciliationDifferences, 0);
  assert.deepEqual(
    value.diagnostics.filter((count) => count !== 0),
    [],
  );
});
