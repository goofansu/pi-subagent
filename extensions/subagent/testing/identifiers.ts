/**
 * Reading an allocated identifier back apart.
 *
 * Tests about identity allocation are about *rules* — numbered from one, per
 * kind, never repeated across Sessions — and the way to check a rule is to
 * take the identifier apart and assert its parts. Comparing against a literal
 * such as `run-1` asserts an observation instead, which is how the first
 * numbering defect survived five tests that all agreed the first Run of a
 * Session was `run-2`.
 *
 * This lives here, and not in a test file, so that the shape an allocated
 * identifier has is written down once outside the allocator rather than once
 * per suite that needs to read one.
 */

/** The three parts the Session allocator builds every identifier from. */
export interface AllocatedId {
  readonly kind: AllocatedIdKind;
  /** The nonce the minting Session runtime fixed for all of its identities. */
  readonly session: string;
  /** Where it falls in that Session's sequence for its kind, counted from one. */
  readonly sequence: number;
}

/** The two kinds of identity a Session hands out. */
export type AllocatedIdKind = "run" | "subagent";

/**
 * Deliberately looser than the allocator in the one place it can afford to be:
 * the nonce is matched as any run of alphanumerics rather than as the
 * allocator's own alphabet, because the alphabet is a detail and the *shape*
 * is the rule.
 */
const ALLOCATED_ID = /^(run|subagent)-([A-Za-z0-9]+)-([1-9][0-9]*)$/;

/** Take an allocated identifier apart, or fail naming the value that would not. */
export function parseAllocatedId(value: string): AllocatedId {
  const parsed = ALLOCATED_ID.exec(value);
  if (!parsed) {
    throw new Error(
      `not an identifier the Session allocator would mint: ${value}`,
    );
  }
  return {
    kind: parsed[1] as AllocatedIdKind,
    session: parsed[2],
    sequence: Number(parsed[3]),
  };
}

/**
 * Name another of a Session's identifiers, given one of them.
 *
 * For asserting something about an identifier a caller never received — the
 * pair a failed start allocated and abandoned, say, which is spent but was
 * never returned to anyone.
 */
export function idInSameSessionAs(
  known: string,
  kind: AllocatedIdKind,
  sequence: number,
): string {
  return `${kind}-${parseAllocatedId(known).session}-${sequence}`;
}
