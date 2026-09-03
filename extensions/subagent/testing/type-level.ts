/**
 * Compile-time assertion helpers for v2 tests.
 *
 * Several M1 rules are type-level facts rather than runtime behaviour: the
 * four identifiers are mutually unassignable, an observation kind carries
 * exactly a named set of keys, and `admitResume` has exactly three outcomes.
 * A helper that turns such a fact into a tuple type lets a test *construct*
 * the tuple, so the proof runs in `typecheck` and reads as an ordinary
 * assertion in the test body.
 */

/** True only when two types are mutually assignable, invariantly. */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Fails to compile unless its argument is exactly `true`. */
export type Expect<T extends true> = T;
