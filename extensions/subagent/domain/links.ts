/**
 * Typed result links: a fixed kind set and a bounded target.
 *
 * A Run often has one genuinely useful pointer into provider territory — the
 * native session file, a log, a URL a backend produced. Surfacing it must not
 * become a hole through which a provider object crosses the boundary, so a
 * link is exactly a kind, a label, and a target string, each bounded by the
 * reducer after decoding, and nothing else.
 */

import { Schema } from "effect";
import {
  boundOneLine,
  boundText,
  RESULT_LINK_LABEL_MAX_BYTES,
  RESULT_LINK_TARGET_MAX_BYTES,
} from "./bounding.ts";

export {
  RESULT_LINK_LABEL_MAX_BYTES,
  RESULT_LINK_TARGET_MAX_BYTES,
} from "./bounding.ts";

export const RESULT_LINK_KINDS = [
  "native-session",
  "log",
  "url",
  "file",
] as const;

export const ResultLinkKind = Schema.Literals(RESULT_LINK_KINDS);

export type ResultLinkKind = typeof ResultLinkKind.Type;

export const ResultLink = Schema.Struct({
  kind: ResultLinkKind,
  /** One line, bounded by `RESULT_LINK_LABEL_MAX_BYTES` at reduction. */
  label: Schema.String,
  /** Bounded by `RESULT_LINK_TARGET_MAX_BYTES` at reduction. */
  target: Schema.String,
});

export type ResultLink = typeof ResultLink.Type;

export const isResultLinkKind: (value: unknown) => value is ResultLinkKind =
  Schema.is(ResultLinkKind);

export function resultLink(
  kind: ResultLinkKind,
  label: string,
  target: string,
): ResultLink {
  return ResultLink.make({
    kind,
    label: boundOneLine(label, RESULT_LINK_LABEL_MAX_BYTES),
    // A target is a path or a URL, so its whitespace is trimmed but its
    // interior is left alone: nothing in it is a line to collapse.
    target: boundText(target.trim(), RESULT_LINK_TARGET_MAX_BYTES).text,
  });
}
