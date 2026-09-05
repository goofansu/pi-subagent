import assert from "node:assert/strict";
import { test } from "node:test";
import { boundText, byteLength } from "./bounding.ts";
import {
  addUsageDelta,
  contextGauge,
  EMPTY_USAGE_SNAPSHOT,
  isUsableContextGauge,
  raiseTurns,
  replaceContextGauge,
  replaceUsageTotals,
  USAGE_DELTA_FIELDS,
  usageDelta,
} from "./usage.ts";

test("a delta keeps only the fields it was given, so equal deltas compare equal", () => {
  assert.deepEqual(usageDelta({ input: 3 }), { input: 3 });
  assert.deepEqual(usageDelta({ input: 3, output: undefined }), { input: 3 });
  assert.deepEqual(usageDelta({}), {});
});

test("a delta accepts every field the vocabulary lists", () => {
  const delta = usageDelta({
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cost: 0.25,
    turns: 1,
  });

  assert.deepEqual(Object.keys(delta).sort(), [...USAGE_DELTA_FIELDS].sort());
});

test("a counter that is negative, non-finite, or fractional is rejected", () => {
  for (const rejected of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () => usageDelta({ input: rejected }),
      /Expected/,
      String(rejected),
    );
  }
});

test("a turn count follows the counter rule, not the cost rule", () => {
  assert.throws(() => usageDelta({ turns: 0.5 }), /an integer/);
  assert.deepEqual(usageDelta({ turns: 2 }), { turns: 2 });
});

test("cost may be fractional but not negative or non-finite", () => {
  assert.deepEqual(usageDelta({ cost: 0.125 }), { cost: 0.125 });
  assert.throws(
    () => usageDelta({ cost: -0.01 }),
    /greater than or equal to 0/,
  );
  assert.throws(() => usageDelta({ cost: Number.NaN }), /Expected/);
});

test("a rejected delta names the field and the rule rather than coercing", () => {
  assert.throws(
    () => usageDelta({ output: -2 }),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /greater than or equal to 0/);
      assert.match(message, /\["output"\]/);
      // The rejected value never appears: a rejection says what was expected.
      assert.ok(!message.includes("-2"), message);
      return true;
    },
  );
});

test("an unlisted field is rejected rather than carried", () => {
  assert.throws(() => usageDelta({ nope: 1 } as never), /no excess property/);
});

test("a context gauge is tokens with an optional window", () => {
  assert.deepEqual(contextGauge(10), { tokens: 10 });
  assert.deepEqual(contextGauge(10, 200), { tokens: 10, window: 200 });
  assert.throws(() => contextGauge(-1), /greater than or equal to 0/);
});

test("the gauge predicate is what the reducer and reconciliation both use", () => {
  assert.equal(isUsableContextGauge({ tokens: 1 }), true);
  assert.equal(isUsableContextGauge({ tokens: 1, window: 2 }), true);
  assert.equal(isUsableContextGauge({ tokens: -1 }), false);
  assert.equal(isUsableContextGauge({ tokens: Number.NaN }), false);
  assert.equal(isUsableContextGauge({ tokens: 1, extra: 2 }), false);
  assert.equal(isUsableContextGauge({}), false);
  assert.equal(isUsableContextGauge(null), false);
  assert.equal(isUsableContextGauge("7"), false);
});

test("deltas are summed and the gauge is left alone", () => {
  const summed = [
    { input: 1, output: 2, turns: 1 },
    { input: 3, cacheRead: 4, cost: 0.5 },
    { output: 5, cacheWrite: 6, turns: 1, cost: 0.25 },
  ].reduce(addUsageDelta, EMPTY_USAGE_SNAPSHOT);

  assert.deepEqual(summed, {
    totals: { input: 4, output: 7, cacheRead: 4, cacheWrite: 6, cost: 0.75 },
    context: { tokens: 0 },
    turns: 2,
  });
});

test("the gauge is replaced by the latest value, never summed", () => {
  const first = replaceContextGauge(EMPTY_USAGE_SNAPSHOT, contextGauge(100));
  const second = replaceContextGauge(first, contextGauge(90, 200));

  assert.deepEqual(second.context, { tokens: 90, window: 200 });
  assert.deepEqual(second.totals, EMPTY_USAGE_SNAPSHOT.totals);
});

test("reconciled totals replace present fields and retain absent ones", () => {
  const streamed = addUsageDelta(EMPTY_USAGE_SNAPSHOT, {
    input: 10,
    output: 20,
    cost: 1,
  });

  const healed = replaceUsageTotals(streamed, { input: 12, cacheRead: 3 });

  assert.deepEqual(healed.totals, {
    input: 12,
    output: 20,
    cacheRead: 3,
    cacheWrite: 0,
    cost: 1,
  });
});

test("replacing totals twice is the same as replacing them once", () => {
  const streamed = addUsageDelta(EMPTY_USAGE_SNAPSHOT, { input: 10 });
  const patch = { input: 12, output: 4 };

  assert.deepEqual(
    replaceUsageTotals(replaceUsageTotals(streamed, patch), patch),
    replaceUsageTotals(streamed, patch),
  );
});

test("a terminal turn count raises the observed count but never lowers it", () => {
  const observed = addUsageDelta(EMPTY_USAGE_SNAPSHOT, { turns: 3 });

  assert.equal(raiseTurns(observed, 5).turns, 5);
  assert.equal(raiseTurns(observed, 3).turns, 3);
  assert.equal(raiseTurns(observed, 1).turns, 3);
});

test("an unusable terminal turn count is ignored, leaving observed progress", () => {
  const observed = addUsageDelta(EMPTY_USAGE_SNAPSHOT, { turns: 3 });

  for (const ignored of [undefined, null, -1, 1.5, Number.NaN, "4"]) {
    assert.equal(raiseTurns(observed, ignored).turns, 3, String(ignored));
  }
});

test("a text bound is measured in bytes and cut between characters", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2);
  assert.equal(byteLength("😀"), 4);

  assert.deepEqual(boundText("abc", 10), { text: "abc", droppedBytes: 0 });
  assert.deepEqual(boundText("abcdef", 3), { text: "abc", droppedBytes: 3 });
  // Cutting at byte 3 of "ééé" would split a character; the cut moves back.
  assert.deepEqual(boundText("ééé", 3), { text: "é", droppedBytes: 4 });
  assert.deepEqual(boundText("😀😀", 5), { text: "😀", droppedBytes: 4 });
  assert.deepEqual(boundText("😀", 0), { text: "", droppedBytes: 4 });
});

test("a negative text bound is a programming error, not a silent empty string", () => {
  assert.throws(() => boundText("abc", -1), RangeError);
});
