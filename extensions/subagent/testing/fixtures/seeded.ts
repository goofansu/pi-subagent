/**
 * A small seeded generator, so a property-style failure is reproducible.
 *
 * The point is not randomness quality. It is that a test can run several
 * hundred sequences, and that a failure prints a seed which reproduces exactly
 * the sequence that failed. No dependency is added for this: the milestone's
 * property loops need a reproducible stream of small numbers and nothing more.
 */

export interface Seeded {
  /** The seed this generator was built from, for a failure message. */
  readonly seed: number;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, bound). */
  int(bound: number): number;
  /** One of `items`, which must not be empty. */
  pick<T>(items: readonly T[]): T;
  /** True with the given probability. */
  chance(probability: number): boolean;
}

/** Mulberry32: 32 bits of state, uniform enough, and four lines long. */
export function seeded(seed: number): Seeded {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    seed,
    next,
    int: (bound) => Math.floor(next() * bound),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (probability) => next() < probability,
  };
}

/** A deterministic spread of seeds for one property loop. */
export function seeds(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_unused, index) => from + index);
}
