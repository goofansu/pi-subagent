import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunId, SubagentId } from "../../domain/index.ts";
import { createRuntimeCounters } from "../counters.ts";
import {
  committedBytes,
  evict,
  type StoredEntry,
  type StoreState,
} from "./result-store-state.ts";

test("eviction leaves the input state and its shared entries untouched", () => {
  const oldest: StoredEntry = {
    runId: "run-oldest" as RunId,
    subagentId: "subagent-owner" as SubagentId,
    status: "completed",
    encoded: "old output",
    bytes: 10,
    pins: new Set(),
  };
  const newest: StoredEntry = {
    ...oldest,
    runId: "run-newest" as RunId,
    encoded: "new output",
    pins: new Set(["delivery"]),
  };
  const entries = new Map([
    [oldest.runId, oldest],
    [newest.runId, newest],
  ]);
  const reservations = new Map([["run-reserved" as RunId, 5]]);
  const input: StoreState = { entries, reservations };
  // Independent value snapshot detects mutation of Maps, entries, or pin Sets.
  const before = structuredClone(input);
  const counters = createRuntimeCounters();

  const output = evict(input, 15, counters);

  assert.deepEqual(input, before);
  assert.strictEqual(input.entries, entries);
  assert.strictEqual(input.reservations, reservations);
  assert.strictEqual(entries.get(oldest.runId), oldest);
  assert.strictEqual(entries.get(newest.runId), newest);
  assert.equal(committedBytes(input), 25);

  // Prove eviction actually happened, rather than passing through unchanged.
  assert.notStrictEqual(output, input);
  assert.notStrictEqual(output.entries, entries);
  assert.deepEqual(output.entries.get(oldest.runId), {
    runId: oldest.runId,
    subagentId: oldest.subagentId,
    status: oldest.status,
    bytes: 0,
    pins: new Set(),
  });
  assert.strictEqual(output.entries.get(newest.runId), newest);
  assert.strictEqual(output.reservations, reservations);
  assert.equal(committedBytes(output), 15);
  assert.equal(counters.counters().evictions, 1);
});
