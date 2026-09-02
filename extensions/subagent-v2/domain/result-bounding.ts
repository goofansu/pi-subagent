/**
 * Making a result fit the space that was reserved for it.
 *
 * The projection bounds bound *items and texts*: how many transcript entries,
 * how long one text part may be. They do not bound the encoded whole, and they
 * cannot — an item may carry any number of parts, so their product is not a
 * number. What the Result store needs is a bound on the encoded whole, because
 * that is what it reserves and what it accounts for.
 *
 * So a candidate result is bounded twice. The reducer keeps the projection
 * inside the projection bounds as it goes, and this keeps the finished result
 * inside its reservation. The second pass is usually a no-op: it only does
 * anything for a Run that talked its way past a reservation the projection
 * bounds alone did not stop.
 *
 * The order things go in is fixed, and it is the order of least loss first:
 *
 * 1. the final output, cut to a prefix — a truncated answer is still an answer;
 * 2. tool output summaries, cut to a prefix;
 * 3. transcript items, oldest first — the recent ones are what a reader needs;
 * 4. tool entries, oldest first;
 * 5. links, then diagnostics, oldest first.
 *
 * Every step records what it removed in the {@link TruncationRecord}, so a
 * bounded result says it is bounded rather than quietly being lossy. The whole
 * pass is deterministic: the same result and the same bound always produce the
 * same output, which is what makes a retried settlement safe.
 */

import { Schema } from "effect";
import { RunResult } from "./result.ts";
import { boundText, byteLength } from "./text.ts";

const encodeResult = Schema.encodeUnknownSync(RunResult);

/**
 * How many bytes a result occupies once encoded.
 *
 * JSON is the measure because JSON is what the store holds. Measuring the
 * decoded object would count a shape the store never sees.
 */
export function encodedResultBytes(result: RunResult): number {
  return byteLength(JSON.stringify(encodeResult(result)));
}

export interface BoundedResult {
  readonly result: RunResult;
  /** What the result occupies now. Always at most the bound, when reachable. */
  readonly bytes: number;
  /** Whether this pass removed anything. */
  readonly bounded: boolean;
}

/** Drop the oldest entries of a list until the predicate says to stop. */
function dropOldest<T>(
  items: readonly T[],
  keep: number,
): { readonly items: readonly T[]; readonly dropped: number } {
  if (items.length <= keep) return { items, dropped: 0 };
  const dropped = items.length - keep;
  return { items: items.slice(dropped), dropped };
}

/**
 * Cut a result down until it fits, or until there is nothing left to cut.
 *
 * "Nothing left to cut" is a real outcome and not a failure: identity, status,
 * and timestamps are never removed, because a result that cannot say which Run
 * it belongs to is worse than one that is over its bound. A store that is
 * handed such a result accounts for its real size and says so.
 */
export function boundResultToBytes(
  result: RunResult,
  maxBytes: number,
): BoundedResult {
  let current = result;
  let bytes = encodedResultBytes(current);
  if (bytes <= maxBytes) return { result: current, bytes, bounded: false };

  const over = (): number => bytes - maxBytes;
  const remeasure = (next: RunResult): void => {
    current = next;
    bytes = encodedResultBytes(current);
  };

  // 1. The final output. A truncated answer is still an answer, so this is the
  //    first thing to give and the last thing to disappear entirely.
  if (current.finalOutput !== "") {
    const target = Math.max(0, byteLength(current.finalOutput) - over());
    const cut = boundText(current.finalOutput, target);
    if (cut.droppedBytes > 0) {
      remeasure({
        ...current,
        finalOutput: cut.text,
        truncation: {
          ...current.truncation,
          truncatedOutputBytes:
            current.truncation.truncatedOutputBytes + cut.droppedBytes,
        },
      });
      if (bytes <= maxBytes) return { result: current, bytes, bounded: true };
    }
  }

  // 2. Tool output summaries, which are the other place a backend can put an
  //    arbitrary amount of text.
  if (current.tools.some((entry) => entry.outputSummary !== undefined)) {
    let cutBytes = 0;
    const tools = current.tools.map((entry) => {
      if (entry.outputSummary === undefined) return entry;
      cutBytes += byteLength(entry.outputSummary);
      const { outputSummary: _dropped, ...rest } = entry;
      return rest;
    });
    remeasure({
      ...current,
      tools,
      truncation: {
        ...current.truncation,
        truncatedToolOutputBytes:
          current.truncation.truncatedToolOutputBytes + cutBytes,
      },
    });
    if (bytes <= maxBytes) return { result: current, bytes, bounded: true };
  }

  // 3. Transcript items, oldest first, halving what is kept each time so the
  //    pass finishes in a logarithmic number of encodes rather than one per
  //    item.
  while (bytes > maxBytes && current.transcript.length > 0) {
    const keep = Math.floor(current.transcript.length / 2);
    const kept = dropOldest(current.transcript, keep);
    remeasure({
      ...current,
      transcript: kept.items,
      truncation: {
        ...current.truncation,
        droppedTranscriptItems:
          current.truncation.droppedTranscriptItems + kept.dropped,
      },
    });
  }

  // 4. Tool entries, then 5. links and diagnostics. Each is small, so each
  //    goes all at once rather than by halves.
  if (bytes > maxBytes && current.tools.length > 0) {
    remeasure({
      ...current,
      tools: [],
      truncation: {
        ...current.truncation,
        droppedToolEntries:
          current.truncation.droppedToolEntries + current.tools.length,
      },
    });
  }
  if (bytes > maxBytes && current.links.length > 0) {
    remeasure({
      ...current,
      links: [],
      truncation: {
        ...current.truncation,
        droppedLinks: current.truncation.droppedLinks + current.links.length,
      },
    });
  }
  if (bytes > maxBytes && current.diagnostics.length > 0) {
    remeasure({
      ...current,
      diagnostics: [],
      truncation: {
        ...current.truncation,
        droppedDiagnostics:
          current.truncation.droppedDiagnostics + current.diagnostics.length,
      },
    });
  }

  return { result: Object.freeze(current), bytes, bounded: true };
}
