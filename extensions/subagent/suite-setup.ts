/**
 * Test-process setup, loaded once per test file via `--import` (see the `test`
 * script in package.json).
 *
 * The nesting guard reads `PI_SUBAGENT_DEPTH` from the ambient environment, and
 * the extension makes itself inert whenever that depth is above zero. Running
 * the suite from inside a subagent — which is how this package is often
 * developed — therefore silently changes what the code under test does: the
 * `session_start` handler is never registered, and every test that drives the
 * extension fails for a reason that has nothing to do with the change being
 * tested.
 *
 * Clearing the variable before any test module loads makes the suite depend on
 * its own fixtures instead of on who launched it. Tests that care about a
 * non-zero depth still set and restore it themselves.
 *
 * Named `suite-setup` rather than `test-setup` because `test-*` is one of the
 * globs `node --test` collects: under the old name the runner spawned this
 * module as a test file of its own, on top of importing it into every real one.
 */

import { DEPTH_ENV_KEY } from "./run.ts";

delete process.env[DEPTH_ENV_KEY];
