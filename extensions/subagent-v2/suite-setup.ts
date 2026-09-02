/**
 * Test-process setup for the v2 suite, loaded once per test file via
 * `--import` (see the `test:v2` script in package.json).
 *
 * v2 has its own setup module so the v2 lane can never load v1's. v1's setup
 * clears `PI_SUBAGENT_DEPTH` because the v1 extension makes itself inert at a
 * non-zero depth; v2 reads no ambient environment, so this module deliberately
 * does nothing yet. It exists as the v2 lane's single seam for process-wide
 * test setup, so the first v2 module that does depend on ambient state has an
 * obvious home that is not shared with the frozen tree.
 *
 * Named `suite-setup` rather than `test-setup` for the same reason v1 is:
 * `test-*` is one of the globs `node --test` collects, and under that name the
 * runner would spawn this module as a test file of its own.
 */

export {};
