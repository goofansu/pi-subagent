import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listSourceFiles } from "../../tools/import-specifiers.ts";

/**
 * No real time passes in the v2 lane.
 *
 * Sleep-based timing is not proof of race correctness: a test that waits 50ms
 * and hopes passes on a fast machine and fails in CI, and the failure teaches
 * nothing. Everything in v2 waits on a `Deferred` the test completes, and
 * anything that genuinely involves the passage of time uses `TestClock`.
 *
 * This is a lint the lane runs on itself, because the rule is easy to break
 * accidentally — one `await new Promise((resolve) => setTimeout(resolve, 10))`
 * to "let things settle" is all it takes, and it will pass for months before
 * it starts failing intermittently.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const v2Root = path.join(repositoryRoot, "extensions", "subagent-v2");

/** Timer calls, which have no place in this lane at all. */
const FORBIDDEN_TIMERS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "node:timers",
] as const;

/** Sleeping is allowed only against a test clock. */
const SLEEP = "Effect.sleep";
const TEST_CLOCK = "TestClock";

function relative(file: string): string {
  return path.relative(repositoryRoot, file);
}

test("no v2 source calls a timer", () => {
  const offenders: string[] = [];

  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
    // This file names the forbidden calls in order to forbid them.
    if (file === fileURLToPath(import.meta.url)) continue;
    const source = readFileSync(file, "utf8");
    for (const timer of FORBIDDEN_TIMERS) {
      if (source.includes(timer)) offenders.push(`${relative(file)}: ${timer}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("a v2 source that sleeps does so against a test clock", () => {
  const offenders: string[] = [];

  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes(SLEEP)) continue;
    if (source.includes(TEST_CLOCK)) continue;
    offenders.push(`${relative(file)}: sleeps with no test clock`);
  }

  assert.deepEqual(offenders, []);
});
