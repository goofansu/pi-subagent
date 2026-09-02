/**
 * Byte bounds for domain text.
 *
 * Every text a backend hands the core — a transcript part, a diagnostic
 * message, a link target, a fallback error message — is bounded, and the bound
 * is in bytes rather than characters because bytes are what a heap and a wire
 * actually cost. Cutting at a byte offset would be able to split a multi-byte
 * character in half, so the cut lands on a character boundary and the dropped
 * byte count is reported rather than guessed.
 */

/** UTF-8 length, the unit every text bound in v2 is expressed in. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface BoundedText {
  readonly text: string;
  /** Bytes removed. Zero means the text was already within the bound. */
  readonly droppedBytes: number;
}

/**
 * Keep the longest prefix of `text` that fits in `maxBytes`, cutting between
 * characters.
 *
 * Iterating code points rather than UTF-16 units means a surrogate pair is
 * kept or dropped as one character, so the result is always valid text.
 */
export function boundText(text: string, maxBytes: number): BoundedText {
  if (maxBytes < 0) {
    throw new RangeError(`a byte bound cannot be negative: ${maxBytes}`);
  }
  const encoder = new TextEncoder();
  const total = encoder.encode(text).length;
  if (total <= maxBytes) return { text, droppedBytes: 0 };

  let kept = "";
  let keptBytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (keptBytes + size > maxBytes) break;
    kept += character;
    keptBytes += size;
  }
  return { text: kept, droppedBytes: total - keptBytes };
}
