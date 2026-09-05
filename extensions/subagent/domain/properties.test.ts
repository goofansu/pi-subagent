import assert from "node:assert/strict";
import { test } from "node:test";
import { randomSequence } from "../testing/fixtures/observations.ts";
import { seeds } from "../testing/fixtures/seeded.ts";
import type { RunObservation } from "./observations.ts";
import {
  createRunProjection,
  DEFAULT_PROJECTION_BOUNDS,
  type ProjectionBounds,
  type RunProjection,
} from "./projection.ts";
import { reconcileRun } from "./reconcile-run.ts";
import type { TerminalReconciliation } from "./reconciliation.ts";
import { type AppliedReport, reduceRun } from "./reduce-run.ts";
import { contextGauge } from "./usage.ts";

/**
 * Property-style tests over generated observation sequences.
 *
 * These are the invariants that must hold for *every* sequence, not for the
 * particular ones a hand-written test thought of: determinism, absorption,
 * bounds, non-negative usage, and idempotent reconciliation. Each loop runs a
 * few hundred seeded sequences, and every failure message carries the seed
 * that produced it — so a red loop is a one-line reproduction rather than an
 * investigation.
 *
 * No dependency is added for this. The generator is thirty lines in
 * `testing/fixtures/seeded.ts`.
 */

/** Enough sequences to explore the shapes, few enough to stay instant. */
const RUNS = 400;

/** Deliberately tight, so almost every generated sequence hits a bound. */
const TIGHT_BOUNDS: ProjectionBounds = {
  maxTranscriptItems: 3,
  maxToolEntries: 3,
  maxDiagnostics: 2,
  maxLinks: 2,
  maxTextPartBytes: 6,
  maxFinalOutputBytes: 5,
};

function fold(
  observations: readonly RunObservation[],
  bounds: ProjectionBounds,
): { projection: RunProjection; reports: AppliedReport[] } {
  let projection = createRunProjection();
  const reports: AppliedReport[] = [];
  for (const observation of observations) {
    const step = reduceRun(projection, observation, bounds);
    projection = step.projection;
    reports.push(step.report);
  }
  return { projection, reports };
}

test("the reducer is deterministic for every generated sequence", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed);

    const first = fold(observations, DEFAULT_PROJECTION_BOUNDS);
    const second = fold(observations, DEFAULT_PROJECTION_BOUNDS);

    assert.deepEqual(second, first, `seed ${seed}`);
  }
});

test("a terminal projection absorbs every later observation, for every sequence", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed);
    const endingAt = observations.findIndex(
      (observation) => observation.kind === "ending",
    );
    if (endingAt === -1) continue;

    const { projection, reports } = fold(
      observations,
      DEFAULT_PROJECTION_BOUNDS,
    );
    const settled = fold(
      observations.slice(0, endingAt + 1),
      DEFAULT_PROJECTION_BOUNDS,
    ).projection;

    assert.equal(projection.terminal, true, `seed ${seed}`);
    // The projection after the whole sequence equals the projection at the
    // ending: nothing after it changed anything.
    assert.deepEqual(projection, settled, `seed ${seed}`);
    for (const report of reports.slice(endingAt + 1)) {
      assert.equal(report.report, "ignored-late", `seed ${seed}`);
    }
  }
});

test("every projection stays within its bounds, for every sequence", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed, 40);

    const { projection } = fold(observations, TIGHT_BOUNDS);

    const where = `seed ${seed}`;
    assert.ok(
      projection.transcript.length <= TIGHT_BOUNDS.maxTranscriptItems,
      where,
    );
    assert.ok(projection.tools.length <= TIGHT_BOUNDS.maxToolEntries, where);
    assert.ok(
      projection.diagnostics.length <= TIGHT_BOUNDS.maxDiagnostics,
      where,
    );
    assert.ok(projection.links.length <= TIGHT_BOUNDS.maxLinks, where);
    assert.ok(
      new TextEncoder().encode(projection.finalOutput).length <=
        TIGHT_BOUNDS.maxFinalOutputBytes,
      where,
    );
    for (const item of projection.transcript) {
      for (const part of item.parts) {
        if (part.kind !== "text") continue;
        assert.ok(
          new TextEncoder().encode(part.text).length <=
            TIGHT_BOUNDS.maxTextPartBytes,
          where,
        );
      }
    }
  }
});

test("a truncating fold always says so in its report, for every sequence", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed, 40);

    let projection = createRunProjection();
    for (const observation of observations) {
      const before = projection.truncation;
      const step = reduceRun(projection, observation, TIGHT_BOUNDS);
      projection = step.projection;
      const changed =
        JSON.stringify(before) !== JSON.stringify(projection.truncation);
      if (!changed) continue;
      assert.equal(
        step.report.report,
        "applied-with-truncation",
        `seed ${seed}: truncation was recorded without being reported`,
      );
    }
  }
});

test("usage totals and turns are never negative, for every sequence", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed, 40);

    const { projection } = fold(observations, DEFAULT_PROJECTION_BOUNDS);

    const where = `seed ${seed}`;
    for (const [field, value] of Object.entries(projection.usage.totals)) {
      assert.ok(Number.isFinite(value) && value >= 0, `${where}: ${field}`);
    }
    assert.ok(
      Number.isInteger(projection.usage.turns) && projection.usage.turns >= 0,
      where,
    );
    assert.ok(projection.usage.context.tokens >= 0, where);
  }
});

test("reconciliation is idempotent for every generated sequence", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed);
    const streamed = fold(
      observations.filter((observation) => observation.kind !== "ending"),
      TIGHT_BOUNDS,
    ).projection;
    const reconciliation = {
      transcript: [
        {
          role: "assistant" as const,
          parts: [{ kind: "text" as const, text: `healed ${seed}` }],
        },
      ],
      finalOutput: `healed ${seed}`,
      usage: { input: seed, output: seed * 2 },
      context: contextGauge(seed),
      turns: seed % 7,
      model: `model-${seed % 3}`,
    };

    const once = reconcileRun(streamed, reconciliation, TIGHT_BOUNDS);
    const twice = reconcileRun(once.projection, reconciliation, TIGHT_BOUNDS);

    assert.deepEqual(twice.projection, once.projection, `seed ${seed}`);
    // Replay is a no-op, so it disagreed with nothing.
    assert.deepEqual(twice.changed, [], `seed ${seed}`);
  }
});

test("a snapshot restating the streamed projection reports no change", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed);
    const streamed = fold(
      observations.filter((observation) => observation.kind !== "ending"),
      TIGHT_BOUNDS,
    ).projection;

    // Every field read straight back off the projection, so the snapshot
    // agrees with the stream in every particular. Bounding it a second time
    // must not be mistaken for a disagreement.
    const where = `seed ${seed}`;
    const outcome = reconcileRun(
      streamed,
      {
        transcript: streamed.transcript,
        finalOutput: streamed.finalOutput,
        usage: streamed.usage.totals,
        context: streamed.usage.context,
        turns: streamed.usage.turns,
        ...(streamed.model === undefined ? {} : { model: streamed.model }),
      },
      TIGHT_BOUNDS,
    );

    assert.deepEqual(outcome.changed, [], `seed ${seed}`);
    // And the fields it could have changed are the ones it started with. The
    // truncation record is excluded on purpose: a replacement *sets* it, so a
    // restating snapshot rewrites the count of what an earlier bound removed
    // without disagreeing about anything the Run said.
    assert.deepEqual(outcome.projection.transcript, streamed.transcript, where);
    assert.equal(outcome.projection.finalOutput, streamed.finalOutput, where);
    assert.deepEqual(outcome.projection.usage, streamed.usage, where);
    assert.equal(outcome.projection.model, streamed.model, where);
  }
});

test("every field a snapshot changes is the field it is reported under", () => {
  for (const seed of seeds(RUNS)) {
    const { observations } = randomSequence(seed);
    const streamed = fold(
      observations.filter((observation) => observation.kind !== "ending"),
      TIGHT_BOUNDS,
    ).projection;

    // One field at a time, each set to a value the stream cannot have held,
    // so the change set names exactly that one field and no other.
    const only: readonly (readonly [TerminalReconciliation, string])[] = [
      [
        {
          transcript: [
            {
              role: "assistant",
              parts: [{ kind: "text", text: `healed ${seed}` }],
            },
          ],
        },
        "transcript",
      ],
      [{ finalOutput: `answer ${seed}` }, "finalOutput"],
      [{ usage: { cost: streamed.usage.totals.cost + 1 } }, "usage"],
      [{ context: contextGauge(streamed.usage.context.tokens + 1) }, "context"],
      [{ turns: streamed.usage.turns + 1 }, "turns"],
      [{ model: `model-${seed}-other` }, "model"],
    ];

    for (const [reconciliation, field] of only) {
      const outcome = reconcileRun(streamed, reconciliation, TIGHT_BOUNDS);
      assert.deepEqual(outcome.changed, [field], `seed ${seed}: ${field}`);
    }
  }
});

test("a failing property loop names the seed that reproduces it", () => {
  // The loops above pass, so the only way to show the message is useful is to
  // provoke one deliberately.
  const seed = 12_345;
  assert.throws(
    () => {
      assert.deepEqual({ a: 1 }, { a: 2 }, `seed ${seed}`);
    },
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.match(String(error.message), /seed 12345/);
      return true;
    },
  );
  // And that the seed really does reproduce the sequence.
  assert.deepEqual(randomSequence(seed), randomSequence(seed));
});
