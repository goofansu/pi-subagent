/**
 * Guards the hermeticity fixture itself: if `--import ./extensions/subagent/
 * suite-setup.ts` is ever dropped from the `test` script, or stops reaching the
 * per-file child processes the runner spawns, the suite would start passing or
 * failing according to the launching environment. That is exactly the kind of
 * breakage a test suite cannot report on its own, so assert it directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPTH_ENV_KEY } from "./backend.ts";

// Read at module load, before any `beforeEach` in any file can touch it.
const depthAtLoad = process.env[DEPTH_ENV_KEY];

test("test processes start with no inherited subagent depth", () => {
  assert.equal(
    depthAtLoad,
    undefined,
    `${DEPTH_ENV_KEY} leaked into the test process; is suite-setup.ts still imported by the 'test' script?`,
  );
});
