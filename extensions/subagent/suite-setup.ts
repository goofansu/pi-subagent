/**
 * Test-process setup, loaded once per test file via `--import` (see the `test`
 * and `test:conformance` scripts in package.json).
 *
 * It deliberately does nothing. Nothing in this tree reads ambient
 * environment, so there is nothing to set up — and the module exists anyway,
 * because it is the lane's single seam for process-wide test setup and the
 * first module that *does* depend on ambient state should find an obvious home
 * for it rather than reaching for a global in a test file.
 *
 * It earned its keep once already: v1's setup cleared `PI_SUBAGENT_DEPTH`,
 * because the v1 extension made itself inert at a non-zero depth and a test
 * process launched from inside a Subagent would otherwise have registered
 * nothing. Having a seam of our own is what kept the two lanes from sharing
 * that.
 *
 * Named `suite-setup` rather than `test-setup`: `test-*` is one of the globs
 * `node --test` collects, and under that name the runner would spawn this
 * module as a test file of its own.
 */

export {};
