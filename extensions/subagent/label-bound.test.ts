import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The Run label's bound has one door, and this is what says so.
 *
 * The label has two bounds and each takes one of contributing invariant 11's
 * two branches: the upper bound — one line, 200 bytes — truncates and records
 * the shortening, and the lower bound — non-empty — refuses with the typed
 * outcome `empty label`. Both are applied in one place,
 * `application/subagents.ts`'s `labelledRequest`, at the last point before a
 * supervisor request exists.
 *
 * `host/tools.test.ts` proves the refusal happens and spends no identifier.
 * What it cannot prove is the *impossibility* — that no Run anywhere can carry
 * an empty label — because that rests on `labelledRequest` being the only way a
 * label reaches a Run. Today it is: `application/subagents.ts` is the only
 * production file that calls `supervisor.start` or `supervisor.resume`, and it
 * is the only production caller of `boundRunLabel`. Nothing fenced that. A
 * second caller would take the property away silently, and a property that can
 * be lost silently is a comment rather than an invariant — which is the
 * question the simplification rule asks of every change.
 *
 * So this reads the tree. It is a source scan rather than a boundary rule
 * because the boundary checker works on imports and the host legitimately
 * imports `SubagentSupervisor` for the `/subagent` status; what matters here
 * is who *calls* the two operations that make a Run.
 */

const treeRoot = path.dirname(fileURLToPath(import.meta.url));

/** Every production `.ts` file in the tree, tests and test doubles excluded. */
function productionFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const here = path.join(dir, entry.name);
    // `testing/` is the test tree: its doubles and its shared conformance
    // suite drive the supervisor on purpose, which is what a conformance
    // suite is for.
    if (entry.isDirectory()) {
      if (entry.name === "testing") continue;
      found.push(...productionFiles(here));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(here);
    }
  }
  return found;
}

function callersOf(pattern: RegExp): readonly string[] {
  return productionFiles(treeRoot)
    .filter((file) => pattern.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(treeRoot, file))
    .sort();
}

test("one place turns a caller's description into a Run's label, so an empty one cannot get past it", () => {
  // `supervisor.start` and `supervisor.resume` are the only two operations that
  // bring a Run into being, and one file calls them.
  assert.deepEqual(callersOf(/supervisor\.(start|resume)\(/), [
    "application/subagents.ts",
  ]);

  // And that file is where the bound is applied. If either list grows, the new
  // caller has to bound the label itself — or the label reaches a Run
  // unbounded at one end and empty at the other.
  assert.deepEqual(callersOf(/boundRunLabel\(/), [
    "application/subagents.ts",
    "domain/result.ts",
  ]);
});
