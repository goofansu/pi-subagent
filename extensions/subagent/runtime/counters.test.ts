import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COUNTER_CLASSES,
  type CounterClass,
  createRuntimeCounters,
  type SupervisorCounter,
} from "./counters.ts";

/**
 * The taxonomy, checked against the counters themselves.
 *
 * `COUNTER_CLASSES` is `Record<SupervisorCounter, CounterClass>`, so a counter
 * added without a class already fails to compile. What a type cannot check is
 * the other direction — that the record has no key the counters do not have —
 * and that the zero block a Session actually reports is the same set. Both are
 * asserted here, because the health line reads the record and the diagnostics
 * report reads the block, and a name in one and not the other would be a
 * counter that reads as `unclassified` forever.
 */

test("every counter a Session reports has a class, and the record invents none", () => {
  const reported = Object.keys(createRuntimeCounters().counters()).sort();
  const classified = Object.keys(COUNTER_CLASSES).sort();

  assert.deepEqual(classified, reported);
});

test("there are exactly three counter classes", () => {
  // Asserted by exhaustion rather than by spot check: a fourth class is a
  // fourth thing an operator reads in the health line, and it has to be named
  // and explained here before anything can report it.
  const classes = new Set<CounterClass>(Object.values(COUNTER_CLASSES));

  assert.deepEqual([...classes].sort(), ["defect", "expected", "incident"]);
});

test("the counters two endings racing produce are expected, not defects", () => {
  // The move this taxonomy makes against the guide's earlier tables, and the
  // reason the health line stopped summing: a cancelled Run normally produces
  // both of these, and a Session that reported `attention needed` for them
  // would say something is wrong every time anybody cancels anything.
  const expected: readonly SupervisorCounter[] = [
    "duplicateSettlements",
    "lateEndings",
  ];

  for (const counter of expected) {
    assert.equal(COUNTER_CLASSES[counter], "expected", counter);
  }
});

test("a result committed twice or differently is a defect of the runtime itself", () => {
  for (const counter of [
    "duplicateCommits",
    "conflictingCommits",
    "unreadableResults",
    "seamDecodeFailures",
    "queueOverflows",
    "settlementDefects",
  ] as const) {
    assert.equal(COUNTER_CLASSES[counter], "defect", counter);
  }
});

test("what went wrong outside the runtime is an incident it coped with", () => {
  assert.equal(COUNTER_CLASSES.cleanupEscalations, "incident");
  assert.equal(COUNTER_CLASSES.deliveryFailures, "incident");
});
