import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listSourceFiles } from "../../tools/import-specifiers.ts";

/**
 * No real time passes in this lane.
 *
 * Sleep-based timing is not proof of race correctness: a test that waits 50ms
 * and hopes passes on a fast machine and fails in CI, and the failure teaches
 * nothing. Everything here waits on a `Deferred` the test completes, and
 * anything that genuinely involves the passage of time uses `TestClock`.
 *
 * This is a lint the lane runs on itself, because the rule is easy to break
 * accidentally — one `await new Promise((resolve) => setTimeout(resolve, 10))`
 * to "let things settle" is all it takes, and it will pass for months before
 * it starts failing intermittently.
 *
 * The sleep rule applies to **tests**, which is where it is about proof. A
 * production module that sleeps — the delivery retry budget is the one that
 * does — sleeps against the runtime `Clock`, which is exactly the thing a
 * test replaces with `TestClock`. Forbidding that would push the delay
 * somewhere the test clock could not reach it, which is the opposite of what
 * this file is for. Timers stay forbidden everywhere, because a timer is the
 * one thing no clock can replace.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const treeRoot = path.join(repositoryRoot, "extensions", "subagent");

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

test("no source calls a timer", () => {
  const offenders: string[] = [];

  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    // This file names the forbidden calls in order to forbid them.
    if (file === fileURLToPath(import.meta.url)) continue;
    const source = readFileSync(file, "utf8");
    for (const timer of FORBIDDEN_TIMERS) {
      if (source.includes(timer)) offenders.push(`${relative(file)}: ${timer}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("a test that sleeps does so against a test clock", () => {
  const offenders: string[] = [];

  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    if (file === fileURLToPath(import.meta.url)) continue;
    // A production module sleeps against the runtime clock, which a test
    // replaces. Only a test that lets real time pass is the problem.
    if (!file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes(SLEEP)) continue;
    if (source.includes(TEST_CLOCK)) continue;
    offenders.push(`${relative(file)}: sleeps with no test clock`);
  }

  assert.deepEqual(offenders, []);
});
